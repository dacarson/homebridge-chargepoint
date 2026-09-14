import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { ChargePointClient } from './chargepoint/client';
import type { HomeChargerTechnicalInfo, ChargingSession } from './chargepoint/types';
export interface AccessoryContext {
    chargerId: number;
    displayName: string;
    lastBackfilledSessionId?: number;
}
export declare class ChargePointAccessory {
    private readonly api;
    private readonly log;
    private readonly platformAccessory;
    private readonly client;
    readonly chargerId: number;
    private readonly outletService;
    private readonly charOn;
    private readonly charOutletInUse;
    private readonly charCurrentConsumption;
    private readonly charTotalConsumption;
    private readonly charVoltage;
    private readonly charElectricCurrent;
    private status;
    private session;
    private lastSession;
    private persistedBaseKwh;
    private lifetimeKwh;
    private historyService;
    private _lastBackfilledSessionId;
    private _lastIdleHistoryTime;
    private _lastStoredHistoryPower;
    private static readonly IDLE_HISTORY_INTERVAL_MS;
    private matter;
    constructor(api: API, log: Logger, platformAccessory: PlatformAccessory, client: ChargePointClient, matterEnabled?: boolean);
    private _readings;
    private _getOrAdd;
    initTechInfo(techInfo: HomeChargerTechnicalInfo): Promise<void>;
    refresh(session: ChargingSession | null): Promise<void>;
    private _updateCharacteristics;
    private _updateHistory;
    markNoResponse(): void;
}
