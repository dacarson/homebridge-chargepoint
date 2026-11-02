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
 * Also declares `periodicEnergyImported` — the energy consumed over a
 * reporting period, with a start/end timestamp — alongside the cumulative
 * total. Per homebridge-shelly-matter (a more mature Matter energy-metering
 * plugin): Apple Home's per-device energy *attribution* is driven by the
 * PeriodicEnergy feature, not just CumulativeEnergy, and Matter composes a
 * cluster's features once at registration — so periodicEnergyImported must
 * be present (even as a zero placeholder) in the very first registered
 * snapshot, or the feature never gets added at all.
 *
 * Event rate
 * ----------
 * Homebridge routes every energy reading present in an update through
 * matter.js setMeasurement(), which records a CumulativeEnergyMeasured /
 * PeriodicEnergyMeasured event for it; a reading left out of the update keeps
 * its previous attribute value and records nothing. Sending both on every
 * 15 s poll flooded controllers with events that almost never carried new
 * information, so after the first update:
 *
 *   - cumulativeEnergyImported is sent only when the total has changed, or as
 *     a heartbeat once ENERGY_REPORT_INTERVAL_S has passed since the last one;
 *   - periodicEnergyImported accumulates across polls and is sent once per
 *     ENERGY_REPORT_INTERVAL_S period — or early, as soon as energy starts
 *     flowing after the charger goes from idle to active, so a charging
 *     session shows up promptly.
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
/**
 * Length of a PeriodicEnergyMeasured period, and the CumulativeEnergyMeasured
 * heartbeat interval when the total hasn't changed. Shared so that while idle
 * both events land together on the same poll rather than on two clocks.
 */
export declare const ENERGY_REPORT_INTERVAL_S: number;
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
    private _lastCumulativeMilli;
    private _lastCumulativeS;
    private _firstUpdateSent;
    private _wasActive;
    private _activationPending;
    constructor(api: API, log: Logger);
    /**
     * Whether this Homebridge build exposes everything needed to publish a
     * standalone electrical sensor. Logs at debug level so unsupported builds
     * stay quiet.
     */
    isSupported(): boolean;
    private buildClusters;
    /** Opens a periodic-energy window starting now at the given cumulative reading. */
    private _openPeriod;
    /**
     * Decides which energy readings are due on this poll. Returns the state to
     * send (empty when nothing is due) and a commit callback that advances the
     * tracking state — called only once the update has been accepted, so a
     * failed update leaves the window open and the next poll covers it.
     */
    private _dueEnergyState;
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
