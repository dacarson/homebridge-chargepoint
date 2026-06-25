import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { ChargePointClient } from './chargepoint/client';
import type { HomeChargerTechnicalInfo, ChargingSession } from './chargepoint/types';
export interface AccessoryContext {
    chargerId: number;
    displayName: string;
}
export declare class ChargePointAccessory {
    private readonly api;
    private readonly log;
    private readonly platformAccessory;
    private readonly client;
    private readonly onRapidRefresh;
    readonly chargerId: number;
    private readonly outletService;
    private readonly eve;
    private status;
    private session;
    private lastSession;
    private persistedBaseKwh;
    private lifetimeKwh;
    commandInFlight: boolean;
    get isCharging(): boolean;
    constructor(api: API, log: Logger, platformAccessory: PlatformAccessory, client: ChargePointClient, onRapidRefresh: () => void);
    initTechInfo(techInfo: HomeChargerTechnicalInfo): Promise<void>;
    refresh(session: ChargingSession | null): Promise<void>;
    private _updateCharacteristics;
    markNoResponse(): void;
    private _handleSetOn;
}
