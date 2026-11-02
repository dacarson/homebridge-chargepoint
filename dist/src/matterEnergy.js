"use strict";
/**
 * matterEnergy.ts
 *
 * Publishes the ChargePoint charger to Matter controllers as a standalone
 * electrical sensor, so it appears in the Apple Home Energy view (iOS/tvOS
 * 26+) with live watts — without also showing up as a second, controllable
 * accessory tile alongside the real HAP outlet.
 *
 * Background
 * ----------
 * Apple Home's Energy view is driven by Matter electrical-measurement
 * clusters, not by classic HomeKit/HAP characteristics. HAP has no native
 * power/energy characteristic, so the Eve custom characteristics this plugin
 * also exposes (see eveCharacteristics.ts) are only ever read by Eve-class
 * apps and never populate the native Energy tile.
 *
 * Homebridge 2.2.0 added the ElectricalPowerMeasurement / ElectricalEnergyMeasurement
 * clusters to its Matter plugin API, and 2.3.0 fixed composition/bridge-online
 * behavior needed to use them reliably. This module talks to that API directly:
 *
 *   240V (fixed)        -> electricalPowerMeasurement.voltage        (mV)
 *   amperage_limit       -> electricalPowerMeasurement.activeCurrent  (mA)
 *   powerKw               -> electricalPowerMeasurement.activePower   (mW)
 *   lifetimeKwh          -> electricalEnergyMeasurement
 *                             .cumulativeEnergyImported.energy        (mWh)
 *
 * Matter expresses all of these in milli-units, hence the x1000 conversions.
 *
 * Homebridge derives the mandatory cluster attributes (powerMode, accuracy,
 * numberOfMeasurementTypes) and the feature-gated ElectricalEnergyMeasurement
 * features from the declared state — declaring `cumulativeEnergyImported`
 * selects the ImportedEnergy + CumulativeEnergy features. `ElectricalSensor`
 * (`deviceTypes.ElectricalSensor`) is Homebridge's device type specifically
 * for a standalone power/energy meter (its own comment: "e.g. a solar or
 * whole-home meter") — unlike `OnOffOutlet`, it carries no onOff cluster, so
 * it doesn't present as a second controllable accessory the way the outlet
 * shape did. No separate EnergyEvse device type is needed (and Homebridge
 * does not currently expose one — see homebridge/homebridge#3942).
 *
 * Also declares `periodicEnergyImported` — the energy consumed over a
 * reporting period, with a start/end timestamp — alongside the cumulative
 * total. Per homebridge-shelly-matter (a more mature Matter energy-metering
 * plugin): Apple Home's per-device energy *attribution* is driven by the
 * PeriodicEnergy feature, not just CumulativeEnergy, and Matter composes a
 * cluster's features once at registration — so periodicEnergyImported must
 * be present (even as a zero placeholder) in the very first registered
 * snapshot, or the feature never gets added at all.
 *
 * Event rate
 * ----------
 * Homebridge routes every energy reading present in an update through
 * matter.js setMeasurement(), which records a CumulativeEnergyMeasured /
 * PeriodicEnergyMeasured event for it; a reading left out of the update keeps
 * its previous attribute value and records nothing. Sending both on every
 * 15 s poll flooded controllers with events that almost never carried new
 * information, so after the first update:
 *
 *   - cumulativeEnergyImported is sent only when the total has changed, or as
 *     a heartbeat once ENERGY_REPORT_INTERVAL_S has passed since the last one;
 *   - periodicEnergyImported accumulates across polls and is sent once per
 *     ENERGY_REPORT_INTERVAL_S period — or early, as soon as energy starts
 *     flowing after the charger goes from idle to active, so a charging
 *     session shows up promptly.
 *
 * Requirements
 * ------------
 * - Homebridge 2.3.0 or later
 * - Matter enabled on this plugin's child bridge (Homebridge UI ->
 *   plugin settings -> Bridge Settings -> enable Matter)
 *
 * Everything here is feature-detected and guarded: on a Homebridge build
 * without the Matter API, or with Matter disabled, isSupported() returns
 * false and the plugin runs HAP/Eve-only exactly as before.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatterEnergyBridge = exports.ENERGY_REPORT_INTERVAL_S = void 0;
const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';
/**
 * Length of a PeriodicEnergyMeasured period, and the CumulativeEnergyMeasured
 * heartbeat interval when the total hasn't changed. Shared so that while idle
 * both events land together on the same poll rather than on two clocks.
 */
exports.ENERGY_REPORT_INTERVAL_S = 15 * 60;
/** Matter uses milli-units for electrical measurements. */
function milli(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
class MatterEnergyBridge {
    log;
    api;
    uuid = null;
    registered = false;
    warnedUpdate = false;
    // Tracks the open periodic-energy window: the wall-clock start and the
    // cumulative energyWh reading at that start. Each emitted period covers
    // [start, now] and the next one opens where it ended, so periods are
    // contiguous and non-overlapping.
    _periodStartS = null;
    _periodStartEnergyWh = 0;
    // Last cumulative total sent (mWh) and when, for change/heartbeat detection.
    _lastCumulativeMilli = null;
    _lastCumulativeS = 0;
    // The first update() after registration always reports both readings.
    _firstUpdateSent = false;
    // Whether the previous poll saw the charger drawing power.
    _wasActive = false;
    // Set on an idle -> active transition; emits the open period early once it
    // has non-zero energy, then clears.
    _activationPending = false;
    constructor(api, log) {
        this.log = log;
        this.api = api;
    }
    /**
     * Whether this Homebridge build exposes everything needed to publish a
     * standalone electrical sensor. Logs at debug level so unsupported builds
     * stay quiet.
     */
    isSupported() {
        const matter = this.api.matter;
        if (!matter) {
            this.log.debug('[matter] api.matter unavailable — Matter energy export disabled. Requires Homebridge 2.3.0+ with Matter enabled on this plugin\'s child bridge.');
            return false;
        }
        if (!matter.deviceTypes?.ElectricalSensor) {
            this.log.debug('[matter] api.matter.deviceTypes.ElectricalSensor unavailable — Matter energy export disabled.');
            return false;
        }
        if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
            this.log.debug('[matter] Matter registration/update API unavailable — Matter energy export disabled.');
            return false;
        }
        return true;
    }
    buildClusters(r) {
        return {
            electricalPowerMeasurement: {
                voltage: milli(r.voltageV),
                activeCurrent: milli(r.currentA),
                activePower: milli(r.powerW),
            },
            electricalEnergyMeasurement: {
                // A wall charger only ever imports energy from the grid.
                cumulativeEnergyImported: { energy: milli(r.energyWh) },
                // Zero placeholder — real windows come from _nextPeriodicEnergy().
                // Declaring the attribute here (even at zero) is what makes Matter
                // compose the PeriodicEnergy feature at registration.
                periodicEnergyImported: { energy: 0 },
            },
        };
    }
    /** Opens a periodic-energy window starting now at the given cumulative reading. */
    _openPeriod(nowS, energyWh) {
        this._periodStartS = nowS;
        this._periodStartEnergyWh = energyWh;
    }
    /**
     * Decides which energy readings are due on this poll. Returns the state to
     * send (empty when nothing is due) and a commit callback that advances the
     * tracking state — called only once the update has been accepted, so a
     * failed update leaves the window open and the next poll covers it.
     */
    _dueEnergyState(readings) {
        const nowS = Math.floor(Date.now() / 1000);
        const cumulativeMilli = milli(readings.energyWh);
        const state = {};
        const active = readings.powerW > 0;
        if (active && !this._wasActive)
            this._activationPending = true;
        this._wasActive = active;
        const cumulativeDue = !this._firstUpdateSent
            || cumulativeMilli !== this._lastCumulativeMilli
            || nowS - this._lastCumulativeS >= exports.ENERGY_REPORT_INTERVAL_S;
        if (cumulativeDue)
            state.cumulativeEnergyImported = { energy: cumulativeMilli };
        if (this._periodStartS === null)
            this._openPeriod(nowS, readings.energyWh);
        const startS = this._periodStartS;
        const deltaWh = Math.max(0, readings.energyWh - this._periodStartEnergyWh);
        const periodicDue = !this._firstUpdateSent
            || nowS - startS >= exports.ENERGY_REPORT_INTERVAL_S
            || (this._activationPending && deltaWh > 0);
        if (periodicDue) {
            state.periodicEnergyImported = { energy: milli(deltaWh), startTimestamp: startS, endTimestamp: nowS };
        }
        const commit = () => {
            this._firstUpdateSent = true;
            if (cumulativeDue) {
                this._lastCumulativeMilli = cumulativeMilli;
                this._lastCumulativeS = nowS;
            }
            if (periodicDue) {
                this._openPeriod(nowS, readings.energyWh);
                this._activationPending = false;
            }
        };
        return { state, commit };
    }
    /**
     * Register the charger as a standalone Matter electrical sensor.
     *
     * @param chargerId - used to seed a UUID distinct from the HAP accessory's
     * @param displayName
     * @param readings - initial readings to seed the clusters with
     */
    async register(chargerId, displayName, readings) {
        if (!this.isSupported())
            return false;
        const matter = this.api.matter;
        this.uuid = matter.uuid.generate(`${PLUGIN_NAME}:matter:${chargerId}`);
        const accessory = {
            UUID: this.uuid,
            displayName,
            deviceType: matter.deviceTypes.ElectricalSensor,
            serialNumber: String(chargerId),
            manufacturer: 'ChargePoint',
            model: 'Home Flex',
            clusters: this.buildClusters(readings),
        };
        // Opens the first periodic-energy window so the first update() call has
        // a start point to measure from (buildClusters() already seeded the
        // registered snapshot's periodicEnergyImported with a zero value).
        this._openPeriod(Math.floor(Date.now() / 1000), readings.energyWh);
        try {
            await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.registered = true;
            this.log.info('[matter] Published charger as a Matter electrical sensor — live power should appear in the Apple Home Energy view.');
            return true;
        }
        catch (err) {
            this.log.warn(`[matter] Failed to register Matter accessory (${err instanceof Error ? err.message : err}). Continuing with HomeKit/Eve only.`);
            this.registered = false;
            return false;
        }
    }
    // Homebridge can take a while (well past 14s on slower hosts, e.g. a
    // Raspberry Pi, or during a busy child-bridge restart) to finish
    // initializing a just-registered Matter endpoint. An update landing in that
    // window is expected, not a fault — the next poll's update() call is
    // effectively a free retry, so this only needs to be logged quietly rather
    // than escalated like a real failure.
    _isInitializingError(err) {
        const message = err instanceof Error ? err.message : String(err);
        return /\bis still initializing\b/i.test(message);
    }
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    async update(readings) {
        if (!this.registered || !this.uuid)
            return;
        const matter = this.api.matter;
        if (!matter)
            return;
        const clusters = this.buildClusters(readings);
        const energy = this._dueEnergyState(readings);
        const uuid = this.uuid;
        try {
            await Promise.all([
                matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement),
                // Skip the energy cluster entirely when nothing is due — even an empty
                // update would be logged and broadcast as a state change.
                Object.keys(energy.state).length > 0
                    ? matter.updateAccessoryState(uuid, 'electricalEnergyMeasurement', energy.state).then(energy.commit)
                    : Promise.resolve(),
            ]);
        }
        catch (err) {
            if (this._isInitializingError(err)) {
                this.log.debug(`[matter] Update skipped — Matter endpoint is still initializing; the next poll will retry. (${err instanceof Error ? err.message : err})`);
                return;
            }
            // Log the first failure at warn, the rest at debug, so a persistently
            // unhappy Matter server can't flood the log on every poll.
            const message = `[matter] Failed to update Matter state: ${err instanceof Error ? err.message : err}`;
            if (!this.warnedUpdate) {
                this.warnedUpdate = true;
                this.log.warn(message);
            }
            else {
                this.log.debug(message);
            }
        }
    }
}
exports.MatterEnergyBridge = MatterEnergyBridge;
