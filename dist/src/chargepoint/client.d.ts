import type { Logger } from 'homebridge';
import { HomeChargerStatus, HomeChargerTechnicalInfo, HomeChargerConfiguration, UserChargingStatus, ChargingSession } from './types';
export declare class ChargePointClient {
    private jar;
    private http;
    private globalConfig;
    private userId?;
    private username;
    private readonly log;
    constructor(username: string, log: Logger);
    getCoulombToken(): string | undefined;
    setCoulombToken(token: string): void;
    private _persistToken;
    private _headers;
    private _request;
    private _raiseForStatus;
    discoverRegion(username: string): Promise<void>;
    loginWithPassword(password: string): Promise<void>;
    private _initAccountParameters;
    getAccount(): Promise<{
        userId: number;
        username: string;
    }>;
    getHomeChargers(): Promise<number[]>;
    getHomeChargerStatus(chargerId: number): Promise<HomeChargerStatus>;
    getHomeChargerTechnicalInfo(chargerId: number): Promise<HomeChargerTechnicalInfo>;
    getHomeChargerConfig(chargerId: number): Promise<HomeChargerConfiguration>;
    getUserChargingStatus(): Promise<UserChargingStatus | null>;
    getChargingSession(sessionId: number): Promise<ChargingSession>;
    startChargingSessionAsync(deviceId: number): Promise<ChargingSession>;
    stopChargingSessionAsync(deviceId: number, portNumber: number, sessionId: number): Promise<void>;
    setAmperageLimit(chargerId: number, amps: number): Promise<void>;
    private _sendCommand;
}
