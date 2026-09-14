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
class ChargePointClient {
    jar;
    http;
    globalConfig;
    userId;
    username;
    log;
    _token;
    constructor(username, log) {
        this.username = username;
        this.log = log;
        this.jar = new tough_cookie_1.CookieJar();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.http = (0, axios_cookiejar_support_1.wrapper)(axios_1.default.create({ jar: this.jar }));
    }
    getCoulombToken() {
        const fromJar = this.jar.getCookiesSync(`https://${constants_1.COOKIE_DOMAIN.replace(/^\./, '')}/`)
            .find(c => c.key === constants_1.COULOMB_SESSION)?.value;
        return fromJar ?? this._token;
    }
    setCoulombToken(token) {
        const decoded = decodeURIComponent(token);
        this._token = decoded;
        const cookie = new tough_cookie_1.Cookie({
            key: constants_1.COULOMB_SESSION,
            value: decoded,
            domain: constants_1.COOKIE_DOMAIN.replace(/^\./, ''),
            path: '/',
            maxAge: constants_1.COULOMB_SESSION_MAX_AGE,
            hostOnly: false,
        });
        this.jar.setCookieSync(cookie, `https://${constants_1.COOKIE_DOMAIN.replace(/^\./, '')}/`);
        this.log.debug(`setCoulombToken: prefix=${decoded.slice(0, 8)}…`);
    }
    _persistToken() {
        const fromJar = this.jar.getCookiesSync(`https://${constants_1.COOKIE_DOMAIN.replace(/^\./, '')}/`)
            .find(c => c.key === constants_1.COULOMB_SESSION)?.value;
        if (fromJar && fromJar !== this._token) {
            this._token = fromJar;
            (0, tokenStore_1.saveToken)(fromJar).catch(() => { });
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
    async _request(method, url, data, headers) {
        const reqHeaders = headers ?? this._headers();
        if (data !== undefined)
            reqHeaders['content-type'] = 'application/json';
        const response = await this.http.request({
            method,
            url,
            data,
            headers: reqHeaders,
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
        this.log.debug(`[${method}] ${url} → ${response.status}`);
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
        const response = await this._request('POST', url, { username: this.username, password }, { 'user-agent': 'homebridge-chargepoint/1.0.0' });
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
        this.log.debug(`getAccount: calling ${url}`);
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to get user information.');
        const d = response.data;
        const result = {
            userId: d?.user?.userId ?? 0,
            username: d?.user?.username ?? '',
        };
        this.userId = result.userId;
        return result;
    }
    // ── Home Charger ──────────────────────────────────────────────────────────
    // ChargePoint permits only one home charger per account, so this returns the
    // single charger id (or null if none is registered).
    async getHomeCharger() {
        const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers`;
        const response = await this._request('GET', url);
        this._raiseForStatus(response, 'Failed to retrieve Home Flex charger.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chargers = (response.data?.data ?? []);
        return chargers.length > 0 ? parseInt(chargers[0].id, 10) : null;
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
    async getUserChargingStatus() {
        const url = `${this.globalConfig.endpoints.mapcache_endpoint}v2`;
        const response = await this._request('POST', url, { user_status: { mfhs: {} } });
        this._raiseForStatus(response, 'Failed to get user charging status.');
        const userStatus = response.data?.user_status;
        if (!userStatus || Object.keys(userStatus).length === 0)
            return null;
        // The API wraps session fields under a "charging" key when a session is active.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = userStatus.charging ?? userStatus;
        const sessionId = d.sessionId != null ? Number(d.sessionId) : null;
        const state = d.state ?? '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stations = (Array.isArray(d.stations) ? d.stations : []).map((s) => ({ id: Number(s.deviceId ?? 0) }));
        return { session_id: sessionId, state, stations };
    }
    async getChargingSession(sessionId) {
        const url = `${this.globalConfig.endpoints.internal_api_gateway_endpoint}/driver-bff/v1/sessions/${sessionId}`;
        const response = await this._request('POST', url, { charging_status: { session_id: sessionId, mfhs: [] } });
        this._raiseForStatus(response, 'Failed to get charging session.');
        const d = response.data?.charging_status;
        if (!d || d.error_message || d.error)
            return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawPoints = Array.isArray(d.update_data) ? d.update_data : [];
        return {
            session_id: sessionId,
            device_id: Number(d.device_id ?? 0),
            outlet_number: Number(d.outlet_number ?? 0),
            power_kw: Number(d.power_kw ?? 0),
            energy_kwh: Number(d.energy_kwh ?? 0),
            charging_state: String(d.current_charging ?? ''),
            update_data: rawPoints.map(p => ({
                energy_kwh: Number(p.energy_kwh ?? 0),
                power_kw: Number(p.power_kw ?? 0),
                timestamp: Number(p.timestamp ?? 0),
            })),
        };
    }
}
exports.ChargePointClient = ChargePointClient;
