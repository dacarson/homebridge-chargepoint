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
  session_id: number | null;
  state: string;      // "in_use", "waiting", "fully_charged", or ""
  stations: Array<{ id: number }>;
}

export interface UpdateDataPoint {
  energy_kwh: number;
  power_kw: number;
  timestamp: number; // milliseconds
}

export interface ChargingSession {
  session_id: number;
  device_id: number;
  outlet_number: number;
  power_kw: number;
  energy_kwh: number;
  charging_state: string;
  update_data: UpdateDataPoint[];
}

