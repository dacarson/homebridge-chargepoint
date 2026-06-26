declare module 'fakegato-history' {
  import type { API, PlatformAccessory } from 'homebridge';

  interface HistoryEntry {
    time: number;   // Unix seconds
    power?: number; // Watts
  }

  interface HistoryOptions {
    size?: number;
    storage?: 'fs' | 'googleDrive';
    path?: string;
    filename?: string;
  }

  class FakeGatoHistoryService {
    addEntry(entry: HistoryEntry): void;
  }

  type ServiceConstructor = new (
    type: string,
    accessory: PlatformAccessory,
    options?: HistoryOptions,
  ) => FakeGatoHistoryService;

  function init(api: API): ServiceConstructor;
  export = init;
}
