import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'homebridge';
import { Characteristic, Formats, Perms } from 'hap-nodejs';
import {
  DEFAULT_EVE_UPDATE_SETTINGS,
  EVE_MAX_PUSH_INTERVAL_MS,
  EVE_STATS_INTERVAL_MS,
  EveUpdateGroup,
  EveUpdateSettings,
  anyChange,
  kwhThreshold,
  resolveEveUpdateSettings,
  wattsThreshold,
} from '../src/eveUpdates';

interface FakeLog { log: Logger; info: string[]; warn: string[]; debug: string[] }

function fakeLog(): FakeLog {
  const info: string[] = [];
  const warn: string[] = [];
  const debug: string[] = [];
  const log = {
    info: (m: string) => info.push(m),
    warn: (m: string) => warn.push(m),
    debug: (m: string) => debug.push(m),
    error() {},
  } as unknown as Logger;
  return { log, info, warn, debug };
}

function makeChar(perms = [Perms.PAIRED_READ, Perms.NOTIFY]): { char: Characteristic; pushed: number[] } {
  const char = new Characteristic('Test', '00000000-0000-0000-0000-000000000001', {
    format: Formats.FLOAT, minValue: 0, maxValue: 1_000_000, perms,
  });
  char.value = 0;
  // Only updateValue() pushes count; reads emit change events with reason "read".
  const pushed: number[] = [];
  char.on('change', change => { if (change.reason === 'update') pushed.push(change.newValue as number); });
  return { char, pushed };
}

const settings = (overrides: Partial<EveUpdateSettings> = {}): EveUpdateSettings => ({ ...DEFAULT_EVE_UPDATE_SETTINGS, ...overrides });

describe('Eve power update modes', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2, 12, 0, 0) }));
  afterEach(() => mock.timers.reset());

  describe('live', () => {
    it('pushes every change, starting with the first reading', () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings({ mode: 'live' }), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      for (const w of [9600, 9601, 9601, 9590, 0]) watts.update(w);
      assert.deepEqual(pushed, [9600, 9601, 9590, 0]);
      assert.ok(char.props.perms.includes(Perms.NOTIFY));
    });
  });

  describe('throttled', () => {
    it('reports the first reading immediately on startup', () => {
      const { char, pushed } = makeChar();
      new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings())).update(7200);
      assert.deepEqual(pushed, [7200]);
    });

    it('uses the 25 W floor at low power', () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(0);
      watts.update(20); // < 25 W
      watts.update(30); // 30 W from the last push (0)
      assert.deepEqual(pushed, [0, 30]);
    });

    it('uses the 2% threshold at high power', () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(5000); // 2% = 100 W
      watts.update(5060);
      watts.update(5099);
      watts.update(5100);
      assert.deepEqual(pushed, [5000, 5100]);
    });

    it('applies the kWh threshold, measured from the last push', () => {
      const { char, pushed } = makeChar();
      const kwh = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'kWh', kwhThreshold(settings()));
      kwh.update(100.0);
      kwh.update(100.05);
      kwh.update(100.09);
      kwh.update(100.1); // exactly 0.1 despite float error
      assert.deepEqual(pushed, [100.0, 100.1]);
    });

    it('pushes a sub-threshold change once 5 minutes have passed since the last push', () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(1000);
      watts.update(1010);
      mock.timers.tick(EVE_MAX_PUSH_INTERVAL_MS - 1);
      watts.update(1010);
      assert.deepEqual(pushed, [1000]);
      mock.timers.tick(1);
      watts.update(1010);
      assert.deepEqual(pushed, [1000, 1010]);
    });

    it('never pushes or counts an unchanged reading, even after 5 minutes', () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(0);
      for (let i = 0; i < 40; i++) {
        mock.timers.tick(15_000);
        watts.update(0);
      }
      assert.deepEqual(pushed, [0]);
      assert.equal(watts.suppressed, 0);
    });

    it('debug-logs suppressed updates', () => {
      const { char } = makeChar();
      const l = fakeLog();
      const watts = new EveUpdateGroup(settings(), l.log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(1000);
      watts.update(1010);
      assert.equal(l.debug.length, 1);
      assert.match(l.debug[0], /Suppressed watts update 1000 -> 1010/);
    });

    it('treats every change as significant for anyChange readings', () => {
      const { char, pushed } = makeChar();
      const amps = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'amps', anyChange);
      for (const a of [0, 40, 40, 0]) amps.update(a);
      assert.deepEqual(pushed, [0, 40, 0]);
    });

    it('serves the last pushed value on read, so reads cannot bypass the throttle', async () => {
      const { char } = makeChar();
      const watts = new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      watts.update(1000);
      watts.update(1010);
      assert.equal(await char.handleGetRequest(), 1000);
    });
  });

  describe('pollOnly', () => {
    it('removes NOTIFY, never pushes, and serves the newest reading on read', async () => {
      const { char, pushed } = makeChar();
      const watts = new EveUpdateGroup(settings({ mode: 'pollOnly' }), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      assert.deepEqual(char.props.perms, [Perms.PAIRED_READ]);

      watts.update(7200); // startup reading is available immediately
      assert.equal(await char.handleGetRequest(), 7200);
      watts.update(7213);
      assert.equal(await char.handleGetRequest(), 7213);
      assert.deepEqual(pushed, []);
    });

    it('restores NOTIFY when a cached pollOnly characteristic is switched back to throttled', () => {
      const { char } = makeChar([Perms.PAIRED_READ]);
      new EveUpdateGroup(settings(), fakeLog().log).add(char, 'watts', wattsThreshold(settings()));
      assert.deepEqual(char.props.perms, [Perms.PAIRED_READ, Perms.NOTIFY]);
    });
  });

  describe('hourly summary', () => {
    it('logs sent vs suppressed once an hour and resets the counts', () => {
      const l = fakeLog();
      const group = new EveUpdateGroup(settings(), l.log);
      const watts = group.add(makeChar().char, 'watts', wattsThreshold(settings()));
      const kwh = group.add(makeChar().char, 'kWh', kwhThreshold(settings()));

      watts.update(1000); // sent
      watts.update(1010); // suppressed
      watts.update(2000); // sent
      kwh.update(5); // sent
      kwh.update(5.01); // suppressed

      mock.timers.tick(EVE_STATS_INTERVAL_MS - 1);
      group.logStatsIfDue();
      assert.equal(l.info.length, 0);

      mock.timers.tick(1);
      group.logStatsIfDue();
      assert.equal(l.info.length, 1);
      assert.match(l.info[0], /3 updates sent, 2 suppressed/);
      assert.match(l.info[0], /watts 2\/1, kWh 1\/1/);
      assert.equal(watts.sent + watts.suppressed + kwh.sent + kwh.suppressed, 0);
    });

    it('stays quiet for an hour with no changes', () => {
      const l = fakeLog();
      const group = new EveUpdateGroup(settings(), l.log);
      group.add(makeChar().char, 'watts', wattsThreshold(settings()));
      mock.timers.tick(EVE_STATS_INTERVAL_MS);
      group.logStatsIfDue();
      assert.equal(l.info.length, 0);
    });
  });
});

describe('resolveEveUpdateSettings', () => {
  it('defaults to throttled with 25 W / 2% / 0.1 kWh', () => {
    assert.deepEqual(resolveEveUpdateSettings({}, fakeLog().log), {
      mode: 'throttled', minChangeWatts: 25, minChangePercent: 2, minChangeKwh: 0.1,
    });
  });

  it('accepts valid overrides', () => {
    const s = resolveEveUpdateSettings({ evePowerUpdates: 'live', minChangeWatts: 50, minChangePercent: 0, minChangeKwh: 0.5 }, fakeLog().log);
    assert.deepEqual(s, { mode: 'live', minChangeWatts: 50, minChangePercent: 0, minChangeKwh: 0.5 });
  });

  it('warns and falls back on invalid values', () => {
    const l = fakeLog();
    const s = resolveEveUpdateSettings({ evePowerUpdates: 'sometimes', minChangeWatts: -5, minChangeKwh: 'x' }, l.log);
    assert.deepEqual(s, DEFAULT_EVE_UPDATE_SETTINGS);
    assert.equal(l.warn.length, 3);
  });
});
