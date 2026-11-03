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
import type { Logger } from 'homebridge';
import type { Characteristic } from 'hap-nodejs';
export type EvePowerUpdates = 'throttled' | 'pollOnly' | 'live';
export interface EveUpdateSettings {
    mode: EvePowerUpdates;
    minChangeWatts: number;
    minChangePercent: number;
    minChangeKwh: number;
}
export declare const DEFAULT_EVE_UPDATE_SETTINGS: Readonly<EveUpdateSettings>;
/** In throttled mode, a sub-threshold change is still pushed once this long has passed since the last push. */
export declare const EVE_MAX_PUSH_INTERVAL_MS: number;
/** How often the sent vs suppressed summary is logged. */
export declare const EVE_STATS_INTERVAL_MS: number;
/** Whether a change from the last pushed value to the next reading is significant enough to push. */
export type ChangeThreshold = (lastPushed: number, next: number) => boolean;
export declare const wattsThreshold: (s: EveUpdateSettings) => ChangeThreshold;
export declare const kwhThreshold: (s: EveUpdateSettings) => ChangeThreshold;
/** For readings that change rarely and in steps (fixed voltage, amperage limit): every change is significant. */
export declare const anyChange: ChangeThreshold;
/**
 * Validates the raw plugin config, falling back to the defaults (with a
 * warning) for an unknown mode or a missing/negative threshold.
 */
export declare function resolveEveUpdateSettings(config: Record<string, unknown>, log: Logger): EveUpdateSettings;
/** Applies the update policy to one Eve characteristic. Created via EveUpdateGroup.add(). */
export declare class EveCharacteristicUpdater {
    private readonly characteristic;
    readonly name: string;
    private readonly mode;
    private readonly threshold;
    private readonly log;
    private latest;
    private lastPushed;
    private lastPushAt;
    sent: number;
    suppressed: number;
    constructor(characteristic: Characteristic, name: string, mode: EvePowerUpdates, threshold: ChangeThreshold, log: Logger);
    update(value: number): void;
    private _push;
}
/**
 * The Eve characteristics of one accessory, sharing a mode, thresholds and an
 * hourly sent vs suppressed summary.
 */
export declare class EveUpdateGroup {
    private readonly settings;
    private readonly log;
    private readonly updaters;
    private statsSince;
    constructor(settings: EveUpdateSettings, log: Logger);
    get mode(): EvePowerUpdates;
    add(characteristic: Characteristic, name: string, threshold: ChangeThreshold): EveCharacteristicUpdater;
    /** Logs and resets the counters once EVE_STATS_INTERVAL_MS has passed; call after each poll's updates. */
    logStatsIfDue(): void;
}
