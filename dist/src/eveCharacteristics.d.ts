import type { HAP } from 'homebridge';
export interface EveCharacteristicFactories {
    CurrentConsumption: () => InstanceType<HAP['Characteristic']>;
    TotalConsumption: () => InstanceType<HAP['Characteristic']>;
    Voltage: () => InstanceType<HAP['Characteristic']>;
    ElectricCurrent: () => InstanceType<HAP['Characteristic']>;
}
export declare function buildEveCharacteristics(hap: HAP): EveCharacteristicFactories;
export declare function safeW(powerKw: number): number;
export declare function safeA(powerKw: number): number;
