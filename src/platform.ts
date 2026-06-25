import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformConfig,
  PlatformAccessory,
} from 'homebridge';
import { ChargePointClient } from './chargepoint/client';
import { ChargePointAccessory, AccessoryContext } from './accessory';
import { DatadomeCaptcha, InvalidSession, CommunicationError } from './chargepoint/errors';
import {
  initStore,
  loadToken,
  saveToken,
  clearToken,
  saveFlag,
  clearFlag,
  CAPTCHA_FLAG,
} from './tokenStore';

const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';

interface ChargePointPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  pollingIntervalSeconds?: number;
  devices?: Array<{ chargerId: number; name?: string }>;
}

export class ChargePointPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<number, ChargePointAccessory>();
  private readonly cachedPlatformAccessories: PlatformAccessory[] = [];
  private client!: ChargePointClient;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private rapidRefreshRemaining = 0;
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
    // 1. Always discover region first
    await this.client.discoverRegion(this.config.username);

    // 2. Try stored token
    const storedToken = await loadToken();
    if (storedToken) {
      this.client.setCoulombToken(storedToken);
      try {
        const account = await this.client.getAccount();
        this.log.info(`Authenticated as ${account.username} (stored token)`);
        await clearFlag(CAPTCHA_FLAG);
        return;
      } catch (err) {
        if (err instanceof InvalidSession) {
          this.log.warn('Stored token expired, re-authenticating with password.');
          await clearToken();
        } else {
          throw err;
        }
      }
    }

    // 3. Password login
    await this._passwordLogin();
  }

  private async _passwordLogin(): Promise<void> {
    try {
      await this.client.loginWithPassword(this.config.password);
      const token = this.client.getCoulombToken();
      if (token) await saveToken(token);
      await clearFlag(CAPTCHA_FLAG);
      this.log.info('Authenticated with password.');
    } catch (err) {
      if (err instanceof DatadomeCaptcha) {
        await saveFlag(CAPTCHA_FLAG, true);
        this.log.error(`Login blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
        this.log.error('Open the Setup tab in Config UI X to recover.');
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
      () => this.scheduleRapidRefresh(),
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
    this._scheduleNextPoll();
  }

  private _scheduleNextPoll(): void {
    const interval = this._nextIntervalMs();
    this.pollTimer = setTimeout(() => this._pollCycle(), interval);
  }

  private _nextIntervalMs(): number {
    const now = Date.now();

    if (now < this.captchaBackoffUntil) {
      return Math.max(1000, this.captchaBackoffUntil - now);
    }
    if (now < this.authBackoffUntil) {
      return Math.max(1000, this.authBackoffUntil - now);
    }

    for (const acc of this.accessories.values()) {
      if (acc.commandInFlight) return 5000;
    }

    if (this.rapidRefreshRemaining > 0) {
      this.rapidRefreshRemaining--;
      return 5000;
    }

    for (const acc of this.accessories.values()) {
      if (acc.isCharging) return 15000;
    }

    return (this.config.pollingIntervalSeconds ?? 30) * 1000;
  }

  scheduleRapidRefresh(): void {
    this.rapidRefreshRemaining = 3;
  }

  private async _pollCycle(): Promise<void> {
    try {
      const accountStatus = await this.client.getUserChargingStatus();

      for (const [chargerId, accessory] of this.accessories) {
        const stationMatch = accountStatus?.stations.find(s => s.id === chargerId);
        let sessionForCharger = null;

        if (stationMatch && accountStatus) {
          try {
            sessionForCharger = await this.client.getChargingSession(accountStatus.session_id);
          } catch (err) {
            this.log.warn(`[${chargerId}] Could not get charging session: ${err}`);
          }
        }

        try {
          await accessory.refresh(sessionForCharger);
        } catch (err) {
          this.log.warn(`[${chargerId}] Refresh error: ${err}`);
        }
      }
    } catch (err) {
      if (err instanceof InvalidSession) {
        await this._handleMidPollInvalidSession();
      } else if (err instanceof DatadomeCaptcha) {
        await this._handleDatadomeCaptcha(err);
      } else if (err instanceof CommunicationError) {
        this.log.warn(`Poll communication error: ${err.message}`);
      } else {
        this.log.error(`Poll error: ${err}`);
      }
    }

    this._scheduleNextPoll();
  }

  private async _handleMidPollInvalidSession(): Promise<void> {
    this.log.warn('Session expired during poll — attempting re-authentication.');
    await clearToken();
    try {
      await this.client.loginWithPassword(this.config.password);
      const token = this.client.getCoulombToken();
      if (token) await saveToken(token);
      await clearFlag(CAPTCHA_FLAG);
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
    await saveFlag(CAPTCHA_FLAG, true);
    this.log.error(`Blocked by Datadome. Solve captcha at: ${err.captchaUrl}`);
    this.log.error('Open the Setup tab in Config UI X to recover. Plugin paused for 5 minutes.');
    this.captchaBackoffUntil = Date.now() + 5 * 60 * 1000;
    this._markAllNoResponse();
  }

  private _markAllNoResponse(): void {
    for (const acc of this.accessories.values()) {
      acc.markNoResponse();
    }
  }
}
