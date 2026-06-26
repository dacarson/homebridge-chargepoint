import type {
  API,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import type { Characteristic } from 'hap-nodejs';
import type { ChargePointClient } from './chargepoint/client';
import type {
  HomeChargerStatus,
  HomeChargerTechnicalInfo,
  ChargingSession,
} from './chargepoint/types';
import { buildEveCharacteristics, safeW, safeA } from './eveCharacteristics';
import { loadLifetimeKwh, saveLifetimeKwh } from './tokenStore';
import fakegato = require('fakegato-history');

export interface AccessoryContext {
  chargerId: number;
  displayName: string;
}

export class ChargePointAccessory {
  readonly chargerId: number;

  private readonly outletService: Service;

  // Cached characteristic references — avoids UUID lookup failures on cached accessories
  private readonly charOn: Characteristic;
  private readonly charOutletInUse: Characteristic;
  private readonly charCurrentConsumption: Characteristic;
  private readonly charTotalConsumption: Characteristic;
  private readonly charVoltage: Characteristic;
  private readonly charElectricCurrent: Characteristic;

  private status: HomeChargerStatus | null = null;
  private session: ChargingSession | null = null;
  private lastSession: ChargingSession | null = null;

  // Lifetime kWh accumulator persisted across restarts
  private persistedBaseKwh = 0;
  private lifetimeKwh = 0;

  private historyService: InstanceType<ReturnType<typeof fakegato>>;
  private _lastBackfilledSessionId: number | null = null;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly platformAccessory: PlatformAccessory,
    private readonly client: ChargePointClient,
  ) {
    this.chargerId = (platformAccessory.context as AccessoryContext).chargerId;
    const eve = buildEveCharacteristics(api.hap);

    // Outlet service (Eve Energy)
    this.outletService =
      platformAccessory.getService(api.hap.Service.Outlet) ??
      platformAccessory.addService(api.hap.Service.Outlet);

    // Cache characteristic references.
    // getCharacteristic is reliable for standard HAP chars; for custom Eve chars we use
    // _getOrAdd because getCharacteristic(uuid) is broken for restored cached accessories
    // in some homebridge versions (returns undefined even when the char exists), and
    // addCharacteristic throws if the UUID is already present.
    this.charOn = this.outletService.getCharacteristic(api.hap.Characteristic.On);
    this.charOutletInUse = this.outletService.getCharacteristic(api.hap.Characteristic.OutletInUse);
    this.charCurrentConsumption = this._getOrAdd(eve.CurrentConsumption());
    this.charTotalConsumption = this._getOrAdd(eve.TotalConsumption());
    this.charVoltage = this._getOrAdd(eve.Voltage());
    this.charElectricCurrent = this._getOrAdd(eve.ElectricCurrent());

    const FakeGatoHistoryService = fakegato(api);
    this.historyService = new FakeGatoHistoryService('energy', platformAccessory, {
      size: 4032,
      storage: 'fs',
    });
  }

  // Finds an existing characteristic by UUID in the raw array (bypassing the broken
  // getCharacteristic(uuid) path for restored cached accessories), or adds it if absent.
  private _getOrAdd(instance: Characteristic): Characteristic {
    const existing = this.outletService.characteristics.find(c => c.UUID === instance.UUID);
    return existing ?? (this.outletService.addCharacteristic(instance) as unknown as Characteristic);
  }

  async initTechInfo(techInfo: HomeChargerTechnicalInfo): Promise<void> {
    const infoService =
      this.platformAccessory.getService(this.api.hap.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'ChargePoint')
      .setCharacteristic(this.api.hap.Characteristic.Model, techInfo.model_number)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, techInfo.serial_number)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, techInfo.software_version);

    this.persistedBaseKwh = await loadLifetimeKwh(this.chargerId);
    this.lifetimeKwh = this.persistedBaseKwh;
  }

  // session is the active ChargingSession for this charger, or null if not charging.
  // Errors from getHomeChargerStatus propagate to _pollCycle for auth-error handling.
  async refresh(session: ChargingSession | null): Promise<void> {
    this.status = await this.client.getHomeChargerStatus(this.chargerId);

    if (!this.status.is_connected) {
      this.markNoResponse();
      return;
    }

    this.session = session;

    // TotalConsumption accumulation using session.energy_kwh
    if (session !== null) {
      // Session active: live value = persisted base + current session's delivered energy
      this.lifetimeKwh = this.persistedBaseKwh + session.energy_kwh;
    } else if (this.lastSession !== null) {
      // Session just ended: commit last session's energy to the persisted base
      this.persistedBaseKwh += this.lastSession.energy_kwh;
      await saveLifetimeKwh(this.chargerId, this.persistedBaseKwh);
      this.lifetimeKwh = this.persistedBaseKwh;
    }

    this.lastSession = session;
    this._updateCharacteristics();
    this._updateHistory(session);
  }

  private _updateCharacteristics(): void {
    const isCharging = this.status?.charging_status === 'CHARGING';
    const powerKw = isCharging ? (this.session?.power_kw ?? 0) : 0;
    const powerW = safeW(powerKw);
    const currentA = safeA(powerKw);

    this.log.debug(
      `[${this.chargerId}] isCharging=${isCharging} powerKw=${powerKw} powerW=${powerW} currentA=${currentA} lifetimeKwh=${this.lifetimeKwh}`,
    );

    this.charOn.updateValue(isCharging);
    this.charOutletInUse.updateValue(this.status?.is_plugged_in ?? false);
    this.charCurrentConsumption.updateValue(powerW);
    this.charTotalConsumption.updateValue(this.lifetimeKwh);
    this.charVoltage.updateValue(240.0);
    this.charElectricCurrent.updateValue(currentA);
  }

  private _updateHistory(session: ChargingSession | null): void {
    // Backfill historical data points when a new session is first seen
    if (session !== null && session.session_id !== this._lastBackfilledSessionId) {
      for (const point of session.update_data) {
        this.historyService.addEntry({
          time: Math.round(point.timestamp / 1000),
          power: safeW(point.power_kw),
        });
      }
      this._lastBackfilledSessionId = session.session_id;
    }

    // Add current reading
    const isCharging = this.status?.charging_status === 'CHARGING';
    const powerKw = isCharging ? (session?.power_kw ?? 0) : 0;
    this.historyService.addEntry({
      time: Math.round(Date.now() / 1000),
      power: safeW(powerKw),
    });
  }

  markNoResponse(): void {
    this.charOn.updateValue(new Error('No Response'));
  }
}
