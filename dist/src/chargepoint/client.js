"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChargePointClient = void 0;
const axios_1 = __importDefault(require("axios"));
const axios_cookiejar_support_1 = require("axios-cookiejar-support");
const tough_cookie_1 = require("tough-cookie");
const globalConfig_1 = require("./globalConfig");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const tokenStore_1 = require("../tokenStore");
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
class ChargePointClient {
    jar;
    http;
    globalConfig;
    userId;
    username;
    log;
    constructor(username, log) {
        this.username = username;
        this.log = log;
        this.jar = new tough_cookie_1.CookieJar();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.http = (0, axios_cookiejar_support_1.wrapper)(axios_1.default.create({ jar: this.jar }));
    }
    getCoulombToken() {
        const cookies = this.jar.getCookiesSync(`https://account${constants_1.COOKIE_DOMAIN}/`);
        return cookies.find(c => c.key === constants_1.COULOMB_SESSION)?.value;
    }
    setCoulombToken(token) {
        const cookie = new tough_cookie_1.Cookie({
            key: constants_1.COULOMB_SESSION,
            value: token,
            domain: constants_1.COOKIE_DOMAIN,
            path: '/',
            maxAge: constants_1.COULOMB_SESSION_MAX_AGE,
        });
        this.jar.setCookieSync(cookie, `https://account${constants_1.COOKIE_DOMAIN}/`);
    }
    _persistToken() {
        const token = this.getCoulombToken();
        if (token) {
            this.setCoulombToken(token);
            (0, tokenStore_1.saveToken)(token).catch(() => { });
        }
    }
    _headers() {
        const headers = {
            'user-agent': 'homebridge-chargepoint/1.0.0',
        };
        const token = this.getCoulombToken();
        if (token && this.globalConfig) {
            headers['cp-session-type'] = 'CP_SESSION_TOKEN';
            headers['cp-session-token'] = token;
            headers['cp-region'] = this.globalConfig.region;
        }
        return headers;
    }
    async _request(method, url, data) {
        this.log.debug(`[${method}] ${url}`);
        const response = await this.http.request({
            method,
            url,
            data,
            headers: this._headers(),
            validateStatus: () => true,
            // Always attempt JSON parsing regardless of content-type
            transformResponse: [
                (raw) => {
                    if (typeof raw !== 'string')
                        return raw;
                    try {
                        return JSON.parse(raw);
                    }
                    catch {
                        return raw;
                    }
                },
            ],
        });
        this._persistToken();
        if (response.status === 401) {
            throw new errors_1.InvalidSession(401, 'Session token has expired. Please login again.');
        }
        if (response.status === 403) {
            const captchaUrl = response.data?.url;
            if (captchaUrl) {
                throw new errors_1.DatadomeCaptcha(String(captchaUrl), `[${method}] ${url} blocked by Datadome.`);
            }
            throw new errors_1.CommunicationError(403, `FORBIDDEN: [${method}] ${url}`);
        }
        return response;
    }
    _raiseForStatus(response, message) {
        if (response.status !== 200) {
            this.log.error(`${message} status=${response.status}`);
            throw new errors_1.CommunicationError(response.status, message);
        }
    }
    // ── Auth / Region ─────────────────────────────────────────────────────────
    async discoverRegion(username) {
        this.log.debug(`Discovering region for ${username}`);
        const response = await this._request('POST', constants_1.DISCOVERY_API, { username });
        this._raiseForStatus(response, 'Failed to discover region for provided username.');
        this.globalConfig = (0, globalConfig_1.parseGlobalConfig)(response.data);
        this.log.debug(`Discovered region: ${this.globalConfig.region}`);
    }
    async loginWithPassword(password) {
        const url = `${this.globalConfig.endpoints.sso_endpoint}v1/user/login`;
        this.log.debug(`Logging in as ${this.username}`);
        // Don't use _request here — we need raw 403 handling before the throw
        const response = await this.http.request({
            method: 'POST',
            url,
            data: { username: this.username, password },
            headers: { 'user-agent': 'homebridge-chargepoint/1.0.0' },
            validateStatus: () => true,
            transformResponse: [
                (raw) => {
                    if (typeof raw !== 'string')
                        return raw;
                    try {
                        return JSON.parse(raw);
                    }
                    catch {
                        return raw;
                    }
                },
            ],
        });
        if (response.status === 403 && response.data?.url) {
            throw new errors_1.DatadomeCaptcha(String(response.data.url), 'Login blocked by Datadome captcha.');
        }
        if (response.status === 200 && this.getCoulombToken()) {
            this._persistToken();
            await this._initAccountParameters();
            return;
        }
        this.log.error(`Login failed: status=${response.status}`);
        throw new errors_1.LoginError(response.status, 'Failed to authenticate to ChargePoint.');
    }
    async _initAccountParameters() {
        const account = await this.getAccount();
        this.userId = account.userId;
        if (account.username !== this.username) {
            this.log.warn(`Username mismatch: discovery=${this.username} session=${account.username}`);
            this.username = account.username;
        }
    }
    async getAccount() {
        const url = `${this.globalConfig.endpoints.accounts_endpoint}v1/driver/profile/user`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to get user information.');
        const d = response.data;
        return {
            userId: d?.user?.userId ?? 0,
            username: d?.user?.username ?? '',
        };
    }
    // ── Home Charger ──────────────────────────────────────────────────────────
    async getHomeChargers() {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to retrieve Home Flex chargers.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (response.data?.data ?? []).map(item => parseInt(item.id, 10));
    }
    async getHomeChargerStatus(chargerId) {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers/${chargerId}/status`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to get home charger status.');
        const d = response.data ?? {};
        const amp = d.chargeAmperageSettings ?? {};
        return {
            charger_id: chargerId,
            charging_status: d.chargingStatus ?? '',
            is_plugged_in: d.isPluggedIn ?? false,
            is_connected: d.isConnected ?? false,
            amperage_limit: amp.chargeLimit ?? 0,
            possible_amperage_limits: amp.possibleChargeLimit ?? [],
        };
    }
    async getHomeChargerTechnicalInfo(chargerId) {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers/${chargerId}/technical-info`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to get home charger tech info.');
        const d = response.data ?? {};
        return {
            model_number: d.modelNumber ?? '',
            serial_number: d.serialNumber ?? '',
            software_version: d.softwareVersion ?? '0.0.0.0',
        };
    }
    async getHomeChargerConfig(chargerId) {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers/${chargerId}/configurations`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to get charger configuration.');
        const settings = response.data?.settings ?? response.data ?? {};
        return {
            station_nickname: settings.stationNickname ?? '',
        };
    }
    // ── Charging Session ──────────────────────────────────────────────────────
    async getUserChargingStatus() {
        const url = `${this.globalConfig.endpoints.mapcache_endpoint}v2`;
        const response = await this._request('POST', url, { user_status: { mfhs: {} } });
        this._raiseForStatus(response, 'Failed to get user charging status.');
        const userStatus = response.data?.user_status;
        if (!userStatus || Object.keys(userStatus).length === 0) {
            return null;
        }
        const charging = userStatus.charging ?? userStatus;
        const c = charging;
        return {
            session_id: c.sessionId ?? 0,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            stations: (c.stations ?? []).map(s => ({ id: s.deviceId ?? s.id ?? 0 })),
        };
    }
    async getChargingSession(sessionId) {
        const url = `${this.globalConfig.endpoints.internal_api_gateway_endpoint}/driver-bff/v1/sessions/${sessionId}`;
        const response = await this._request('POST', url, { charging_status: { session_id: sessionId, mfhs: [] } });
        this._raiseForStatus(response, 'Failed to get charging session data.');
        const status = response.data?.charging_status;
        if (!status || 'error_message' in status || 'error' in status) {
            throw new errors_1.CommunicationError(response.status, 'Failed to get charging session data.');
        }
        return {
            session_id: sessionId,
            device_id: status.device_id ?? 0,
            outlet_number: status.outlet_number ?? 0,
            power_kw: status.power_kw ?? 0,
            energy_kwh: status.energy_kwh ?? 0,
            charging_state: (status.current_charging ?? status.charging_state ?? ''),
        };
    }
    async startChargingSessionAsync(deviceId) {
        await this._sendCommand('start', deviceId);
        const status = await this.getUserChargingStatus();
        if (!status) {
            throw new errors_1.CommunicationError(0, 'No active charging session found after start command.');
        }
        return this.getChargingSession(status.session_id);
    }
    async stopChargingSessionAsync(deviceId, portNumber, sessionId) {
        await this._sendCommand('stop', deviceId, portNumber, sessionId);
    }
    async setAmperageLimit(chargerId, amps) {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/chargers/${chargerId}/charge-amperage-limit`;
        const response = await this._request('PUT', url, { chargeAmperageLimit: amps });
        this._raiseForStatus(response, 'Failed to set amperage limit.');
    }
    // ── Session Start/Stop Command + Ack Loop ─────────────────────────────────
    async _sendCommand(action, deviceId, portNumber = 1, sessionId = 0) {
        const actionPath = action === 'start' ? 'startsession' : 'stopSession';
        const url = `${this.globalConfig.endpoints.accounts_endpoint}v1/driver/station/${actionPath}`;
        const body = { deviceId };
        if (action === 'stop') {
            body.portNumber = portNumber;
            body.sessionId = sessionId;
        }
        const cmdResponse = await this._request('POST', url, body);
        if (cmdResponse.status !== 200) {
            throw new errors_1.CommunicationError(cmdResponse.status, `Failed to ${action} session.`);
        }
        const ackId = cmdResponse.data?.ackId;
        const ackUrl = `${this.globalConfig.endpoints.accounts_endpoint}v1/driver/station/session/ack`;
        const ackBody = { ackId, action: `${action}_session` };
        for (let attempt = 1; attempt <= 20; attempt++) {
            this.log.debug(`Checking ${action} ack (attempt ${attempt}/20) ackId=${String(ackId)}`);
            const ackResponse = await this._request('POST', ackUrl, ackBody);
            if (ackResponse.status === 200) {
                this.log.info(`Successfully confirmed ${action} command.`);
                return;
            }
            const errMsg = ackResponse.data?.errorMessage ?? `Session failed to ${action}.`;
            this.log.warn(`${action} ack not confirmed (attempt ${attempt}/20): ${String(errMsg)}`);
            if (attempt < 20) {
                await sleep(3000);
            }
        }
        throw new errors_1.CommunicationError(0, `Failed to confirm ${action} after 20 attempts.`);
    }
}
exports.ChargePointClient = ChargePointClient;
