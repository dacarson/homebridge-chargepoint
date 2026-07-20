# homebridge-chargepoint

A native [Homebridge](https://homebridge.io) dynamic platform plugin that exposes a **ChargePoint Home Flex** EV charger as an **Eve Energy** accessory in HomeKit.

ChargePoint allows only one home charger per account, so the plugin exposes exactly one charger — the one registered to your account.

## Disclaimer

This project is not affiliated with, endorsed by, or supported by ChargePoint in any way. It relies on an unofficial API that may change or break at any time. Use at your own risk. ChargePoint is a registered trademark of ChargePoint, Inc.

## Features

- Real-time power consumption, current, and voltage in the Eve app's energy graphs
- Lifetime kWh accumulator (monotonic — Eve's history graphs work correctly)
- Start and stop charging from HomeKit or automations
- Plug detection via `OutletInUse`
- "No Response" when the charger is offline — no stale data
- Automatic session token persistence so Homebridge restarts don't trigger Datadome bot-protection
- Built-in CAPTCHA recovery UI in Homebridge's Config UI X **Setup** tab

## HomeKit Accessory

The charger appears as a single **Outlet** accessory (the service type Eve Energy uses):

| Characteristic | Description |
|---|---|
| On (read/write) | `true` while charging; writing starts or stops a session |
| Outlet In Use (read-only) | `true` when a vehicle is plugged in |
| Current Consumption | Instantaneous draw in watts |
| Total Consumption | Lifetime energy in kWh (persistent across restarts) |
| Voltage | Fixed 240 V (L2) |
| Electric Current | Configured charging amperage limit in amps (0 when not charging) |

The Eve-specific characteristics use Eve's exact UUIDs so the Eve app renders energy graphs and history automatically.

> **Note on voltage:** The ChargePoint API does not report input voltage anywhere (status, session, or config). The Home Flex accepts **208 or 240 V AC single-phase** input, but this is fixed by the electrical service at install (240 V for typical single-family homes, 208 V for some multi-family/commercial buildings) — it is not a configurable or queryable setting. Only the **amperage** limit is adjustable. The plugin therefore reports a fixed **240 V**.

## Requirements

- **Node.js** ≥ 24.16.0
- **Homebridge** ≥ 2.1.0
- A ChargePoint Home Flex (or compatible Home charger)
- Homebridge Config UI X (strongly recommended for the custom Setup tab)

## Installation

```bash
npm install -g homebridge-chargepoint
```

Or install through the Homebridge Config UI X plugin search.

## Configuration

### Option A — Config UI X Setup tab (recommended)

1. Install the plugin.
2. Open **Plugins → ChargePoint → Settings**.
3. Switch to the **Setup** tab.
4. Enter your ChargePoint email and password and click **Connect**.
5. Save and restart Homebridge.

The Setup tab handles first-run authentication and CAPTCHA recovery without you ever touching the terminal.

### Option B — Manual config.json

```json
{
  "platform": "ChargePoint",
  "name": "ChargePoint",
  "username": "you@example.com",
  "password": "your-password",
  "pollingIntervalSeconds": 30
}
```

#### All options

| Key | Type | Default | Description |
|---|---|---|---|
| `username` | string | **required** | ChargePoint account email |
| `password` | string | **required** | ChargePoint account password |
| `pollingIntervalSeconds` | integer | `30` | How often to poll for status (minimum 10 s) |

The plugin automatically discovers the single home charger registered to your account — no charger ID configuration is needed.

## Authentication and Token Persistence

ChargePoint's login endpoint is protected by Datadome bot-detection. Repeated programmatic logins (e.g. on every Homebridge restart) can trigger a CAPTCHA lockout.

To avoid this, the plugin stores the long-lived `coulomb_sess` session cookie between restarts. As long as Homebridge is running regularly, the cookie refreshes itself on every API call and should never expire.

Your `username` and `password` remain in the config as a fallback for the rare case where the stored token expires and a fresh login is needed.

### CAPTCHA recovery

If the plugin is ever blocked by Datadome:

1. Open **Homebridge Config UI X → Plugins → ChargePoint → Setup**.
2. The tab opens directly to the recovery screen.
3. Either:
   - Click **Open captcha in new tab**, solve it, then click **I've solved it — try again**.
   - Or follow the manual **DevTools** instructions to copy the `coulomb_sess` cookie and paste it into the field.

Once the token is saved, restart Homebridge and the plugin resumes normally.

## Polling Intervals

| Condition | Interval |
|---|---|
| Idle / plugged in but not charging | `pollingIntervalSeconds` (default 30 s) |
| Actively charging | 15 s |
| Command just issued (start/stop) | 5 s × 3 polls |
| Datadome CAPTCHA encountered | 5-minute backoff |
| Session expired and re-auth failed | 15-minute backoff |

## Charging Control

Writing `On = true` in HomeKit fires a start-session command. Writing `On = false` fires a stop command. Both are **fire-and-forget**: HomeKit receives an acknowledgement immediately and the next poll reflects the real state, so the toggle never shows as failed even when the charger takes a few seconds to respond.

> **Note:** Stopping requires an active session to be known. If the plugin has just started and hasn't polled yet, a stop request is logged and ignored; the next poll will reflect the true state.

## Energy History (Eve)

`TotalConsumption` is a **lifetime cumulative kWh meter**, not a per-session value. This matches what Eve expects — Eve calculates period usage by differencing readings, so the value must grow monotonically and never reset to zero.

The plugin persists a base accumulator in Homebridge's storage directory. On each poll while a session is active it adds the session's live energy on top. When a session ends, the final session energy is committed to the base. The history begins from the plugin's first run.

## Development

```bash
git clone <this-repo>
cd homebridge-chargepoint
npm install
npm run build        # compile TypeScript → dist/
npm run watch        # watch mode
```

The Python library in `python-chargepoint/` is the authoritative API reference. There is no Python runtime dependency — all HTTP logic is ported to TypeScript in `src/chargepoint/client.ts`.

### Project layout

```
src/
  index.ts                  registers the platform with Homebridge
  platform.ts               ChargePointPlatform — device discovery, polling, error recovery
  accessory.ts              ChargePointAccessory — Eve Energy outlet wrapper
  tokenStore.ts             node-persist wrapper (session token, flags, lifetime kWh)
  eveCharacteristics.ts     custom HAP characteristics matching Eve Energy UUIDs
  chargepoint/
    client.ts               ChargePoint HTTP client (axios + tough-cookie)
    types.ts                TypeScript types for API responses
    globalConfig.ts         region discovery and endpoint model
    constants.ts            discovery API URL, cookie names
    errors.ts               LoginError, InvalidSession, DatadomeCaptcha, CommunicationError
homebridge-ui/
  server.ts                 HomebridgePluginUiServer — auth endpoints for the Setup tab
  server.js                 shim → dist/homebridge-ui/server.js
  public/
    index.html              custom auth setup page (no build step required)
config.schema.json
package.json
tsconfig.json
```

## Acknowledgements

The ChargePoint API client in this plugin is a TypeScript port of [**python-chargepoint**](https://github.com/mbillow/python-chargepoint) by [Marc Billow](https://github.com/mbillow). That project is the authoritative reference for ChargePoint's API and made this plugin possible. Many thanks to Marc and its contributors.

## License

MIT
