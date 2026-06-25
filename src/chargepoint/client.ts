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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ChargePointClient {
  private jar: CookieJar;
  private http: AxiosInstance;
  private globalConfig!: GlobalConfiguration;
  private userId?: number;
  private username: string;
  private readonly log: Logger;

  constructor(username: string, log: Logger) {
    this.username = username;
    this.log = log;
    this.jar = new CookieJar();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.http = wrapper(axios.create({ jar: this.jar } as any));
  }

  getCoulombToken(): string | undefined {
    const cookies = this.jar.getCookiesSync(`https://account${COOKIE_DOMAIN}/`);
    return cookies.find(c => c.key === COULOMB_SESSION)?.value;
  }

  setCoulombToken(token: string): void {
    const cookie = new Cookie({
      key: COULOMB_SESSION,
      value: token,
      domain: COOKIE_DOMAIN,
      path: '/',
      maxAge: COULOMB_SESSION_MAX_AGE,
    });
    this.jar.setCookieSync(cookie, `https://account${COOKIE_DOMAIN}/`);
  }

  private _persistToken(): void {
    const token = this.getCoulombToken();
    if (token) {
      this.setCoulombToken(token);
      saveToken(token).catch(() => {/* background save — errors are non-fatal */});
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
  ): Promise<AxiosResponse> {
    this.log.debug(`[${method}] ${url}`);
    const response = await this.http.request({
      method,
      url,
      data,
      headers: this._headers(),
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
    // Don't use _request here — we need raw 403 handling before the throw
    const response = await this.http.request({
      method: 'POST',
      url,
      data: { username: this.username, password },
      headers: { 'user-agent': 'homebridge-chargepoint/1.0.0' },
      validateStatus: () => true,
      transformResponse: [
        (raw: unknown) => {
          if (typeof raw !== 'string') return raw;
          try { return JSON.parse(raw); } catch { return raw; }
        },
      ],
    });

    if (response.status === 403 && response.data?.url) {
      throw new DatadomeCaptcha(String(response.data.url), 'Login blocked by Datadome captcha.');
    }
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
    const response = await this._request('GET', url);
    this._raiseForStatus(response, 'Failed to get user information.');
    const d = response.data;
    return {
      userId: d?.user?.userId ?? 0,
      username: d?.user?.username ?? '',
    };
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

  // ── Charging Session ──────────────────────────────────────────────────────

  async getUserChargingStatus(): Promise<UserChargingStatus | null> {
    const url = `${this.globalConfig.endpoints.mapcache_endpoint}v2`;
    const response = await this._request('POST', url, { user_status: { mfhs: {} } });
    this._raiseForStatus(response, 'Failed to get user charging status.');
    const userStatus = response.data?.user_status;
    if (!userStatus || Object.keys(userStatus as object).length === 0) {
      return null;
    }
    const charging = (userStatus as Record<string, unknown>).charging ?? userStatus;
    const c = charging as Record<string, unknown>;
    return {
      session_id: (c.sessionId as number) ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stations: ((c.stations ?? []) as any[]).map(s => ({ id: s.deviceId ?? s.id ?? 0 })),
    };
  }

  async getChargingSession(sessionId: number): Promise<ChargingSession> {
    const url = `${this.globalConfig.endpoints.internal_api_gateway_endpoint}/driver-bff/v1/sessions/${sessionId}`;
    const response = await this._request(
      'POST',
      url,
      { charging_status: { session_id: sessionId, mfhs: [] } },
    );
    this._raiseForStatus(response, 'Failed to get charging session data.');
    const status = response.data?.charging_status as Record<string, unknown>;
    if (!status || 'error_message' in status || 'error' in status) {
      throw new CommunicationError(response.status, 'Failed to get charging session data.');
    }
    return {
      session_id: sessionId,
      device_id: (status.device_id as number) ?? 0,
      outlet_number: (status.outlet_number as number) ?? 0,
      power_kw: (status.power_kw as number) ?? 0,
      energy_kwh: (status.energy_kwh as number) ?? 0,
      charging_state: (status.current_charging ?? status.charging_state ?? '') as string,
    };
  }

  async startChargingSessionAsync(deviceId: number): Promise<ChargingSession> {
    await this._sendCommand('start', deviceId);
    const status = await this.getUserChargingStatus();
    if (!status) {
      throw new CommunicationError(0, 'No active charging session found after start command.');
    }
    return this.getChargingSession(status.session_id);
  }

  async stopChargingSessionAsync(
    deviceId: number,
    portNumber: number,
    sessionId: number,
  ): Promise<void> {
    await this._sendCommand('stop', deviceId, portNumber, sessionId);
  }

  async setAmperageLimit(chargerId: number, amps: number): Promise<void> {
    const url = `${this.globalConfig.endpoints.hcpo_hcm_endpoint}api/v1/configuration/chargers/${chargerId}/charge-amperage-limit`;
    const response = await this._request('PUT', url, { chargeAmperageLimit: amps });
    this._raiseForStatus(response, 'Failed to set amperage limit.');
  }

  // ── Session Start/Stop Command + Ack Loop ─────────────────────────────────

  private async _sendCommand(
    action: 'start' | 'stop',
    deviceId: number,
    portNumber = 1,
    sessionId = 0,
  ): Promise<void> {
    const actionPath = action === 'start' ? 'startsession' : 'stopSession';
    const url = `${this.globalConfig.endpoints.accounts_endpoint}v1/driver/station/${actionPath}`;

    const body: Record<string, unknown> = { deviceId };
    if (action === 'stop') {
      body.portNumber = portNumber;
      body.sessionId = sessionId;
    }

    const cmdResponse = await this._request('POST', url, body);
    if (cmdResponse.status !== 200) {
      throw new CommunicationError(cmdResponse.status, `Failed to ${action} session.`);
    }

    const ackId = (cmdResponse.data as Record<string, unknown>)?.ackId;
    const ackUrl = `${this.globalConfig.endpoints.accounts_endpoint}v1/driver/station/session/ack`;
    const ackBody = { ackId, action: `${action}_session` };

    for (let attempt = 1; attempt <= 20; attempt++) {
      this.log.debug(`Checking ${action} ack (attempt ${attempt}/20) ackId=${String(ackId)}`);
      const ackResponse = await this._request('POST', ackUrl, ackBody);
      if (ackResponse.status === 200) {
        this.log.info(`Successfully confirmed ${action} command.`);
        return;
      }
      const errMsg = (ackResponse.data as Record<string, unknown>)?.errorMessage ?? `Session failed to ${action}.`;
      this.log.warn(`${action} ack not confirmed (attempt ${attempt}/20): ${String(errMsg)}`);
      if (attempt < 20) {
        await sleep(3000);
      }
    }
    throw new CommunicationError(0, `Failed to confirm ${action} after 20 attempts.`);
  }
}
