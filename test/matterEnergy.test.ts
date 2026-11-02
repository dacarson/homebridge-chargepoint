import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { API, Logger } from 'homebridge';
import { ENERGY_REPORT_INTERVAL_S, MatterEnergyBridge } from '../src/matterEnergy';

const POLL_MS = 15_000;
const POLLS_PER_PERIOD = (ENERGY_REPORT_INTERVAL_S * 1000) / POLL_MS;

interface PeriodicEnergy { energy: number; startTimestamp?: number; endTimestamp?: number }
interface EnergyState {
  cumulativeEnergyImported?: { energy: number };
  periodicEnergyImported?: PeriodicEnergy;
}
interface Call { cluster: string; state: unknown }

const silentLog = { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger;

function makeBridge(calls: Call[], failEnergy: () => boolean = () => false): MatterEnergyBridge {
  const api = {
    matter: {
      deviceTypes: { ElectricalSensor: {} },
      registerPlatformAccessories: async () => {},
      updateAccessoryState: async (_uuid: string, cluster: string, state: unknown) => {
        if (cluster === 'electricalEnergyMeasurement' && failEnergy()) throw new Error('boom');
        calls.push({ cluster, state });
      },
      uuid: { generate: (seed: string) => seed },
    },
  };
  return new MatterEnergyBridge(api as unknown as API, silentLog);
}

const readings = (energyWh: number, powerW = 0) => ({ voltageV: 240, currentA: powerW > 0 ? 40 : 0, powerW, energyWh });

// Energy updates recorded since the given call index.
const energyUpdates = (calls: Call[], from = 0): EnergyState[] =>
  calls.slice(from).filter(c => c.cluster === 'electricalEnergyMeasurement').map(c => c.state as EnergyState);

const nowS = () => Math.floor(Date.now() / 1000);

describe('MatterEnergyBridge energy event rate', () => {
  let calls: Call[];
  let bridge: MatterEnergyBridge;

  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2, 12, 0, 0) });
    calls = [];
  });

  afterEach(() => mock.timers.reset());

  async function poll(energyWh: number, powerW = 0): Promise<EnergyState[]> {
    mock.timers.tick(POLL_MS);
    const from = calls.length;
    await bridge.update(readings(energyWh, powerW));
    return energyUpdates(calls, from);
  }

  async function start(energyWh: number): Promise<EnergyState> {
    bridge = makeBridge(calls);
    assert.equal(await bridge.register(1, 'Test', readings(energyWh)), true);
    const [first] = await poll(energyWh);
    return first;
  }

  it('sends both readings on the first update after registration', async () => {
    const registeredS = nowS();
    const first = await start(1000);
    assert.deepEqual(first.cumulativeEnergyImported, { energy: 1_000_000 });
    assert.deepEqual(first.periodicEnergyImported, { energy: 0, startTimestamp: registeredS, endTimestamp: registeredS + 15 });
  });

  it('emits nothing while idle except the 15-minute heartbeat', async () => {
    await start(1000);
    const from = calls.length;

    for (let i = 0; i < 4 * POLLS_PER_PERIOD; i++) await poll(1000);

    const updates = energyUpdates(calls, from);
    assert.equal(updates.length, 4, 'one energy update per 15 minutes over an hour');
    for (const u of updates) {
      assert.deepEqual(u.cumulativeEnergyImported, { energy: 1_000_000 });
      assert.equal(u.periodicEnergyImported?.energy, 0);
      assert.equal(u.periodicEnergyImported!.endTimestamp! - u.periodicEnergyImported!.startTimestamp!, ENERGY_REPORT_INTERVAL_S);
    }

    // The power cluster (live watts) is still refreshed on every poll.
    const powerUpdates = calls.slice(from).filter(c => c.cluster === 'electricalPowerMeasurement');
    assert.equal(powerUpdates.length, 4 * POLLS_PER_PERIOD);
  });

  it('sums periodic energy across polls into one contiguous period', async () => {
    await start(1000);
    let energy = 1000;

    // Charging starts: the first poll with energy flowing emits early (activation).
    energy += 25;
    const [activation] = await poll(energy, 9600);
    assert.equal(activation.periodicEnergyImported?.energy, 25_000);

    // A full period of charging at 25 Wh per poll.
    const from = calls.length;
    for (let i = 0; i < POLLS_PER_PERIOD; i++) {
      energy += 25;
      await poll(energy, 9600);
    }

    const periodic = energyUpdates(calls, from).map(u => u.periodicEnergyImported).filter(p => p !== undefined);
    assert.equal(periodic.length, 1, 'one periodic event for the whole period');
    assert.equal(periodic[0].energy, POLLS_PER_PERIOD * 25 * 1000);
    assert.equal(periodic[0].startTimestamp, activation.periodicEnergyImported!.endTimestamp, 'periods are contiguous');
    assert.equal(periodic[0].endTimestamp! - periodic[0].startTimestamp!, ENERGY_REPORT_INTERVAL_S);

    // The cumulative total is reported whenever it changes.
    const cumulative = energyUpdates(calls, from).filter(u => u.cumulativeEnergyImported).length;
    assert.equal(cumulative, POLLS_PER_PERIOD);
  });

  it('emits promptly on idle -> active once energy starts flowing', async () => {
    await start(1000);
    for (let i = 0; i < 4; i++) assert.deepEqual(await poll(1000), []);

    // Power is reported before the energy total moves: nothing to report yet.
    assert.deepEqual(await poll(1000, 9600), []);

    // Energy arrives on the next poll: emitted immediately, well inside the period.
    const [update] = await poll(1010, 9600);
    assert.equal(update.periodicEnergyImported?.energy, 10_000);
    assert.deepEqual(update.cumulativeEnergyImported, { energy: 1_010_000 });

    // Further charging in the same period is accumulated, not emitted per poll.
    const [next] = await poll(1020, 9600);
    assert.equal(next.periodicEnergyImported, undefined);
    assert.deepEqual(next.cumulativeEnergyImported, { energy: 1_020_000 });
  });

  it('keeps the period open when an energy update fails', async () => {
    let failing = false;
    bridge = makeBridge(calls, () => failing);
    await bridge.register(1, 'Test', readings(1000));
    await poll(1000);
    const periodStartS = nowS();

    for (let i = 0; i < POLLS_PER_PERIOD - 1; i++) await poll(1000);
    failing = true;
    assert.deepEqual(await poll(1000), [], 'heartbeat update rejected');
    failing = false;

    const [retry] = await poll(1000);
    assert.equal(retry.periodicEnergyImported?.startTimestamp, periodStartS);
    assert.equal(retry.periodicEnergyImported?.endTimestamp, nowS());
  });
});
