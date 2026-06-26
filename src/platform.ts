import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformConfig,
  PlatformAccessory,
} from 'homebridge';
import { ChargePointClient } from './chargepoint/client';
import { ChargePointAccessory, AccessoryContext } from './accessory';
import type { UserChargingStatus, ChargingSession } from './chargepoint/types';
import { DatadomeCaptcha, InvalidSession, CommunicationError } from './chargepoint/errors';
import {
  initStore,
  loadToken,
  saveToken,
  clearToken,
} from './tokenStore';

const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';

interface ChargePointPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  sessionToken?: string;
  pollingIntervalSeconds?: number;
  devices?: Array<{ chargerId: number; name?: string }>;
}

export class ChargePointPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<number, ChargePointAccessory>();
  private readonly cachedPlatformAccessories: PlatformAccessory[] = [];
  private client!: ChargePointClient;

  private captchaBackoffUntil = 0;
  private authBackoffUntil = 0;

  private get config(): ChargePointPlatformConfig {
    return this.rawConfig as ChargePointPlatformConfig;
  }

  constructor(
    public readonly log: Logger,
    private readonly rawConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.init().catch(err => this.log.error('Plugin failed to initialize:', err));
    });
  }

  // Called by Homebridge for each cached accessory on startup
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedPlatformAccessories.push(accessory);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    try {
      await initStore(this.api.user.storagePath());
      this.client = new ChargePointClient(this.config.username, this.log);

      await this._authFlow();
      await this._discoverDevices();
      this._startPolling();
    } catch (err) {
      this.log.error('Plugin failed to initialize:', err);
      // Do not rethrow — cached accessories show "No Response"; other plugins continue
    }
  }

  private async _authFlow(): Promise<void> {
    await this.client.discoverRegion(this.config.username);

    // Prefer an existing coulomb_sess token: validate it against a non-Datadome
    // endpoint rather than hitting the Datadome-protected login route on every
    // start. Config sessionToken is an explicit override and takes priority over
    // the auto-saved token.
    const preToken = this.config.sessionToken ?? await loadToken();
    if (preToken) {
      this.client.setCoulombToken(preToken);
      try {
        await this.client.getAccount();
        const token = this.client.getCoulombToken();
        if (token) await saveToken(token);
        this.log.info('Authenticated with existing session token.');
        return;
      } catch (err) {
        if (err instanceof InvalidSession) {
          this.log.warn('Saved session token is invalid — falling back to password login.');
          await clearToken();
        } else {
          throw err;
        }
      }
    }

    await this._passwordLogin();
  }

  private async _passwordLogin(): Promise<void> {
    try {
      await this.client.loginWithPassword(this.config.password);
      const token = this.client.getCoulombToken();
      if (token) await saveToken(token);
      this.log.info('Authenticated with password.');
    } catch (err) {
      if (err instanceof DatadomeCaptcha) {
        this.log.error(`Login blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
        this.log.error('Add the coulomb_sess cookie value as "sessionToken" in the plugin config to recover.');
        throw err;
      }
      throw err;
    }
  }

  private async _discoverDevices(): Promise<void> {
    let chargerIds: number[];

    if (this.config.devices && this.config.devices.length > 0) {
      chargerIds = this.config.devices.map(d => d.chargerId);
      this.log.info(`Using ${chargerIds.length} configured charger(s).`);
    } else {
      chargerIds = await this.client.getHomeChargers();
      this.log.info(`Discovered ${chargerIds.length} home charger(s): ${chargerIds.join(', ')}`);
    }

    // Remove stale cached accessories
    const staleAccessories = this.cachedPlatformAccessories.filter(a => {
      const ctx = a.context as AccessoryContext;
      return !chargerIds.includes(ctx.chargerId);
    });
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }

    for (const chargerId of chargerIds) {
      await this._registerOrRestoreAccessory(chargerId);
    }
  }

  private async _registerOrRestoreAccessory(chargerId: number): Promise<void> {
    const uuid = this.api.hap.uuid.generate(`chargepoint-${chargerId}`);
    const configuredDevice = this.config.devices?.find(d => d.chargerId === chargerId);

    let platformAccessory = this.cachedPlatformAccessories.find(a => a.UUID === uuid);
    let isNew = false;

    if (!platformAccessory) {
      const displayName = configuredDevice?.name ?? `ChargePoint ${chargerId}`;
      platformAccessory = new this.api.platformAccessory(displayName, uuid);
      (platformAccessory.context as AccessoryContext) = { chargerId, displayName };
      isNew = true;
    } else {
      const ctx = platformAccessory.context as AccessoryContext;
      ctx.chargerId = chargerId;
    }

    const accessory = new ChargePointAccessory(
      this.api,
      this.log,
      platformAccessory,
      this.client,
    );

    // Populate static info (model, serial, firmware)
    try {
      const techInfo = await this.client.getHomeChargerTechnicalInfo(chargerId);
      // Try to get station nickname if no configured name
      let displayName = configuredDevice?.name;
      if (!displayName) {
        try {
          const cfg = await this.client.getHomeChargerConfig(chargerId);
          displayName = cfg.station_nickname || `ChargePoint ${chargerId}`;
        } catch {
          displayName = `ChargePoint ${chargerId}`;
        }
        platformAccessory.displayName = displayName;
        const nameChar = platformAccessory
          .getService(this.api.hap.Service.AccessoryInformation)
          ?.getCharacteristic(this.api.hap.Characteristic.Name);
        if (nameChar) nameChar.updateValue(displayName);
      }
      await accessory.initTechInfo(techInfo);
    } catch (err) {
      this.log.warn(`[${chargerId}] Could not fetch tech info: ${err}`);
    }

    this.accessories.set(chargerId, accessory);

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
      this.log.info(`Registered new accessory: ChargePoint ${chargerId}`);
    }
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  private _startPolling(): void {
    // Fire immediately so characteristics have real values before HomeKit reads them,
    // then _pollCycle self-schedules each subsequent poll.
    void this._pollCycle();
  }

  private _scheduleNextPoll(anyCharging = false): void {
    const interval = this._nextIntervalMs(anyCharging);
    setTimeout(() => this._pollCycle(), interval);
  }

  private _nextIntervalMs(anyCharging = false): number {
    const now = Date.now();
    if (now < this.captchaBackoffUntil) return Math.max(1000, this.captchaBackoffUntil - now);
    if (now < this.authBackoffUntil) return Math.max(1000, this.authBackoffUntil - now);
    const base = (this.config.pollingIntervalSeconds ?? 30) * 1000;
    // Use 15 s while actively charging so power readings stay fresh
    return anyCharging ? Math.min(15_000, base) : base;
  }

  private async _pollCycle(): Promise<void> {
    let anyCharging = false;

    // ── Phase 1: account-level charging status (once per cycle) ──────────────
    let accountStatus: UserChargingStatus | null = null;
    let activeSession: ChargingSession | null = null;

    try {
      accountStatus = await this.client.getUserChargingStatus();
      if (accountStatus && accountStatus.session_id !== null) {
        activeSession = await this.client.getChargingSession(accountStatus.session_id);
      }
    } catch (err) {
      if (err instanceof InvalidSession) {
        await this._handleMidPollInvalidSession();
        this._scheduleNextPoll();
        return;
      }
      if (err instanceof DatadomeCaptcha) {
        await this._handleDatadomeCaptcha(err as DatadomeCaptcha);
        this._scheduleNextPoll();
        return;
      }
      // Non-auth errors (network blip, 5xx): log and continue with null session
      this.log.warn(`Poll: could not fetch charging status: ${err}`);
    }

    // ── Phase 2: per-accessory refresh ────────────────────────────────────────
    for (const [chargerId, accessory] of this.accessories) {
      try {
        const stationMatch = accountStatus?.stations.find(s => s.id === chargerId);
        const session = stationMatch ? activeSession : null;
        await accessory.refresh(session);
        if (session) anyCharging = true;
      } catch (err) {
        if (err instanceof InvalidSession) {
          await this._handleMidPollInvalidSession();
          break;
        } else if (err instanceof DatadomeCaptcha) {
          await this._handleDatadomeCaptcha(err as DatadomeCaptcha);
          break;
        } else if (err instanceof CommunicationError) {
          this.log.warn(`[${chargerId}] Poll communication error: ${err.message}`);
          accessory.markNoResponse();
        } else {
          this.log.warn(`[${chargerId}] Refresh error: ${err}`);
          accessory.markNoResponse();
        }
      }
    }

    this._scheduleNextPoll(anyCharging);
  }

  private async _handleMidPollInvalidSession(): Promise<void> {
    this.log.warn('Session expired during poll — attempting re-authentication.');
    await clearToken();
    try {
      await this.client.loginWithPassword(this.config.password);
      const token = this.client.getCoulombToken();
      if (token) await saveToken(token);
      this.log.info('Re-authenticated successfully.');
    } catch (err) {
      if (err instanceof DatadomeCaptcha) {
        await this._handleDatadomeCaptcha(err);
      } else {
        this.log.error(`Re-authentication failed: ${err}`);
        // 15-min backoff after failed re-auth
        this.authBackoffUntil = Date.now() + 15 * 60 * 1000;
        this._markAllNoResponse();
      }
    }
  }

  private async _handleDatadomeCaptcha(err: DatadomeCaptcha): Promise<void> {
    this.log.error(`Blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
    this.log.error('Add the coulomb_sess cookie value as "sessionToken" in the plugin config to recover.');
    this.captchaBackoffUntil = Date.now() + 5 * 60 * 1000;
    this._markAllNoResponse();
  }

  private _markAllNoResponse(): void {
    for (const acc of this.accessories.values()) {
      acc.markNoResponse();
    }
  }
}
