"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChargePointAccessory = void 0;
const eveCharacteristics_1 = require("./eveCharacteristics");
const tokenStore_1 = require("./tokenStore");
class ChargePointAccessory {
    api;
    log;
    platformAccessory;
    client;
    onRapidRefresh;
    chargerId;
    outletService;
    eve;
    status = null;
    session = null;
    lastSession = null;
    persistedBaseKwh = 0;
    lifetimeKwh = 0;
    commandInFlight = false;
    get isCharging() {
        return this.status?.charging_status === 'CHARGING';
    }
    constructor(api, log, platformAccessory, client, onRapidRefresh) {
        this.api = api;
        this.log = log;
        this.platformAccessory = platformAccessory;
        this.client = client;
        this.onRapidRefresh = onRapidRefresh;
        this.chargerId = platformAccessory.context.chargerId;
        this.eve = (0, eveCharacteristics_1.buildEveCharacteristics)(api.hap);
        // Outlet service (Eve Energy)
        this.outletService =
            platformAccessory.getService(api.hap.Service.Outlet) ??
                platformAccessory.addService(api.hap.Service.Outlet);
        this.outletService.getCharacteristic(api.hap.Characteristic.On)
            .onSet((value) => {
            void this._handleSetOn(value);
        });
        // Add Eve custom characteristics if not present
        if (!this.outletService.testCharacteristic('E863F10D-079E-48FF-8F27-9C2605A29F52')) {
            this.outletService.addCharacteristic(this.eve.CurrentConsumption());
        }
        if (!this.outletService.testCharacteristic('E863F10C-079E-48FF-8F27-9C2605A29F52')) {
            this.outletService.addCharacteristic(this.eve.TotalConsumption());
        }
        if (!this.outletService.testCharacteristic('E863F10A-079E-48FF-8F27-9C2605A29F52')) {
            this.outletService.addCharacteristic(this.eve.Voltage());
        }
        if (!this.outletService.testCharacteristic('E863F126-079E-48FF-8F27-9C2605A29F52')) {
            this.outletService.addCharacteristic(this.eve.ElectricCurrent());
        }
    }
    async initTechInfo(techInfo) {
        const infoService = this.platformAccessory.getService(this.api.hap.Service.AccessoryInformation);
        infoService
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'ChargePoint')
            .setCharacteristic(this.api.hap.Characteristic.Model, techInfo.model_number)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, techInfo.serial_number)
            .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, techInfo.software_version);
        // Load persisted lifetime energy from tokenStore
        this.persistedBaseKwh = await (0, tokenStore_1.loadLifetimeKwh)(this.chargerId);
        this.lifetimeKwh = this.persistedBaseKwh;
    }
    async refresh(session) {
        try {
            this.status = await this.client.getHomeChargerStatus(this.chargerId);
        }
        catch (err) {
            this.log.error(`[${this.chargerId}] Failed to get charger status: ${err}`);
            this.markNoResponse();
            return;
        }
        if (!this.status.is_connected) {
            this.markNoResponse();
            return;
        }
        // Detect session end → persist accumulator
        if (this.lastSession !== null && session === null) {
            this.persistedBaseKwh += this.lastSession.energy_kwh;
            await (0, tokenStore_1.saveLifetimeKwh)(this.chargerId, this.persistedBaseKwh);
            this.lifetimeKwh = this.persistedBaseKwh;
        }
        this.session = session;
        this.lastSession = session;
        if (session !== null) {
            this.lifetimeKwh = this.persistedBaseKwh + session.energy_kwh;
        }
        this._updateCharacteristics();
    }
    _updateCharacteristics() {
        const isCharging = this.status?.charging_status === 'CHARGING';
        const powerW = isCharging ? (0, eveCharacteristics_1.safeW)(this.session?.power_kw ?? 0) : 0;
        const currentA = isCharging ? (0, eveCharacteristics_1.safeA)(this.session?.power_kw ?? 0) : 0;
        this.outletService.updateCharacteristic(this.api.hap.Characteristic.On, isCharging);
        this.outletService.updateCharacteristic(this.api.hap.Characteristic.OutletInUse, this.status?.is_plugged_in ?? false);
        this.outletService.updateCharacteristic('E863F10D-079E-48FF-8F27-9C2605A29F52', powerW);
        this.outletService.updateCharacteristic('E863F10C-079E-48FF-8F27-9C2605A29F52', this.lifetimeKwh);
        this.outletService.updateCharacteristic('E863F10A-079E-48FF-8F27-9C2605A29F52', 240.0);
        this.outletService.updateCharacteristic('E863F126-079E-48FF-8F27-9C2605A29F52', currentA);
    }
    markNoResponse() {
        this.outletService.getCharacteristic(this.api.hap.Characteristic.On)
            .updateValue(new Error('No Response'));
    }
    _handleSetOn(value) {
        if (value) {
            this.commandInFlight = true;
            this.client.startChargingSessionAsync(this.chargerId)
                .then(session => { this.session = session; })
                .catch(err => this.log.error(`[${this.chargerId}] Start failed: ${err}`))
                .finally(() => {
                this.commandInFlight = false;
                this.onRapidRefresh();
            });
        }
        else {
            if (!this.session) {
                this.log.warn(`[${this.chargerId}] Stop requested but no active session known; skipping.`);
                return;
            }
            const { device_id, outlet_number, session_id } = this.session;
            this.commandInFlight = true;
            this.client.stopChargingSessionAsync(device_id, outlet_number, session_id)
                .catch(err => this.log.error(`[${this.chargerId}] Stop failed: ${err}`))
                .finally(() => {
                this.commandInFlight = false;
                this.onRapidRefresh();
            });
        }
    }
}
exports.ChargePointAccessory = ChargePointAccessory;
