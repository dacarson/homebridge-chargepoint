import * as fs from 'fs';
import * as path from 'path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { ChargePointClient } from '../src/chargepoint/client';
import { DatadomeCaptcha, InvalidSession, CommunicationError } from '../src/chargepoint/errors';
import {
  initStore,
  loadToken,
  saveToken,
  clearToken,
  getFlag,
  saveFlag,
  clearFlag,
  CAPTCHA_FLAG,
} from '../src/tokenStore';

type AuthState = 'connected' | 'disconnected' | 'captcha' | 'captcha_blocked' | 'error';

interface AuthStatusResponse {
  state: AuthState;
  username?: string;
  lastRefresh?: string;
  captchaUrl?: string;
  message?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NoopLogger = any;

class ChargePointUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/auth/status', this.handleStatus.bind(this));
    this.onRequest('/auth/login', this.handleLogin.bind(this));
    this.onRequest('/auth/retry', this.handleLogin.bind(this));
    this.onRequest('/auth/validate-token', this.handleValidateToken.bind(this));
    this.onRequest('/auth/clear', this.handleClear.bind(this));

    this.ready();
  }

  private get storagePath(): string {
    return this.homebridgeStoragePath ?? '';
  }

  private async _initStore(): Promise<void> {
    await initStore(this.storagePath);
  }

  /** Read ChargePoint username from homebridge config.json */
  private _readUsernameFromConfig(): string {
    try {
      // homebridgeConfigPath is the config.json file path; fall back to storagePath/config.json
      const configFile = this.homebridgeConfigPath
        ?? path.join(this.storagePath, 'config.json');
      const raw = fs.readFileSync(configFile, 'utf-8');
      const config = JSON.parse(raw) as { platforms?: Array<Record<string, unknown>> };
      const platforms = config.platforms ?? [];
      const cp = platforms.find(p => p.platform === 'ChargePoint');
      return typeof cp?.username === 'string' ? cp.username : '';
    } catch {
      return '';
    }
  }

  private _makeClient(username: string): ChargePointClient {
    const log: NoopLogger = {
      info: () => { /* noop */ }, warn: () => { /* noop */ },
      error: () => { /* noop */ }, debug: () => { /* noop */ },
      success: () => { /* noop */ }, log: () => { /* noop */ },
    };
    return new ChargePointClient(username, log);
  }

  async handleStatus(_body: unknown): Promise<AuthStatusResponse> {
    try {
      await this._initStore();

      const captchaBlocked = await getFlag(CAPTCHA_FLAG);
      if (captchaBlocked) {
        return { state: 'captcha_blocked' };
      }

      const token = await loadToken();
      if (!token) {
        return { state: 'disconnected' };
      }

      const username = this._readUsernameFromConfig();
      if (!username) {
        return { state: 'disconnected' };
      }

      const client = this._makeClient(username);
      try {
        await client.discoverRegion(username);
        client.setCoulombToken(token);
        const account = await client.getAccount();
        return {
          state: 'connected',
          username: account.username,
          lastRefresh: new Date().toISOString(),
        };
      } catch (err) {
        if (err instanceof InvalidSession) {
          return { state: 'disconnected' };
        }
        return { state: 'error', message: String(err) };
      }
    } catch (err) {
      return { state: 'error', message: String(err) };
    }
  }

  async handleLogin(body: unknown): Promise<AuthStatusResponse> {
    const { username, password } = (body ?? {}) as { username?: string; password?: string };
    if (!username || !password) {
      throw new RequestError('Username and password are required.', { status: 400 });
    }

    try {
      await this._initStore();
      const client = this._makeClient(username);
      await client.discoverRegion(username);
      await client.loginWithPassword(password);
      const token = client.getCoulombToken();
      if (token) await saveToken(token);
      await clearFlag(CAPTCHA_FLAG);

      const account = await client.getAccount();
      return { state: 'connected', username: account.username };
    } catch (err) {
      if (err instanceof DatadomeCaptcha) {
        await saveFlag(CAPTCHA_FLAG, true);
        return { state: 'captcha', captchaUrl: err.captchaUrl };
      }
      return { state: 'error', message: String(err) };
    }
  }

  async handleValidateToken(body: unknown): Promise<AuthStatusResponse> {
    const { username, token } = (body ?? {}) as { username?: string; token?: string };
    if (!username || !token) {
      throw new RequestError('Username and token are required.', { status: 400 });
    }

    try {
      await this._initStore();
      const client = this._makeClient(username);
      await client.discoverRegion(username);
      client.setCoulombToken(token);
      const account = await client.getAccount();
      const refreshedToken = client.getCoulombToken() ?? token;
      await saveToken(refreshedToken);
      await clearFlag(CAPTCHA_FLAG);
      return { state: 'connected', username: account.username };
    } catch (err) {
      if (err instanceof InvalidSession || err instanceof CommunicationError) {
        return { state: 'error', message: 'Token is invalid or expired. Please re-copy the cookie.' };
      }
      return { state: 'error', message: String(err) };
    }
  }

  async handleClear(_body: unknown): Promise<{ success: boolean }> {
    try {
      await this._initStore();
      await clearToken();
      await clearFlag(CAPTCHA_FLAG);
      return { success: true };
    } catch (err) {
      throw new RequestError(String(err), { status: 500 });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const server = new ChargePointUiServer();
