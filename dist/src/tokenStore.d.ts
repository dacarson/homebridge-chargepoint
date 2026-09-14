export declare function initStore(storagePath: string): Promise<void>;
export declare function loadToken(): Promise<string | undefined>;
export declare function saveToken(token: string): Promise<void>;
export declare function clearToken(): Promise<void>;
export declare function loadLifetimeKwh(chargerId: number): Promise<number>;
export declare function saveLifetimeKwh(chargerId: number, kwh: number): Promise<void>;
