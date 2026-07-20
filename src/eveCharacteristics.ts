import type { HAP } from 'homebridge';
import { Formats, Perms } from 'hap-nodejs';

export interface EveCharacteristicFactories {
  CurrentConsumption: () => InstanceType<HAP['Characteristic']>;
  TotalConsumption: () => InstanceType<HAP['Characteristic']>;
  Voltage: () => InstanceType<HAP['Characteristic']>;
  ElectricCurrent: () => InstanceType<HAP['Characteristic']>;
}

export function buildEveCharacteristics(hap: HAP): EveCharacteristicFactories {
  const CurrentConsumption = (): InstanceType<HAP['Characteristic']> => {
    const c = new hap.Characteristic(
      'Current Consumption',
      'E863F10D-079E-48FF-8F27-9C2605A29F52',
      { format: Formats.FLOAT, minValue: 0, maxValue: 100000, perms: [Perms.PAIRED_READ, Perms.NOTIFY] },
    );
    c.value = 0;
    return c;
  };

  const TotalConsumption = (): InstanceType<HAP['Characteristic']> => {
    const c = new hap.Characteristic(
      'Total Consumption',
      'E863F10C-079E-48FF-8F27-9C2605A29F52',
      { format: Formats.FLOAT, minValue: 0, maxValue: 1000000, perms: [Perms.PAIRED_READ, Perms.NOTIFY] },
    );
    c.value = 0;
    return c;
  };

  const Voltage = (): InstanceType<HAP['Characteristic']> => {
    const c = new hap.Characteristic(
      'Voltage',
      'E863F10A-079E-48FF-8F27-9C2605A29F52',
      { format: Formats.FLOAT, minValue: 0, maxValue: 300, perms: [Perms.PAIRED_READ, Perms.NOTIFY] },
    );
    c.value = 0;
    return c;
  };

  const ElectricCurrent = (): InstanceType<HAP['Characteristic']> => {
    const c = new hap.Characteristic(
      'Electric Current',
      'E863F126-079E-48FF-8F27-9C2605A29F52',
      { format: Formats.FLOAT, minValue: 0, maxValue: 100, perms: [Perms.PAIRED_READ, Perms.NOTIFY] },
    );
    c.value = 0;
    return c;
  };

  return { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent };
}

export function safeW(powerKw: number): number {
  const w = powerKw * 1000;
  return Number.isFinite(w) ? w : 0;
}
