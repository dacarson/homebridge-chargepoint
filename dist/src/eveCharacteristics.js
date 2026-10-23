"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEveCharacteristics = buildEveCharacteristics;
exports.safeW = safeW;
function buildEveCharacteristics(hap) {
    const CurrentConsumption = () => {
        const c = new hap.Characteristic('Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', { format: "float" /* Formats.FLOAT */, minValue: 0, maxValue: 100000, perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */] });
        c.value = 0;
        return c;
    };
    const TotalConsumption = () => {
        const c = new hap.Characteristic('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', { format: "float" /* Formats.FLOAT */, minValue: 0, maxValue: 1000000, perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */] });
        c.value = 0;
        return c;
    };
    const Voltage = () => {
        const c = new hap.Characteristic('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', { format: "float" /* Formats.FLOAT */, minValue: 0, maxValue: 300, perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */] });
        c.value = 0;
        return c;
    };
    const ElectricCurrent = () => {
        const c = new hap.Characteristic('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', { format: "float" /* Formats.FLOAT */, minValue: 0, maxValue: 100, perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */] });
        c.value = 0;
        return c;
    };
    return { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent };
}
function safeW(powerKw) {
    const w = powerKw * 1000;
    return Number.isFinite(w) ? w : 0;
}
