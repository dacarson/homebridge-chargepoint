import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar, Cookie } from 'tough-cookie';
import type { Logger } from 'homebridge';
import { GlobalConfiguration, parseGlobalConfig } from './globalConfig';
import {
  HomeChargerStatus,
  HomeChargerTechnicalInfo,
  HomeChargerConfiguration,
  UserChargingStatus,
  ChargingSession,
} from './types';
import {
  DISCOVERY_API,
  COULOMB_SESSION,
  COOKIE_DOMAIN,
  COULOMB_SESSION_MAX_AGE,
} from './constants';
import {
  CommunicationError,
  DatadomeCaptcha,
  InvalidSession,
  LoginError,
} from './errors';
import { saveToken } from '../tokenStore';

export class ChargePointClient {
  private jar: CookieJar;
  private http: AxiosInstance;
  private globalConfig!: GlobalConfiguration;
  private userId?: number;
  private username: string;
  private readonly log: Logger;
  private _token: string | undefined;

  constructor(username: string, log: Logger) {
    this.username = username;
    this.log = log;
    this.jar = new CookieJar();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.http = wrapper(axios.create({ jar: this.jar } as any));
  }

  getCoulombToken(): string | undefined {
    const fromJar = this.jar.getCookiesSync(`https://${COOKIE_DOMAIN.replace(/^\./, '')}/`)
      .find(c => c.key === COULOMB_SESSION)?.value;
    return fromJar ?? this._token;
  }

  setCoulombToken(token: string): void {
    const decoded = decodeURIComponent(token);
    this._token = decoded;
    const cookie = new Cookie({
      key: COULOMB_SESSION,
      value: decoded,
      domain: COOKIE_DOMAIN.replace(/^\./, ''),
      path: '/',
      maxAge: COULOMB_SESSION_MAX_AGE,
      hostOnly: false,
    });
    this.jar.setCookieSync(cookie, `https://${COOKIE_DOMAIN.replace(/^\./, '')}/`);
    this.log.debug(`setCoulombToken: prefix=${decoded.slice(0, 8)}…`);
  }

  private _persistToken(): void {
    const fromJar = this.jar.getCookiesSync(`https://${COOKIE_DOMAIN.replace(/^\./, '')}/`)
      .find(c => c.key === COULOMB_SESSION)?.value;
    if (fromJar && fromJar !== this._token) {
      this._token = fromJar;
      saveToken(fromJar).catch(() => {/* background save — errors are non-fatal */});
    }
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = {
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

  private async _request(
    method: string,
    url: string,
    data?: unknown,
    headers?: Record<string, string>,
  ): Promise<AxiosResponse> {
    const reqHeaders = headers ?? this._headers();
    if (data !== undefined) reqHeaders['content-type'] = 'application/json';

    const response = await this.http.request({
      method,
      url,
      data,
      headers: reqHeaders,
      validateStatus: () => true,
      // Always attempt JSON parsing regardless of content-type
      transformResponse: [
        (raw: unknown) => {
          if (typeof raw !== 'string') return raw;
          try { return JSON.parse(raw); } catch { return raw; }
        },
      ],
    });

    this._persistToken();
    this.log.debug(`[${method}] ${url} → ${response.status}`);

    if (response.status === 401) {
      throw new InvalidSession(401, 'Session token has expired. Please login again.');
    }
    if (response.status === 403) {
      const captchaUrl = response.data?.url;
      if (captchaUrl) {
        throw new DatadomeCaptcha(String(captchaUrl), `[${method}] ${url} blocked by Datadome.`);
      }
      throw new CommunicationError(403, `FORBIDDEN: [${method}] ${url}`);
    }

    return response;
  }

  private _raiseForStatus(response: AxiosResponse, message: string): void {
    if (response.status !== 200) {
      this.log.error(`${message} status=${response.status}`);
      throw new CommunicationError(response.status, message);
    }
  }

  // ── Auth / Region ─────────────────────────────────────────────────────────

  async discoverRegion(username: string): Promise<void> {
    this.log.debug(`Discovering region for ${username}`);
    const response = await this._request('POST', DISCOVERY_API, { username });
    this._raiseForStatus(response, 'Failed to discover region for provided username.');
    this.globalConfig = parseGlobalConfig(response.data as Record<string, unknown>);
    this.log.debug(`Discovered region: ${this.globalConfig.region}`);
  }

  async loginWithPassword(password: string): Promise<void> {
    const url = `${this.globalConfig.endpoints.sso_endpoint}v1/user/login`;
    this.log.debug(`Logging in as ${this.username}`);
    const response = await this._request('POST', url, { username: this.username, password }, { 'user-agent': 'homebridge-chargepoint/1.0.0' });
    if (response.status === 200 && this.getCoulombToken()) {
      this._persistToken();
      await this._initAccountParameters();
      return;
    }
    this.log.error(`Login failed: status=${response.status}`);
    throw new LoginError(response.status, 'Failed to authenticate to ChargePoint.');
  }

  private async _initAccountParameters(): Promise<void> {
    const account = await this.getAccount();
    this.userId = account.userId;
    if (account.username !== this.username) {
      this.log.warn(
        `Username mismatch: discovery=${this.username} session=${account.username}`,
      );
      this.username = account.username;
    }
  }

  async getAccount(): Promise<{ userId: number; username: string }> {
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

  async getHomeChargers(): Promise<number[]> {
    const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers`;
    const response = await this._request('GET', url);
    this._raiseForStatus(response, 'Failed to retrieve Home Flex chargers.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((response.data?.data ?? []) as any[]).map(item => parseInt(item.id, 10));
  }

  async getHomeChargerStatus(chargerId: number): Promise<HomeChargerStatus> {
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

  async getHomeChargerTechnicalInfo(chargerId: number): Promise<HomeChargerTechnicalInfo> {
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

  async getHomeChargerConfig(chargerId: number): Promise<HomeChargerConfiguration> {
    const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/users/${this.userId}/chargers/${chargerId}/configurations`;
    const response = await this._request('GET', url);
    this._raiseForStatus(response, 'Failed to get charger configuration.');
    const settings = response.data?.settings ?? response.data ?? {};
    return {
      station_nickname: settings.stationNickname ?? '',
    };
  }

  async getUserChargingStatus(): Promise<UserChargingStatus | null> {
    const url = `${this.globalConfig.endpoints.mapcache_endpoint}v2`;
    const response = await this._request('POST', url, { user_status: { mfhs: {} } });
    this._raiseForStatus(response, 'Failed to get user charging status.');
    const userStatus = response.data?.user_status;
    if (!userStatus || Object.keys(userStatus).length === 0) return null;
    // The API wraps session fields under a "charging" key when a session is active.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = userStatus.charging ?? userStatus;
    const sessionId = d.sessionId != null ? Number(d.sessionId) : null;
    const state: string = d.state ?? '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stations = (Array.isArray(d.stations) ? d.stations : []).map((s: any) => ({ id: Number(s.deviceId ?? 0) }));
    return { session_id: sessionId, state, stations };
  }

  async getChargingSession(sessionId: number): Promise<ChargingSession | null> {
    const url = `${this.globalConfig.endpoints.internal_api_gateway_endpoint}/driver-bff/v1/sessions/${sessionId}`;
    const response = await this._request('POST', url, { charging_status: { session_id: sessionId, mfhs: [] } });
    this._raiseForStatus(response, 'Failed to get charging session.');
    const d = response.data?.charging_status;
    if (!d || d.error_message || d.error) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPoints: any[] = Array.isArray(d.update_data) ? d.update_data : [];
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
