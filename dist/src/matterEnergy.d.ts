/**
 * matterEnergy.ts
 *
 * Publishes the ChargePoint charger to Matter controllers as an outlet that
 * reports live electrical measurements, so it appears in the Apple Home
 * Energy view (iOS/tvOS 26+) with live watts on its tile.
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
 * selects the ImportedEnergy + CumulativeEnergy features. A plain
 * `OnOffOutlet` device type that declares electricalPowerMeasurement /
 * electricalEnergyMeasurement state gets those clusters automatically; no
 * separate EnergyEvse device type is needed (and Homebridge does not
 * currently expose one — see homebridge/homebridge#3942).
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
    charging: boolean;
}
export declare class MatterEnergyBridge {
    private readonly log;
    private readonly api;
    private uuid;
    private registered;
    private warnedUpdate;
    constructor(api: API, log: Logger);
    /**
     * Whether this Homebridge build exposes everything needed to publish an
     * outlet with electrical measurements. Logs at debug level so unsupported
     * builds stay quiet.
     */
    isSupported(): boolean;
    private buildClusters;
    /**
     * Register the charger as a Matter outlet with electrical measurements.
     *
     * @param chargerId - used to seed a UUID distinct from the HAP accessory's
     * @param displayName
     * @param readings - initial readings to seed the clusters with
     */
    register(chargerId: number, displayName: string, readings: EnergyReadings): Promise<boolean>;
    private _rejectControl;
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    update(readings: EnergyReadings): Promise<void>;
}
