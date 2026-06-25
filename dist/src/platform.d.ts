import type { API, DynamicPlatformPlugin, Logger, PlatformConfig, PlatformAccessory } from 'homebridge';
export declare class ChargePointPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    private readonly rawConfig;
    readonly api: API;
    private readonly accessories;
    private readonly cachedPlatformAccessories;
    private client;
    private pollTimer?;
    private rapidRefreshRemaining;
    private captchaBackoffUntil;
    private authBackoffUntil;
    private get config();
    constructor(log: Logger, rawConfig: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private init;
    private _authFlow;
    private _passwordLogin;
    private _discoverDevices;
    private _registerOrRestoreAccessory;
    private _startPolling;
    private _scheduleNextPoll;
    private _nextIntervalMs;
    scheduleRapidRefresh(): void;
    private _pollCycle;
    private _handleMidPollInvalidSession;
    private _handleDatadomeCaptcha;
    private _markAllNoResponse;
}
