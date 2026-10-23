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
export interface EnergyReadings {
    voltageV: number;
    currentA: number;
    powerW: number;
    energyWh: number;
}
export declare class MatterEnergyBridge {
    private readonly log;
    private readonly api;
    private uuid;
    private registered;
    private warnedUpdate;
    private _periodStartS;
    private _periodStartEnergyWh;
    constructor(api: API, log: Logger);
    /**
     * Whether this Homebridge build exposes everything needed to publish a
     * standalone electrical sensor. Logs at debug level so unsupported builds
     * stay quiet.
     */
    isSupported(): boolean;
    private buildClusters;
    /**
     * The energy delta since the previous call, as a Matter PeriodicEnergy
     * fragment covering [previous call's time, now]. The first call after
     * registration has no prior window to close, so it just opens one.
     */
    private _nextPeriodicEnergy;
    /**
     * Register the charger as a standalone Matter electrical sensor.
     *
     * @param chargerId - used to seed a UUID distinct from the HAP accessory's
     * @param displayName
     * @param readings - initial readings to seed the clusters with
     */
    register(chargerId: number, displayName: string, readings: EnergyReadings): Promise<boolean>;
    private _isInitializingError;
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    update(readings: EnergyReadings): Promise<void>;
}
