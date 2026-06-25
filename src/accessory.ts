import type {
  API,
  Logger,
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { ChargePointClient } from './chargepoint/client';
import type {
  HomeChargerStatus,
  HomeChargerTechnicalInfo,
  ChargingSession,
} from './chargepoint/types';
import { buildEveCharacteristics, safeW, safeA } from './eveCharacteristics';
import { loadLifetimeKwh, saveLifetimeKwh } from './tokenStore';

export interface AccessoryContext {
  chargerId: number;
  displayName: string;
}

export class ChargePointAccessory {
  readonly chargerId: number;

  private readonly outletService: Service;
  private readonly eve: ReturnType<typeof buildEveCharacteristics>;

  private status: HomeChargerStatus | null = null;
  private session: ChargingSession | null = null;
  private lastSession: ChargingSession | null = null;

  private persistedBaseKwh = 0;
  private lifetimeKwh = 0;

  commandInFlight = false;

  get isCharging(): boolean {
    return this.status?.charging_status === 'CHARGING';
  }

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly platformAccessory: PlatformAccessory,
    private readonly client: ChargePointClient,
    private readonly onRapidRefresh: () => void,
  ) {
    this.chargerId = (platformAccessory.context as AccessoryContext).chargerId;
    this.eve = buildEveCharacteristics(api.hap);

    // Outlet service (Eve Energy)
    this.outletService =
      platformAccessory.getService(api.hap.Service.Outlet) ??
      platformAccessory.addService(api.hap.Service.Outlet);

    this.outletService.getCharacteristic(api.hap.Characteristic.On)
      .onSet((value: CharacteristicValue) => {
        void this._handleSetOn(value as boolean);
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

  async initTechInfo(techInfo: HomeChargerTechnicalInfo): Promise<void> {
    const infoService =
      this.platformAccessory.getService(this.api.hap.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'ChargePoint')
      .setCharacteristic(this.api.hap.Characteristic.Model, techInfo.model_number)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, techInfo.serial_number)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, techInfo.software_version);

    // Load persisted lifetime energy from tokenStore
    this.persistedBaseKwh = await loadLifetimeKwh(this.chargerId);
    this.lifetimeKwh = this.persistedBaseKwh;
  }

  async refresh(session: ChargingSession | null): Promise<void> {
    try {
      this.status = await this.client.getHomeChargerStatus(this.chargerId);
    } catch (err) {
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
      await saveLifetimeKwh(this.chargerId, this.persistedBaseKwh);
      this.lifetimeKwh = this.persistedBaseKwh;
    }

    this.session = session;
    this.lastSession = session;

    if (session !== null) {
      this.lifetimeKwh = this.persistedBaseKwh + session.energy_kwh;
    }

    this._updateCharacteristics();
  }

  private _updateCharacteristics(): void {
    const isCharging = this.status?.charging_status === 'CHARGING';
    const powerW = isCharging ? safeW(this.session?.power_kw ?? 0) : 0;
    const currentA = isCharging ? safeA(this.session?.power_kw ?? 0) : 0;

    this.outletService.updateCharacteristic(this.api.hap.Characteristic.On, isCharging);
    this.outletService.updateCharacteristic(
      this.api.hap.Characteristic.OutletInUse,
      this.status?.is_plugged_in ?? false,
    );

    this.outletService.updateCharacteristic('E863F10D-079E-48FF-8F27-9C2605A29F52', powerW);
    this.outletService.updateCharacteristic('E863F10C-079E-48FF-8F27-9C2605A29F52', this.lifetimeKwh);
    this.outletService.updateCharacteristic('E863F10A-079E-48FF-8F27-9C2605A29F52', 240.0);
    this.outletService.updateCharacteristic('E863F126-079E-48FF-8F27-9C2605A29F52', currentA);
  }

  markNoResponse(): void {
    this.outletService.getCharacteristic(this.api.hap.Characteristic.On)
      .updateValue(new Error('No Response'));
  }

  private _handleSetOn(value: boolean): void {
    if (value) {
      this.commandInFlight = true;
      this.client.startChargingSessionAsync(this.chargerId)
        .then(session => { this.session = session; })
        .catch(err => this.log.error(`[${this.chargerId}] Start failed: ${err}`))
        .finally(() => {
          this.commandInFlight = false;
          this.onRapidRefresh();
        });
    } else {
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
