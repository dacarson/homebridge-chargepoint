"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChargePointAccessory = void 0;
const eveCharacteristics_1 = require("./eveCharacteristics");
const tokenStore_1 = require("./tokenStore");
const matterEnergy_1 = require("./matterEnergy");
const fakegato = require("fakegato-history");
class ChargePointAccessory {
    api;
    log;
    platformAccessory;
    client;
    requestRapidRefresh;
    chargerId;
    outletService;
    // Cached characteristic references — avoids UUID lookup failures on cached accessories
    charOn;
    charOutletInUse;
    charCurrentConsumption;
    charTotalConsumption;
    charVoltage;
    charElectricCurrent;
    status = null;
    session = null;
    lastSession = null;
    // Lifetime kWh accumulator persisted across restarts
    persistedBaseKwh = 0;
    lifetimeKwh = 0;
    historyService;
    _lastBackfilledSessionId;
    _lastIdleHistoryTime = 0;
    _lastStoredHistoryPower = 0;
    static IDLE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
    // Optional: publishes the charger over Matter for the Apple Home Energy view.
    // Null when the "matter" config option is off; a no-op bridge when it's on
    // but the Homebridge build doesn't support it. See matterEnergy.ts.
    matter = null;
    // Guards against overlapping start/stop commands from rapid HomeKit toggles.
    commandInFlight = false;
    // Optimistic On state held after a toggle. The charger status endpoint lags
    // the start/stop ack by several polls, so without this the switch bounces
    // back until ChargePoint catches up. Cleared once status agrees, the command
    // fails, or the grace window expires (which reverts to the reported state).
    pendingOn = null;
    static PENDING_GRACE_MS = 60_000;
    constructor(api, log, platformAccessory, client, matterEnabled = false, requestRapidRefresh) {
        this.api = api;
        this.log = log;
        this.platformAccessory = platformAccessory;
        this.client = client;
        this.requestRapidRefresh = requestRapidRefresh;
        const context = platformAccessory.context;
        this.chargerId = context.chargerId;
        this._lastBackfilledSessionId = context.lastBackfilledSessionId ?? null;
        const eve = (0, eveCharacteristics_1.buildEveCharacteristics)(api.hap);
        // Outlet service (Eve Energy)
        this.outletService =
            platformAccessory.getService(api.hap.Service.Outlet) ??
                platformAccessory.addService(api.hap.Service.Outlet);
        // Cache characteristic references.
        // getCharacteristic is reliable for standard HAP chars; for custom Eve chars we use
        // _getOrAdd because getCharacteristic(uuid) is broken for restored cached accessories
        // in some homebridge versions (returns undefined even when the char exists), and
        // addCharacteristic throws if the UUID is already present.
        this.charOn = this.outletService.getCharacteristic(api.hap.Characteristic.On);
        this.charOn.onSet(value => this._setOn(value));
        this.charOutletInUse = this.outletService.getCharacteristic(api.hap.Characteristic.OutletInUse);
        this.charCurrentConsumption = this._getOrAdd(eve.CurrentConsumption());
        this.charTotalConsumption = this._getOrAdd(eve.TotalConsumption());
        this.charVoltage = this._getOrAdd(eve.Voltage());
        this.charElectricCurrent = this._getOrAdd(eve.ElectricCurrent());
        const FakeGatoHistoryService = fakegato(api);
        this.historyService = new FakeGatoHistoryService('energy', platformAccessory, {
            size: 4032,
            storage: 'fs',
            disableTimer: true,
        });
        if (matterEnabled) {
            const bridge = new matterEnergy_1.MatterEnergyBridge(api, log);
            if (bridge.isSupported()) {
                this.matter = bridge;
                // Registration is async; failures are logged inside register().
                bridge.register(this.chargerId, context.displayName, this._readings(0, 0)).catch(() => { });
            }
            else {
                this.log.info('[matter] Config option "matter" is enabled, but the Matter API is unavailable. It needs Homebridge 2.3.0 or later with Matter enabled on this plugin\'s child bridge. Continuing with HomeKit/Eve only.');
            }
        }
    }
    // Normalized electrical readings, in human units. Single source of truth
    // consumed by both the Eve characteristic update path and the Matter
    // export, so the two stay in sync.
    _readings(powerW, currentA) {
        return {
            voltageV: 240.0,
            currentA,
            powerW,
            energyWh: this.lifetimeKwh * 1000,
        };
    }
    // Finds an existing characteristic by UUID in the raw array (bypassing the broken
    // getCharacteristic(uuid) path for restored cached accessories), or adds it if absent.
    _getOrAdd(instance) {
        const existing = this.outletService.characteristics.find(c => c.UUID === instance.UUID);
        return existing ?? this.outletService.addCharacteristic(instance);
    }
    async initTechInfo(techInfo) {
        const infoService = this.platformAccessory.getService(this.api.hap.Service.AccessoryInformation);
        infoService
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'ChargePoint')
            .setCharacteristic(this.api.hap.Characteristic.Model, techInfo.model_number)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, techInfo.serial_number)
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, techInfo.software_version);
        this.persistedBaseKwh = await (0, tokenStore_1.loadLifetimeKwh)(this.chargerId);
        this.lifetimeKwh = this.persistedBaseKwh;
    }
    // session is the active ChargingSession for this charger, or null if not charging.
    // Errors from getHomeChargerStatus propagate to _pollCycle for auth-error handling.
    async refresh(session) {
        this.status = await this.client.getHomeChargerStatus(this.chargerId);
        if (!this.status.is_connected) {
            this.markNoResponse();
            return;
        }
        this.session = session;
        // TotalConsumption accumulation using session.energy_kwh
        if (session !== null) {
            // Session active: live value = persisted base + current session's delivered energy
            this.lifetimeKwh = this.persistedBaseKwh + session.energy_kwh;
        }
        else if (this.lastSession !== null) {
            // Session just ended: commit last session's energy to the persisted base
            this.persistedBaseKwh += this.lastSession.energy_kwh;
            await (0, tokenStore_1.saveLifetimeKwh)(this.chargerId, this.persistedBaseKwh);
            this.lifetimeKwh = this.persistedBaseKwh;
        }
        this.lastSession = session;
        this._updateCharacteristics();
        this._updateHistory(session);
    }
    _updateCharacteristics() {
        const isCharging = this.status?.charging_status === 'CHARGING';
        let powerKw = 0;
        let powerSource = 'none';
        if (isCharging) {
            if (this.session !== null && this.session.power_kw > 0) {
                // Prefer actual session measurement; fall back to last update_data point (matches Python "in_use" logic)
                const lastPoint = this.session.update_data.at(-1);
                powerKw = (lastPoint && lastPoint.power_kw > 0) ? lastPoint.power_kw : this.session.power_kw;
                powerSource = 'session';
            }
            else if ((this.status?.amperage_limit ?? 0) > 0) {
                // No cloud session available (scheduled/home-flex charging) — estimate from amperage limit.
                // This matches the Python script's "waiting" state fallback: amperage_limit * 240V / 1000.
                powerKw = (this.status.amperage_limit * 240) / 1000;
                powerSource = 'amperage-estimate';
            }
        }
        const powerW = (0, eveCharacteristics_1.safeW)(powerKw);
        const currentA = isCharging ? (this.status?.amperage_limit ?? 0) : 0;
        this.log.debug(`[${this.chargerId}] isCharging=${isCharging} powerSource=${powerSource} powerKw=${powerKw} powerW=${powerW} currentA=${currentA} lifetimeKwh=${this.lifetimeKwh}`);
        this.charOn.updateValue(this._resolveOn(isCharging));
        this.charOutletInUse.updateValue(this.status?.is_plugged_in ?? false);
        this.charCurrentConsumption.updateValue(powerW);
        this.charTotalConsumption.updateValue(this.lifetimeKwh);
        this.charVoltage.updateValue(240.0);
        this.charElectricCurrent.updateValue(currentA);
        // Push the same readings to the Matter export (no-op unless registered)
        if (this.matter)
            this.matter.update(this._readings(powerW, currentA)).catch(() => { });
    }
    _updateHistory(session) {
        // Backfill historical data points when a new session is first seen
        if (session !== null && session.session_id !== this._lastBackfilledSessionId) {
            for (const point of session.update_data) {
                this.historyService.addEntry({
                    time: Math.round(point.timestamp / 1000),
                    power: (0, eveCharacteristics_1.safeW)(point.power_kw),
                });
            }
            this._lastBackfilledSessionId = session.session_id;
            this.platformAccessory.context.lastBackfilledSessionId = session.session_id;
        }
        // Add current reading — charging entries stored every poll; idle (0W) entries throttled to
        // 10-minute intervals to avoid flooding the history buffer with redundant zeros.
        const isCharging = this.status?.charging_status === 'CHARGING';
        const powerKw = isCharging ? (session?.power_kw ?? 0) : 0;
        const powerW = (0, eveCharacteristics_1.safeW)(powerKw);
        const now = Date.now();
        const chargingJustEnded = this._lastStoredHistoryPower > 0 && powerW === 0;
        if (powerW > 0 || chargingJustEnded || (now - this._lastIdleHistoryTime >= ChargePointAccessory.IDLE_HISTORY_INTERVAL_MS)) {
            this.historyService.addEntry({
                time: Math.round(now / 1000),
                power: powerW,
            });
            if (powerW === 0)
                this._lastIdleHistoryTime = now;
            this._lastStoredHistoryPower = powerW;
        }
    }
    markNoResponse() {
        this.charOn.updateValue(new Error('No Response'));
    }
    // HAP set-handler for the Outlet's On characteristic. Returns immediately
    // (optimistic) so HomeKit doesn't time out waiting on ChargePoint's
    // ack-polling loop (up to 60s); the command runs in the background and the
    // next poll (accelerated via requestRapidRefresh) reflects the real state.
    _setOn(turnOn) {
        if (this.commandInFlight) {
            this.log.warn(`[${this.chargerId}] Command already in flight; ignoring new request.`);
            this._revertOn();
            return;
        }
        if (turnOn) {
            this.commandInFlight = true;
            this.pendingOn = { value: true, until: Date.now() + ChargePointAccessory.PENDING_GRACE_MS };
            const maxAmps = this._maxAmperageLimit();
            (async () => {
                if (maxAmps !== null) {
                    await this.client.setAmperageLimit(this.chargerId, maxAmps);
                }
                this.session = await this.client.startChargingSession(this.chargerId);
            })()
                .catch(err => {
                this.log.error(`[${this.chargerId}] Start failed:`, err);
                this._revertOn();
            })
                .finally(() => {
                this.commandInFlight = false;
                this.requestRapidRefresh?.();
            });
        }
        else {
            if (!this.session) {
                this.log.warn(`[${this.chargerId}] Stop requested but no active session known; skipping.`);
                this._revertOn();
                return;
            }
            const { device_id, outlet_number, session_id } = this.session;
            this.commandInFlight = true;
            this.pendingOn = { value: false, until: Date.now() + ChargePointAccessory.PENDING_GRACE_MS };
            this.client.stopChargingSession(device_id, outlet_number, session_id)
                .catch(err => {
                this.log.error(`[${this.chargerId}] Stop failed:`, err);
                this._revertOn();
            })
                .finally(() => {
                this.commandInFlight = false;
                this.requestRapidRefresh?.();
            });
        }
    }
    // True while an optimistic state is being held; the platform keeps polling
    // at the rapid cadence until this clears.
    hasPendingState() {
        return this.pendingOn !== null;
    }
    // Returns the On value to report given the charger's observed state, holding
    // the pending value until status agrees or the grace window runs out.
    _resolveOn(observed) {
        if (!this.pendingOn)
            return observed;
        if (observed === this.pendingOn.value) {
            this.pendingOn = null;
            return observed;
        }
        if (Date.now() >= this.pendingOn.until) {
            this.log.warn(`[${this.chargerId}] Charger did not ${this.pendingOn.value ? 'start' : 'stop'} within ` +
                `${ChargePointAccessory.PENDING_GRACE_MS / 1000}s; reverting switch.`);
            this.pendingOn = null;
            return observed;
        }
        return this.pendingOn.value;
    }
    // Drops any pending state and pushes the last observed state back to HomeKit.
    _revertOn() {
        this.pendingOn = null;
        const isCharging = this.status?.charging_status === 'CHARGING';
        // Defer so the revert lands after HAP finishes processing the current set.
        setImmediate(() => this.charOn.updateValue(isCharging));
    }
    _maxAmperageLimit() {
        const limits = this.status?.possible_amperage_limits ?? [];
        return limits.length > 0 ? Math.max(...limits) : null;
    }
}
exports.ChargePointAccessory = ChargePointAccessory;
