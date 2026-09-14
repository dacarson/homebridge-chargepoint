"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatterEnergyBridge = void 0;
const PLUGIN_NAME = 'homebridge-chargepoint';
const PLATFORM_NAME = 'ChargePoint';
/** Matter uses milli-units for electrical measurements. */
function milli(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
class MatterEnergyBridge {
    log;
    api;
    uuid = null;
    registered = false;
    warnedUpdate = false;
    constructor(api, log) {
        this.log = log;
        this.api = api;
    }
    /**
     * Whether this Homebridge build exposes everything needed to publish an
     * outlet with electrical measurements. Logs at debug level so unsupported
     * builds stay quiet.
     */
    isSupported() {
        const matter = this.api.matter;
        if (!matter) {
            this.log.debug('[matter] api.matter unavailable — Matter energy export disabled. Requires Homebridge 2.3.0+ with Matter enabled on this plugin\'s child bridge.');
            return false;
        }
        if (!matter.deviceTypes?.OnOffOutlet) {
            this.log.debug('[matter] api.matter.deviceTypes.OnOffOutlet unavailable — Matter energy export disabled.');
            return false;
        }
        if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
            this.log.debug('[matter] Matter registration/update API unavailable — Matter energy export disabled.');
            return false;
        }
        return true;
    }
    buildClusters(r) {
        return {
            onOff: { onOff: r.charging },
            electricalPowerMeasurement: {
                voltage: milli(r.voltageV),
                activeCurrent: milli(r.currentA),
                activePower: milli(r.powerW),
            },
            electricalEnergyMeasurement: {
                // A wall charger only ever imports energy from the grid.
                cumulativeEnergyImported: { energy: milli(r.energyWh) },
            },
        };
    }
    /**
     * Register the charger as a Matter outlet with electrical measurements.
     *
     * @param chargerId - used to seed a UUID distinct from the HAP accessory's
     * @param displayName
     * @param readings - initial readings to seed the clusters with
     */
    async register(chargerId, displayName, readings) {
        if (!this.isSupported())
            return false;
        const matter = this.api.matter;
        this.uuid = matter.uuid.generate(`${PLUGIN_NAME}:matter:${chargerId}`);
        const accessory = {
            UUID: this.uuid,
            displayName,
            deviceType: matter.deviceTypes.OnOffOutlet,
            serialNumber: String(chargerId),
            manufacturer: 'ChargePoint',
            model: 'Home Flex',
            clusters: this.buildClusters(readings),
            handlers: {
                // ChargePoint charging cannot be started or stopped through this
                // plugin. Accept the command so the controller isn't left hanging,
                // warn, and let the next poll push the true state back.
                onOff: {
                    on: async () => this._rejectControl(true),
                    off: async () => this._rejectControl(false),
                },
            },
        };
        try {
            await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.registered = true;
            this.log.info('[matter] Published charger as a Matter outlet with electrical measurements — live power should appear on its tile in the Apple Home Energy view.');
            return true;
        }
        catch (err) {
            this.log.warn(`[matter] Failed to register Matter accessory (${err instanceof Error ? err.message : err}). Continuing with HomeKit/Eve only.`);
            this.registered = false;
            return false;
        }
    }
    _rejectControl(requested) {
        this.log.warn(`[matter] Ignoring request to turn the charger ${requested ? 'on' : 'off'} — ChargePoint charging cannot be controlled through this plugin.`);
    }
    // Homebridge can take a while (well past 14s on slower hosts, e.g. a
    // Raspberry Pi, or during a busy child-bridge restart) to finish
    // initializing a just-registered Matter endpoint. An update landing in that
    // window is expected, not a fault — the next poll's update() call is
    // effectively a free retry, so this only needs to be logged quietly rather
    // than escalated like a real failure.
    _isInitializingError(err) {
        const message = err instanceof Error ? err.message : String(err);
        return /\bis still initializing\b/i.test(message);
    }
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    async update(readings) {
        if (!this.registered || !this.uuid)
            return;
        const matter = this.api.matter;
        if (!matter)
            return;
        const clusters = this.buildClusters(readings);
        try {
            await Promise.all([
                matter.updateAccessoryState(this.uuid, 'onOff', clusters.onOff),
                matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement),
                matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', clusters.electricalEnergyMeasurement),
            ]);
        }
        catch (err) {
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
            }
            else {
                this.log.debug(message);
            }
        }
    }
}
exports.MatterEnergyBridge = MatterEnergyBridge;
