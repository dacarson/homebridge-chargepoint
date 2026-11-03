# Changelog

## 1.3.0

### Changed defaults

- **Eve power/energy values are now throttled by default.** The new `evePowerUpdates` setting controls how the Eve Current Consumption, Total Consumption, Voltage and Electric Current values are pushed to HomeKit. The default, `throttled`, pushes a change only when power moves by at least 25 W or 2% (whichever is larger), energy by at least 0.1 kWh, or 5 minutes have passed since the last push. Previous versions pushed every change; set `evePowerUpdates` to `"live"` to keep that behavior. Eve and Home+ automations that trigger on these values keep working, with values accurate to within the threshold. See [Eve power & energy updates](README.md#eve-power--energy-updates).
- **Matter energy events are now sent at most every 15 minutes while nothing changes.** The cumulative energy total is sent only when it changes or as a 15-minute heartbeat, and periodic energy is reported once per 15-minute period (or immediately when charging starts) instead of on every poll. This is not configurable.

### Added

- `evePowerUpdates`: `"throttled"` (default), `"pollOnly"` (never push; lowest traffic, but breaks automations triggered by these values) or `"live"`.
- `minChangeWatts` (25), `minChangePercent` (2) and `minChangeKwh` (0.1) thresholds for throttled mode.
- Debug logging of suppressed Eve updates, and an hourly summary of sent vs suppressed updates.
- Unit tests (`npm test`).

### Unchanged

- The On and Outlet In Use characteristics still update immediately, so Home app automations are unaffected.
- The correct current values are reported as soon as the plugin starts, in every mode.

## 1.2.3

- Fixed a phantom ~9.6 kW power reading while a charging session was ending.

## 1.2.2

- Added debug logging of the raw charger status.

## 1.2.1

- Start/stop failures now log the reason ChargePoint gives.
- The switch no longer reverts while a start/stop command is still being confirmed.

## 1.2.0

- Restored starting and stopping charging from the Home app.
