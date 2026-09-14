/**
 * matterEnergy.ts
 *
 * Publishes the ChargePoint charger to Matter controllers as a standalone
 * electrical sensor, so it appears in the Apple Home Energy view (iOS/tvOS
 * 26+) with live watts — without also showing up as a second, controllable
 * accessory tile alongside the real HAP outlet.
 *
 * Background
 * ----------
 * Apple Home's Energy view is driven by Matter electrical-measurement
 * clusters, not by classic HomeKit/HAP characteristics. HAP has no native
 * power/energy characteristic, so the Eve custom characteristics this plugin
 * also exposes (see eveCharacteristics.ts) are only ever read by Eve-class
 * apps and never populate the native Energy tile.
 *
 * Homebridge 2.2.0 added the ElectricalPowerMeasurement / ElectricalEnergyMeasurement
 * clusters to its Matter plugin API, and 2.3.0 fixed composition/bridge-online
 * behavior needed to use them reliably. This module talks to that API directly:
 *
 *   240V (fixed)        -> electricalPowerMeasurement.voltage        (mV)
 *   amperage_limit       -> electricalPowerMeasurement.activeCurrent  (mA)
 *   powerKw               -> electricalPowerMeasurement.activePower   (mW)
 *   lifetimeKwh          -> electricalEnergyMeasurement
 *                             .cumulativeEnergyImported.energy        (mWh)
 *
 * Matter expresses all of these in milli-units, hence the x1000 conversions.
 *
 * Homebridge derives the mandatory cluster attributes (powerMode, accuracy,
 * numberOfMeasurementTypes) and the feature-gated ElectricalEnergyMeasurement
 * features from the declared state — declaring `cumulativeEnergyImported`
 * selects the ImportedEnergy + CumulativeEnergy features. `ElectricalSensor`
 * (`deviceTypes.ElectricalSensor`) is Homebridge's device type specifically
 * for a standalone power/energy meter (its own comment: "e.g. a solar or
 * whole-home meter") — unlike `OnOffOutlet`, it carries no onOff cluster, so
 * it doesn't present as a second controllable accessory the way the outlet
 * shape did. No separate EnergyEvse device type is needed (and Homebridge
 * does not currently expose one — see homebridge/homebridge#3942).
 *
 * Also declares `periodicEnergyImported` — the energy delta since the
 * previous poll, with a start/end timestamp — alongside the cumulative
 * total. Per homebridge-shelly-matter (a more mature Matter energy-metering
 * plugin): Apple Home's per-device energy *attribution* is driven by the
 * PeriodicEnergy feature, not just CumulativeEnergy, and Matter composes a
 * cluster's features once at registration — so periodicEnergyImported must
 * be present (even as a zero placeholder) in the very first registered
 * snapshot, or the feature never gets added at all.
 *
 * Requirements
 * ------------
 * - Homebridge 2.3.0 or later
 * - Matter enabled on this plugin's child bridge (Homebridge UI ->
 *   plugin settings -> Bridge Settings -> enable Matter)
 *
 * Everything here is feature-detected and guarded: on a Homebridge build
 * without the Matter API, or with Matter disabled, isSupported() returns
 * false and the plugin runs HAP/Eve-only exactly as before.
 */

import type { API, Logger } from 'homebridge';

const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';

/** Matter uses milli-units for electrical measurements. */
function milli(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

export interface EnergyReadings {
  voltageV: number;
  currentA: number;
  powerW: number;
  energyWh: number;
}

interface PeriodicEnergy {
  energy: number;
  startTimestamp: number;
  endTimestamp: number;
}

interface MatterAccessoryClusters {
  electricalPowerMeasurement: { voltage: number; activeCurrent: number; activePower: number };
  electricalEnergyMeasurement: {
    cumulativeEnergyImported: { energy: number };
    periodicEnergyImported: { energy: number } | PeriodicEnergy;
  };
}

interface MatterAccessoryDefinition {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  clusters: MatterAccessoryClusters;
}

// Minimal shape of the subset of Homebridge's Matter plugin API this module
// uses. Not imported from 'homebridge' because the type declarations for
// api.matter only ship with Homebridge 2.2+; this keeps the plugin buildable
// against older @types without pulling in a hard dependency on them.
interface MatterAPILike {
  deviceTypes: { ElectricalSensor?: unknown };
  registerPlatformAccessories: (
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDefinition[],
  ) => Promise<void>;
  updateAccessoryState: (uuid: string, cluster: string, state: unknown) => Promise<void>;
  uuid: { generate: (seed: string) => string };
}

type APIWithMatter = API & { matter?: MatterAPILike };

export class MatterEnergyBridge {
  private readonly api: APIWithMatter;
  private uuid: string | null = null;
  private registered = false;
  private warnedUpdate = false;

  // Tracks the current periodic-energy window: the wall-clock start and the
  // cumulative energyWh reading at that start, so each update() call can
  // report the delta consumed since the previous one as one contiguous,
  // non-overlapping period.
  private _periodStartS: number | null = null;
  private _periodStartEnergyWh = 0;

  constructor(api: API, private readonly log: Logger) {
    this.api = api as APIWithMatter;
  }

  /**
   * Whether this Homebridge build exposes everything needed to publish a
   * standalone electrical sensor. Logs at debug level so unsupported builds
   * stay quiet.
   */
  isSupported(): boolean {
    const matter = this.api.matter;
    if (!matter) {
      this.log.debug('[matter] api.matter unavailable — Matter energy export disabled. Requires Homebridge 2.3.0+ with Matter enabled on this plugin\'s child bridge.');
      return false;
    }
    if (!matter.deviceTypes?.ElectricalSensor) {
      this.log.debug('[matter] api.matter.deviceTypes.ElectricalSensor unavailable — Matter energy export disabled.');
      return false;
    }
    if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
      this.log.debug('[matter] Matter registration/update API unavailable — Matter energy export disabled.');
      return false;
    }
    return true;
  }

  private buildClusters(r: EnergyReadings): MatterAccessoryClusters {
    return {
      electricalPowerMeasurement: {
        voltage: milli(r.voltageV),
        activeCurrent: milli(r.currentA),
        activePower: milli(r.powerW),
      },
      electricalEnergyMeasurement: {
        // A wall charger only ever imports energy from the grid.
        cumulativeEnergyImported: { energy: milli(r.energyWh) },
        // Zero placeholder — real windows come from _nextPeriodicEnergy().
        // Declaring the attribute here (even at zero) is what makes Matter
        // compose the PeriodicEnergy feature at registration.
        periodicEnergyImported: { energy: 0 },
      },
    };
  }

  /**
   * The energy delta since the previous call, as a Matter PeriodicEnergy
   * fragment covering [previous call's time, now]. The first call after
   * registration has no prior window to close, so it just opens one.
   */
  private _nextPeriodicEnergy(energyWh: number): PeriodicEnergy | { energy: number } {
    const nowS = Math.floor(Date.now() / 1000);

    if (this._periodStartS === null) {
      this._periodStartS = nowS;
      this._periodStartEnergyWh = energyWh;
      return { energy: 0 };
    }

    const deltaWh = Math.max(0, energyWh - this._periodStartEnergyWh);
    const fragment: PeriodicEnergy = {
      energy: milli(deltaWh),
      startTimestamp: this._periodStartS,
      endTimestamp: nowS,
    };

    this._periodStartS = nowS;
    this._periodStartEnergyWh = energyWh;
    return fragment;
  }

  /**
   * Register the charger as a standalone Matter electrical sensor.
   *
   * @param chargerId - used to seed a UUID distinct from the HAP accessory's
   * @param displayName
   * @param readings - initial readings to seed the clusters with
   */
  async register(chargerId: number, displayName: string, readings: EnergyReadings): Promise<boolean> {
    if (!this.isSupported()) return false;
    const matter = this.api.matter!;
    this.uuid = matter.uuid.generate(`${PLUGIN_NAME}:matter:${chargerId}`);

    const accessory: MatterAccessoryDefinition = {
      UUID: this.uuid,
      displayName,
      deviceType: matter.deviceTypes.ElectricalSensor,
      serialNumber: String(chargerId),
      manufacturer: 'ChargePoint',
      model: 'Home Flex',
      clusters: this.buildClusters(readings),
    };

    // Opens the first periodic-energy window so the first update() call has
    // a start point to measure from (buildClusters() already seeded the
    // registered snapshot's periodicEnergyImported with the same zero value).
    this._nextPeriodicEnergy(readings.energyWh);

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registered = true;
      this.log.info('[matter] Published charger as a Matter electrical sensor — live power should appear in the Apple Home Energy view.');
      return true;
    } catch (err) {
      this.log.warn(`[matter] Failed to register Matter accessory (${err instanceof Error ? err.message : err}). Continuing with HomeKit/Eve only.`);
      this.registered = false;
      return false;
    }
  }

  // Homebridge can take a while (well past 14s on slower hosts, e.g. a
  // Raspberry Pi, or during a busy child-bridge restart) to finish
  // initializing a just-registered Matter endpoint. An update landing in that
  // window is expected, not a fault — the next poll's update() call is
  // effectively a free retry, so this only needs to be logged quietly rather
  // than escalated like a real failure.
  private _isInitializingError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /\bis still initializing\b/i.test(message);
  }

  /**
   * Push fresh readings to the registered Matter accessory. No-op until
   * registration has succeeded.
   */
  async update(readings: EnergyReadings): Promise<void> {
    if (!this.registered || !this.uuid) return;
    const matter = this.api.matter;
    if (!matter) return;

    const clusters = this.buildClusters(readings);
    clusters.electricalEnergyMeasurement.periodicEnergyImported = this._nextPeriodicEnergy(readings.energyWh);

    try {
      await Promise.all([
        matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement),
        matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', clusters.electricalEnergyMeasurement),
      ]);
    } catch (err) {
      if (this._isInitializingError(err)) {
        this.log.debug(`[matter] Update skipped — Matter endpoint is still initializing; the next poll will retry. (${err instanceof Error ? err.message : err})`);
        return;
      }

      // Log the first failure at warn, the rest at debug, so a persistently
      // unhappy Matter server can't flood the log on every poll.
      const message = `[matter] Failed to update Matter state: ${err instanceof Error ? err.message : err}`;
      if (!this.warnedUpdate) {
        this.warnedUpdate = true;
        this.log.warn(message);
      } else {
        this.log.debug(message);
      }
    }
  }
}
