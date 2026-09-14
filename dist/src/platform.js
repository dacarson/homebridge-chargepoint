"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChargePointPlatform = void 0;
const client_1 = require("./chargepoint/client");
const accessory_1 = require("./accessory");
const errors_1 = require("./chargepoint/errors");
const tokenStore_1 = require("./tokenStore");
const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';
class ChargePointPlatform {
    log;
    rawConfig;
    api;
    // ChargePoint allows only one home charger per account.
    accessory;
    cachedPlatformAccessories = [];
    client;
    captchaBackoffUntil = 0;
    authBackoffUntil = 0;
    get config() {
        return this.rawConfig;
    }
    constructor(log, rawConfig, api) {
        this.log = log;
        this.rawConfig = rawConfig;
        this.api = api;
        this.api.on('didFinishLaunching', () => {
            this.init().catch(err => this.log.error('Plugin failed to initialize:', err));
        });
    }
    // Called by Homebridge for each cached accessory on startup
    configureAccessory(accessory) {
        this.cachedPlatformAccessories.push(accessory);
    }
    // ── Initialization ────────────────────────────────────────────────────────
    async init() {
        try {
            await (0, tokenStore_1.initStore)(this.api.user.storagePath());
            this.client = new client_1.ChargePointClient(this.config.username, this.log);
            await this._authFlow();
            await this._discoverCharger();
            this._startPolling();
        }
        catch (err) {
            this.log.error('Plugin failed to initialize:', err);
            // Do not rethrow — cached accessories show "No Response"; other plugins continue
        }
    }
    async _authFlow() {
        await this.client.discoverRegion(this.config.username);
        // Prefer an existing coulomb_sess token: validate it against a non-Datadome
        // endpoint rather than hitting the Datadome-protected login route on every
        // start. Config sessionToken is an explicit override and takes priority over
        // the auto-saved token.
        const preToken = this.config.sessionToken ?? await (0, tokenStore_1.loadToken)();
        if (preToken) {
            this.client.setCoulombToken(preToken);
            try {
                await this.client.getAccount();
                const token = this.client.getCoulombToken();
                if (token)
                    await (0, tokenStore_1.saveToken)(token);
                this.log.info('Authenticated with existing session token.');
                return;
            }
            catch (err) {
                if (err instanceof errors_1.InvalidSession) {
                    this.log.warn('Saved session token is invalid — falling back to password login.');
                    await (0, tokenStore_1.clearToken)();
                }
                else {
                    throw err;
                }
            }
        }
        await this._passwordLogin();
    }
    async _passwordLogin() {
        try {
            await this.client.loginWithPassword(this.config.password);
            const token = this.client.getCoulombToken();
            if (token)
                await (0, tokenStore_1.saveToken)(token);
            this.log.info('Authenticated with password.');
        }
        catch (err) {
            if (err instanceof errors_1.DatadomeCaptcha) {
                this.log.error(`Login blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
                this.log.error('Add the coulomb_sess cookie value as "sessionToken" in the plugin config to recover.');
                throw err;
            }
            throw err;
        }
    }
    async _discoverCharger() {
        const chargerId = await this.client.getHomeCharger();
        if (chargerId === null) {
            this.log.error('No home charger found on this ChargePoint account.');
            return;
        }
        this.log.info(`Discovered home charger: ${chargerId}`);
        // Remove any stale cached accessories (e.g. the account's charger changed)
        const staleAccessories = this.cachedPlatformAccessories.filter(a => {
            const ctx = a.context;
            return ctx.chargerId !== chargerId;
        });
        if (staleAccessories.length > 0) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
        }
        await this._registerOrRestoreAccessory(chargerId);
    }
    async _registerOrRestoreAccessory(chargerId) {
        const uuid = this.api.hap.uuid.generate(`chargepoint-${chargerId}`);
        let platformAccessory = this.cachedPlatformAccessories.find(a => a.UUID === uuid);
        let isNew = false;
        if (!platformAccessory) {
            const displayName = `ChargePoint ${chargerId}`;
            platformAccessory = new this.api.platformAccessory(displayName, uuid);
            platformAccessory.context = { chargerId, displayName };
            isNew = true;
        }
        else {
            const ctx = platformAccessory.context;
            ctx.chargerId = chargerId;
        }
        const accessory = new accessory_1.ChargePointAccessory(this.api, this.log, platformAccessory, this.client, this.config.matter ?? false);
        // Populate static info (model, serial, firmware)
        try {
            const techInfo = await this.client.getHomeChargerTechnicalInfo(chargerId);
            let displayName;
            try {
                const cfg = await this.client.getHomeChargerConfig(chargerId);
                displayName = cfg.station_nickname || `ChargePoint ${chargerId}`;
            }
            catch {
                displayName = `ChargePoint ${chargerId}`;
            }
            platformAccessory.displayName = displayName;
            const nameChar = platformAccessory
                .getService(this.api.hap.Service.AccessoryInformation)
                ?.getCharacteristic(this.api.hap.Characteristic.Name);
            if (nameChar)
                nameChar.updateValue(displayName);
            await accessory.initTechInfo(techInfo);
        }
        catch (err) {
            this.log.warn(`[${chargerId}] Could not fetch tech info: ${err}`);
        }
        this.accessory = accessory;
        if (isNew) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
            this.log.info(`Registered new accessory: ChargePoint ${chargerId}`);
        }
    }
    // ── Polling ───────────────────────────────────────────────────────────────
    _startPolling() {
        // Fire immediately so characteristics have real values before HomeKit reads them,
        // then _pollCycle self-schedules each subsequent poll.
        void this._pollCycle();
    }
    _scheduleNextPoll(charging = false) {
        const interval = this._nextIntervalMs(charging);
        setTimeout(() => this._pollCycle(), interval);
    }
    _nextIntervalMs(charging = false) {
        const now = Date.now();
        if (now < this.captchaBackoffUntil)
            return Math.max(1000, this.captchaBackoffUntil - now);
        if (now < this.authBackoffUntil)
            return Math.max(1000, this.authBackoffUntil - now);
        const base = (this.config.pollingIntervalSeconds ?? 30) * 1000;
        // Use 15 s while actively charging so power readings stay fresh
        return charging ? Math.min(15_000, base) : base;
    }
    async _pollCycle() {
        const accessory = this.accessory;
        if (!accessory) {
            this._scheduleNextPoll();
            return;
        }
        let charging = false;
        // ── Phase 1: account-level charging status ────────────────────────────────
        let accountStatus = null;
        let activeSession = null;
        try {
            accountStatus = await this.client.getUserChargingStatus();
            if (accountStatus && accountStatus.session_id !== null) {
                activeSession = await this.client.getChargingSession(accountStatus.session_id);
            }
        }
        catch (err) {
            if (err instanceof errors_1.InvalidSession) {
                await this._handleMidPollInvalidSession();
                this._scheduleNextPoll();
                return;
            }
            if (err instanceof errors_1.DatadomeCaptcha) {
                await this._handleDatadomeCaptcha(err);
                this._scheduleNextPoll();
                return;
            }
            // Non-auth errors (network blip, 5xx): log and continue with null session
            this.log.warn(`Poll: could not fetch charging status: ${err}`);
        }
        // ── Phase 2: charger refresh ──────────────────────────────────────────────
        try {
            // Only attribute the active session to this charger if it belongs to it.
            const stationMatch = accountStatus?.stations.find(s => s.id === accessory.chargerId);
            const session = stationMatch ? activeSession : null;
            await accessory.refresh(session);
            if (session)
                charging = true;
        }
        catch (err) {
            if (err instanceof errors_1.InvalidSession) {
                await this._handleMidPollInvalidSession();
            }
            else if (err instanceof errors_1.DatadomeCaptcha) {
                await this._handleDatadomeCaptcha(err);
            }
            else if (err instanceof errors_1.CommunicationError) {
                this.log.warn(`[${accessory.chargerId}] Poll communication error: ${err.message}`);
                accessory.markNoResponse();
            }
            else {
                this.log.warn(`[${accessory.chargerId}] Refresh error: ${err}`);
                accessory.markNoResponse();
            }
        }
        this._scheduleNextPoll(charging);
    }
    async _handleMidPollInvalidSession() {
        this.log.warn('Session expired during poll — attempting re-authentication.');
        await (0, tokenStore_1.clearToken)();
        try {
            await this.client.loginWithPassword(this.config.password);
            const token = this.client.getCoulombToken();
            if (token)
                await (0, tokenStore_1.saveToken)(token);
            this.log.info('Re-authenticated successfully.');
        }
        catch (err) {
            if (err instanceof errors_1.DatadomeCaptcha) {
                await this._handleDatadomeCaptcha(err);
            }
            else {
                this.log.error(`Re-authentication failed: ${err}`);
                // 15-min backoff after failed re-auth
                this.authBackoffUntil = Date.now() + 15 * 60 * 1000;
                this.accessory?.markNoResponse();
            }
        }
    }
    async _handleDatadomeCaptcha(err) {
        this.log.error(`Blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
        this.log.error('Add the coulomb_sess cookie value as "sessionToken" in the plugin config to recover.');
        this.captchaBackoffUntil = Date.now() + 5 * 60 * 1000;
        this.accessory?.markNoResponse();
    }
}
exports.ChargePointPlatform = ChargePointPlatform;
