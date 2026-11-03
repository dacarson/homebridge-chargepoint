"use strict";
/**
 * eveUpdates.ts
 *
 * Controls how often the Eve custom power/energy characteristics (Current
 * Consumption, Total Consumption, Voltage, Electric Current) push value
 * changes to HomeKit controllers, selected by the `evePowerUpdates` setting:
 *
 *   throttled (default) — push only when the change is significant (see the
 *                          per-characteristic thresholds below) or
 *                          EVE_MAX_PUSH_INTERVAL_MS has passed since the last
 *                          push, so values stay within the threshold of the
 *                          real reading and are exact within 5 minutes.
 *   pollOnly            — drop the NOTIFY permission so controllers can't
 *                          subscribe; never push, and serve the newest reading
 *                          from onGet when a controller reads it.
 *   live                — push every change (the original behavior).
 *
 * hap-nodejs already drops an updateValue() that doesn't change the value, so
 * only real changes count as "sent" or "suppressed". In throttled mode reads
 * deliberately return the last *pushed* value: an onGet returning a different
 * value would make hap-nodejs broadcast it to every other subscribed
 * controller, defeating the throttle.
 *
 * Standard HomeKit characteristics (On, Outlet In Use) are not routed through
 * here — they stay fully evented so Home app automations keep working.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EveUpdateGroup = exports.EveCharacteristicUpdater = exports.anyChange = exports.kwhThreshold = exports.wattsThreshold = exports.EVE_STATS_INTERVAL_MS = exports.EVE_MAX_PUSH_INTERVAL_MS = exports.DEFAULT_EVE_UPDATE_SETTINGS = void 0;
exports.resolveEveUpdateSettings = resolveEveUpdateSettings;
const EVE_POWER_UPDATE_MODES = ['throttled', 'pollOnly', 'live'];
exports.DEFAULT_EVE_UPDATE_SETTINGS = {
    mode: 'throttled',
    minChangeWatts: 25,
    minChangePercent: 2,
    minChangeKwh: 0.1,
};
/** In throttled mode, a sub-threshold change is still pushed once this long has passed since the last push. */
exports.EVE_MAX_PUSH_INTERVAL_MS = 5 * 60 * 1000;
/** How often the sent vs suppressed summary is logged. */
exports.EVE_STATS_INTERVAL_MS = 60 * 60 * 1000;
// Absorbs floating-point error so e.g. 100.0 -> 100.1 counts as a 0.1 kWh change.
const EPSILON = 1e-9;
const wattsThreshold = (s) => (last, next) => Math.abs(next - last) + EPSILON >= Math.max(s.minChangeWatts, Math.abs(last) * s.minChangePercent / 100);
exports.wattsThreshold = wattsThreshold;
const kwhThreshold = (s) => (last, next) => Math.abs(next - last) + EPSILON >= s.minChangeKwh;
exports.kwhThreshold = kwhThreshold;
/** For readings that change rarely and in steps (fixed voltage, amperage limit): every change is significant. */
const anyChange = () => true;
exports.anyChange = anyChange;
/**
 * Validates the raw plugin config, falling back to the defaults (with a
 * warning) for an unknown mode or a missing/negative threshold.
 */
function resolveEveUpdateSettings(config, log) {
    const settings = { ...exports.DEFAULT_EVE_UPDATE_SETTINGS };
    const mode = config.evePowerUpdates;
    if (mode !== undefined) {
        if (EVE_POWER_UPDATE_MODES.includes(mode)) {
            settings.mode = mode;
        }
        else {
            log.warn(`Unknown evePowerUpdates "${mode}"; using "${settings.mode}". Valid values: ${EVE_POWER_UPDATE_MODES.join(', ')}.`);
        }
    }
    for (const key of ['minChangeWatts', 'minChangePercent', 'minChangeKwh']) {
        const value = config[key];
        if (value === undefined)
            continue;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            settings[key] = value;
        }
        else {
            log.warn(`Invalid ${key} "${value}"; using ${settings[key]}.`);
        }
    }
    return settings;
}
/** Applies the update policy to one Eve characteristic. Created via EveUpdateGroup.add(). */
class EveCharacteristicUpdater {
    characteristic;
    name;
    mode;
    threshold;
    log;
    latest = null;
    lastPushed = null;
    lastPushAt = 0;
    sent = 0;
    suppressed = 0;
    constructor(characteristic, name, mode, threshold, log) {
        this.characteristic = characteristic;
        this.name = name;
        this.mode = mode;
        this.threshold = threshold;
        this.log = log;
        // Set perms explicitly in every mode: a restored cached accessory keeps the
        // perms it was saved with, so switching away from pollOnly must put NOTIFY back.
        characteristic.setProps({
            perms: mode === 'pollOnly' ? ["pr" /* Perms.PAIRED_READ */] : ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
        });
        if (mode === 'pollOnly') {
            characteristic.onGet(() => this.latest ?? characteristic.value);
        }
    }
    update(value) {
        this.latest = value;
        if (this.mode === 'pollOnly') {
            if (value !== this.lastPushed) {
                this.lastPushed = value;
                this.suppressed++;
            }
            return;
        }
        // The first reading after startup is always reported, so HomeKit shows the
        // real value straight away rather than a stale cached one.
        if (this.lastPushed === null) {
            this._push(value);
            return;
        }
        if (value === this.lastPushed)
            return;
        if (this.mode === 'live' || this.threshold(this.lastPushed, value)) {
            this._push(value);
            return;
        }
        if (Date.now() - this.lastPushAt >= exports.EVE_MAX_PUSH_INTERVAL_MS) {
            this._push(value);
            return;
        }
        this.suppressed++;
        this.log.debug(`[eve] Suppressed ${this.name} update ${this.lastPushed} -> ${value} (below threshold).`);
    }
    _push(value) {
        this.characteristic.updateValue(value);
        this.lastPushed = value;
        this.lastPushAt = Date.now();
        this.sent++;
    }
}
exports.EveCharacteristicUpdater = EveCharacteristicUpdater;
/**
 * The Eve characteristics of one accessory, sharing a mode, thresholds and an
 * hourly sent vs suppressed summary.
 */
class EveUpdateGroup {
    settings;
    log;
    updaters = [];
    statsSince = Date.now();
    constructor(settings, log) {
        this.settings = settings;
        this.log = log;
    }
    get mode() {
        return this.settings.mode;
    }
    add(characteristic, name, threshold) {
        const updater = new EveCharacteristicUpdater(characteristic, name, this.settings.mode, threshold, this.log);
        this.updaters.push(updater);
        return updater;
    }
    /** Logs and resets the counters once EVE_STATS_INTERVAL_MS has passed; call after each poll's updates. */
    logStatsIfDue() {
        if (Date.now() - this.statsSince < exports.EVE_STATS_INTERVAL_MS)
            return;
        this.statsSince = Date.now();
        const sent = this.updaters.reduce((n, u) => n + u.sent, 0);
        const suppressed = this.updaters.reduce((n, u) => n + u.suppressed, 0);
        if (sent + suppressed > 0) {
            const detail = this.updaters.map(u => `${u.name} ${u.sent}/${u.suppressed}`).join(', ');
            this.log.info(`[eve] Last hour (${this.settings.mode}): ${sent} updates sent, ${suppressed} suppressed (sent/suppressed: ${detail}).`);
        }
        for (const u of this.updaters) {
            u.sent = 0;
            u.suppressed = 0;
        }
    }
}
exports.EveUpdateGroup = EveUpdateGroup;
