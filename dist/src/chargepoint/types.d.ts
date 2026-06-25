export interface HomeChargerStatus {
    charger_id: number;
    charging_status: string;
    is_plugged_in: boolean;
    is_connected: boolean;
    amperage_limit: number;
    possible_amperage_limits: number[];
}
export interface HomeChargerTechnicalInfo {
    model_number: string;
    serial_number: string;
    software_version: string;
}
export interface HomeChargerConfiguration {
    station_nickname: string;
}
export interface UserChargingStatus {
    session_id: number;
    stations: Array<{
        id: number;
    }>;
}
export interface ChargingSession {
    session_id: number;
    device_id: number;
    outlet_number: number;
    power_kw: number;
    energy_kwh: number;
    charging_state: string;
}
