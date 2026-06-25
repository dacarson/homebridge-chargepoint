# Homebridge ChargePoint Plugin — Specification

## Overview

A native Homebridge dynamic platform plugin written in TypeScript that exposes a ChargePoint Home Flex EV charger as an **Eve Energy** accessory in HomeKit. The Eve Energy representation surfaces real-time power consumption, total session energy, plug state, and charging state.

The Python library at `python-chargepoint/` serves as the authoritative reference for API communication. All HTTP logic is ported to TypeScript; there is no Python runtime dependency.

---

## Package

| Field | Value |
|---|---|
| npm name | `homebridge-chargepoint` |
| Language | TypeScript (ES2022, strict mode) |
| Node target | ≥ 18 |
| Peer deps | `homebridge >= 1.8.0`, `hap-nodejs >= 0.12.0` |
| Runtime deps | `axios` (HTTP), `tough-cookie` + `axios-cookiejar-support` (cookie jar), `node-persist` (token storage), `@homebridge/plugin-ui-utils` (custom setup UI) |
| Dev deps | `typescript`, `eslint`, `@homebridge/eslint-config` |
| `package.json` flag | `"customUi": true` — tells Config UI X to load `homebridge-ui/public/index.html` in a Setup tab |

---

## Directory Structure

```
src/
  index.ts                  registers the platform with Homebridge
  platform.ts               ChargePointPlatform — dynamic platform
  accessory.ts              ChargePointAccessory — Eve Energy wrapper
  chargepoint/
    client.ts               ChargePoint HTTP client (port of Python client.py)
    types.ts                TypeScript types (port of Python types.py)
    globalConfig.ts         Region discovery and endpoint model (port of global_config.py)
    constants.ts            DISCOVERY_API URL, cookie names, etc.
    errors.ts               LoginError, InvalidSession, DatadomeCaptcha, CommunicationError
  eveCharacteristics.ts     Custom HAP characteristics matching Eve Energy UUIDs
  tokenStore.ts             Reads/writes the coulomb_sess token to node-persist
homebridge-ui/
  public/
    index.html              custom auth setup page (loaded in Config UI X "Setup" tab)
  server.ts                 HomebridgePluginUiServer — handles auth requests from the UI
config.schema.json          Homebridge Config UI X schema
package.json
tsconfig.json
```

---

## HomeKit Accessory Model

Each configured charger is exposed as a single accessory with two services.

### Accessory Information Service

| Characteristic | Source |
|---|---|
| Manufacturer | `"ChargePoint"` |
| Model | `HomeChargerTechnicalInfo.model_number` |
| Serial Number | `HomeChargerTechnicalInfo.serial_number` |
| Firmware Revision | `HomeChargerTechnicalInfo.software_version` |
| Name | Config `name` or `HomeChargerConfiguration.station_nickname` |

### Outlet Service (Eve Energy)

The `Service.Outlet` UUID is what Eve uses for its Energy accessory type. Standard characteristics:

| Characteristic | Type | Source | Notes |
|---|---|---|---|
| `On` | bool (read/write) | `HomeChargerStatus.charging_status === "CHARGING"` | Writing `true` fires start; `false` fires stop. See fire-and-forget section. |
| `OutletInUse` | bool (read-only) | `HomeChargerStatus.is_plugged_in` | True when vehicle is connected |

Custom Eve Energy characteristics (registered by UUID so the Eve app renders energy graphs):

| Characteristic | UUID | Format | Unit | Source |
|---|---|---|---|---|
| `CurrentConsumption` | `E863F10D-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | W | `ChargingSession.power_kw * 1000`; 0 when no active session on this charger |
| `TotalConsumption` | `E863F10C-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | kWh | Persistent lifetime accumulator (see Eve energy history section) |
| `Voltage` | `E863F10A-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | V | Fixed `240.0` V for L2 chargers |
| `ElectricCurrent` | `E863F126-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | A | `power_kw * 1000 / 240.0`; 0 when not charging |

All four Eve characteristics are declared with `perms: [READ, NOTIFY]`.

> **Voltage and current**: `amperage_limit` is the configured maximum, not the instantaneous draw. Using it as `ElectricCurrent` would make `V × A ≠ W` in Eve's display whenever the car pulls less than the limit (which is normal). Instead, derive instantaneous current from `power_kw * 1000 / 240.0` — this is always consistent with `CurrentConsumption`, and voltage is a fixed 240 V. When `power_kw` is 0, current is also 0.

---

## Configuration Schema (`config.schema.json`)

```json
{
  "pluginAlias": "ChargePoint",
  "pluginType": "platform",
  "singular": false,
  "schema": {
    "type": "object",
    "required": ["username", "password"],
    "properties": {
      "name": { "title": "Platform Name", "type": "string", "default": "ChargePoint" },
      "username": { "title": "ChargePoint Username (email)", "type": "string" },
      "password": { "title": "ChargePoint Password", "type": "string" },
      "pollingIntervalSeconds": {
        "title": "Status Poll Interval (seconds)",
        "type": "integer", "default": 30, "minimum": 10
      },
      "devices": {
        "title": "Chargers",
        "type": "array",
        "items": {
          "type": "object",
          "required": ["chargerId"],
          "properties": {
            "chargerId": { "title": "Charger ID", "type": "integer" },
            "name":      { "title": "Display Name", "type": "string" }
          }
        }
      }
    }
  }
}
```

`required` is a JSON Schema array at the object level, not a per-field boolean. `devices` is optional — if omitted, the platform auto-discovers via `getHomeChargers()`.

`username` and `password` remain in config as credentials for mid-polling re-authentication (see Startup Auth Flow). The Custom Setup UI reads them from the saved config so the user only types them once.

---

## Custom Setup UI

Config UI X loads `homebridge-ui/public/index.html` in a dedicated **Setup** tab when `"customUi": true` is set in `package.json`. The page communicates with `homebridge-ui/server.ts` (a `HomebridgePluginUiServer` child process) via `window.homebridge.request()`. This UI handles all first-run authentication and Datadome recovery without the user ever touching the terminal.

### How it fits together

```
Browser (Config UI X "Setup" tab)
  │  window.homebridge.request('/auth/...')
  ▼
homebridge-ui/server.ts   (HomebridgePluginUiServer)
  │  imports tokenStore, ChargePointClient
  │  reads this.homebridgeStoragePath for node-persist dir
  ▼
ChargePoint API  +  node-persist store
  (same store read by the main plugin process on startup)
```

After the UI saves the token, the main plugin picks it up on the next Homebridge restart (or on startup if the user authenticates before Homebridge first runs).

### Server-Side Endpoints (`homebridge-ui/server.ts`)

```typescript
class ChargePointUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/auth/status',         this.handleStatus);
    this.onRequest('/auth/login',          this.handleLogin);
    this.onRequest('/auth/retry',          this.handleLogin);   // same logic, different UI meaning
    this.onRequest('/auth/validate-token', this.handleValidateToken);
    this.onRequest('/auth/clear',          this.handleClear);
    this.ready();
  }
}
```

| Endpoint | Body | Response |
|---|---|---|
| `POST /auth/status` | — | `{ state, username?, lastRefresh? }` |
| `POST /auth/login` | `{ username, password }` | `{ state, username? }` or `{ state: 'captcha', captchaUrl }` |
| `POST /auth/retry` | `{ username, password }` | same as `/auth/login` |
| `POST /auth/validate-token` | `{ username, token }` | `{ state, username? }` or `{ state: 'error', message }` |
| `POST /auth/clear` | — | `{ success: true }` |

`state` is one of: `'connected'` · `'disconnected'` · `'captcha'` · `'error'`.

**`/auth/status`**: reads the stored token; if one exists, calls `getAccount()` to verify it. Returns `'connected'` if valid, `'disconnected'` if absent or expired, `'error'` on network failure.

**`/auth/login`** and **`/auth/retry`**: calls `discoverRegion(username)` then `loginWithPassword(password)`. On success saves the token and returns `'connected'`. On `DatadomeCaptcha` returns `'captcha'` with the captcha URL. On other errors returns `'error'`.

**`/auth/validate-token`**: injects the pasted token into the cookie jar, calls `discoverRegion(username)` and `getAccount()` to verify. On success saves the token. On failure returns `'error'` with a message so the UI can prompt the user to re-copy the cookie.

**`/auth/clear`**: clears the stored token and the `captcha_blocked` flag.

### Auth Status Flag

When the main plugin process hits a Datadome lockout mid-poll, it writes `captcha_blocked: true` to node-persist in addition to logging. When the UI calls `/auth/status` and finds this flag set, it opens directly to the **CAPTCHA_BLOCKED** state so the user sees the recovery UI immediately on opening the Setup tab.

### UI State Machine

```
LOADING ──────────────────────────────────────────────────────────┐
  call /auth/status                                                │
  ├─ 'connected'      → CONNECTED                                 │
  ├─ 'captcha_blocked'→ CAPTCHA_BLOCKED  (flag set by main plugin)│
  └─ 'disconnected'   → DISCONNECTED ───────────────────────────── ┘

DISCONNECTED
  User sees: username field (pre-filled from config), password field, "Connect" button
  → "Connect" clicked → CONNECTING

CONNECTING
  call /auth/login { username, password }
  ├─ 'connected'   → CONNECTED
  ├─ 'captcha'     → CAPTCHA_BLOCKED (with captchaUrl from response)
  └─ 'error'       → ERROR

CONNECTED
  User sees: "✓ Connected as [username]" · last token refresh time · "Disconnect" button
  → "Disconnect" → call /auth/clear → DISCONNECTED

CAPTCHA_BLOCKED
  User sees:
    ⚠ "Automatic login was blocked by bot protection."
    [Open captcha in new tab]  → opens captchaUrl in new window
    [I've solved it — try again] → RETRYING
    ──── Manual login ────
    Step-by-step DevTools instructions (see below)
    Paste field for coulomb_sess value
    [Verify & Save] → VALIDATING_TOKEN

RETRYING
  call /auth/retry { username, password }
  ├─ 'connected'   → CONNECTED
  ├─ 'captcha'     → CAPTCHA_STILL_BLOCKED
  └─ 'error'       → ERROR

CAPTCHA_STILL_BLOCKED
  User sees:
    ✗ "Still blocked. Please use the manual login below."
    (manual section shown prominently, captcha link hidden)
    Paste field for coulomb_sess value
    [Verify & Save] → VALIDATING_TOKEN

VALIDATING_TOKEN
  call /auth/validate-token { username, token }
  ├─ 'connected' → CONNECTED
  └─ 'error'     → ERROR (show message, return to paste field with token preserved)

ERROR
  User sees: error message · "Try again" button → DISCONNECTED
```

### Manual Token Instructions (shown in CAPTCHA states)

Displayed as numbered steps inline in the UI:

1. Click **"Open ChargePoint in a new tab"** and log in with your ChargePoint credentials.
2. After logging in, press **F12** (or **Cmd ⌥ I** on Mac) to open Developer Tools.
3. Go to **Application** → **Storage** → **Cookies** → `https://driver.chargepoint.com`.
4. Find the cookie named **`coulomb_sess`**.
5. Click the value field and press **Ctrl+A** / **Cmd+A** to select all, then copy. The value contains `#` and `?` characters — copy the whole thing.
6. Paste it into the field below and click **Verify & Save**.

A direct link to `https://driver.chargepoint.com` is shown alongside the instructions so the user doesn't need to leave the tab to find it.

### UI Implementation Notes

- `homebridge-ui/public/index.html` uses plain HTML + the `@homebridge/plugin-ui-utils` client bundle (`window.homebridge`). No build step required for the UI assets.
- The `homebridge-ui/server.ts` is compiled by the main TypeScript build — it imports `tokenStore` and the ChargePoint client from `src/`, sharing code with the main plugin.
- `window.homebridge.getPluginConfig()` is called on load to pre-fill the username field from the saved config, so the user only needs to type their password.
- The paste field for `coulomb_sess` uses `type="password"` to prevent shoulder-surfing and avoid the value being stored in browser history.
- The token value is never echoed back to the UI after saving — the endpoint returns `state: 'connected'` and the UI transitions to the CONNECTED screen.

---

## Credential Token Persistence

### The Problem

ChargePoint's login endpoint is protected by Datadome bot-detection. Repeated programmatic logins (e.g. on every Homebridge restart) trigger a gateway captcha that blocks further access. The `coulomb_sess` session cookie is long-lived and is refreshed on every API response, so it should survive indefinitely as long as it is persisted between restarts.

### Storage Mechanism

Use `node-persist` initialized at `{api.user.storagePath}/chargepoint-plugin/`. The stored value is the raw (URL-encoded) cookie string exactly as returned by the server — decoding is done in the cookie jar layer, not in storage.

```typescript
// tokenStore.ts
import storage from 'node-persist';

const STORE_KEY = 'coulomb_token';
let _cached: string | undefined;

export async function initStore(storagePath: string): Promise<void> {
  await storage.init({ dir: `${storagePath}/chargepoint-plugin` });
  _cached = await storage.getItem(STORE_KEY);
}

export async function loadToken(): Promise<string | undefined> {
  return _cached;
}

export async function saveToken(token: string): Promise<void> {
  if (token === _cached) return;   // avoid unnecessary disk writes
  _cached = token;
  await storage.setItem(STORE_KEY, token);
}

export async function clearToken(): Promise<void> {
  _cached = undefined;
  await storage.removeItem(STORE_KEY);
}
```

The in-memory `_cached` value suppresses a disk write on every poll cycle when the token hasn't changed, avoiding write amplification (2–3 API calls × N chargers per poll).

### Cookie Jar and Token Handling

Use `tough-cookie` + `axios-cookiejar-support` as the cookie jar for the axios instance. This handles URL-encoding/decoding automatically. After each HTTP response, read the refreshed `coulomb_sess` value **from the jar** (not by parsing `Set-Cookie` headers manually — `Set-Cookie` is an array in Node and parsing it manually is error-prone):

```typescript
const jar = new CookieJar();
const axiosInstance = wrapper(axios.create({ jar }));

function getCoulombToken(): string | undefined {
  const cookies = jar.getCookiesSync('https://account.chargepoint.com/');
  return cookies.find(c => c.key === 'coulomb_sess')?.value;
}
```

To inject a stored token at startup, set it directly into the jar with the correct domain/path — mirroring the Python `_set_coulomb_token()`:

```typescript
function setCoulombToken(token: string): void {
  const cookie = new Cookie({
    key: 'coulomb_sess',
    value: token,          // store raw; tough-cookie handles encoding
    domain: '.chargepoint.com',
    path: '/',
    maxAge: 10 * 365 * 24 * 3600,
  });
  jar.setCookieSync(cookie, 'https://account.chargepoint.com/');
}
```

After each request, read the token from the jar and call `saveToken()` — the in-memory guard in `tokenStore` makes this cheap when the value hasn't changed.

The `cp-session-token` request header must be rebuilt from the jar value before each request (not set once at init), so it stays in sync as the cookie rotates:

```typescript
// Inside _request() before sending:
const token = getCoulombToken();
headers['cp-session-token'] = token ?? '';
```

### Startup Auth Flow

Region discovery (`POST https://discovery.chargepoint.com/discovery/v3/globalconfig`) is **always required** on startup — it returns the region-specific API endpoints that all subsequent calls depend on. It does not require authentication.

```
On platform startup:
  1. await discoverRegion(username)        // ALWAYS — retrieves globalConfig / endpoints
  2. storedToken = await tokenStore.loadToken()
  3a. storedToken exists:
        → setCoulombToken(storedToken) into jar
        → try: await getAccount()          // validates token AND populates userId
          catch InvalidSession (401):
            → log "stored token expired, re-authenticating"
            → goto step 3b
  3b. No token (or expired):
        → await loginWithPassword(username, password)
          → on success: saveToken(getCoulombToken())
          → on DatadomeCaptcha:
              saveFlag('captcha_blocked', true)   // UI reads this on next open
              log captcha URL at ERROR
              throw  (plugin fails to load; cached accessories show "No Response")
  4. Polling loop begins
  5. After every API response: saveToken(getCoulombToken())
```

**Normal case**: if the user authenticated via the Setup UI before Homebridge started, step 2 finds a valid token and step 3a succeeds — no password login ever happens.

**Why 401 on startup needs special handling**: `getAccount()` is the first authenticated call and it populates `userId`, which is embedded in every charger endpoint URL. If the stored token is stale, the 401 arrives here — before the mid-poll 401 handler is active — so it must be caught explicitly and fall through to password login.

### Mid-Polling 401 Recovery

If `InvalidSession` is thrown during a normal poll or command:

```
  → clearToken()
  → try loginWithPassword(password)
    → on success: retry the failed call once; clearFlag('captcha_blocked')
    → on DatadomeCaptcha:
        saveFlag('captcha_blocked', true)   // Setup UI reads this on next open
        log captcha URL at ERROR
        mark all accessories as "No Response" in HomeKit
        enter 5-minute backoff before retrying any API calls
        (do NOT keep retrying password login — each attempt makes the lockout worse)
```

**Limitation**: A token expiry during normal operation can cascade into a Datadome captcha lockout. Once this happens, the plugin is disabled until the user opens the Setup tab in Config UI X and completes the manual token flow. The `captcha_blocked` flag ensures the Setup tab opens directly to the recovery UI rather than the normal login screen.

---

## ChargePoint HTTP Client (TypeScript)

Port of `python-chargepoint/python_chargepoint/client.py`.

### Methods to Implement

| Method | Python equivalent | Notes |
|---|---|---|
| `discoverRegion(username)` | `_get_configuration()` | Called at startup, always |
| `loginWithPassword(password)` | `login_with_password()` | Sets cookie in jar, saves token |
| `getAccount()` | `get_account()` | Populates `userId` and region headers |
| `getHomeChargers()` | `get_home_chargers()` | Uses `userId` in URL |
| `getHomeChargerStatus(chargerId)` | `get_home_charger_status()` | Uses `userId` in URL |
| `getHomeChargerTechnicalInfo(chargerId)` | `get_home_charger_technical_info()` | |
| `getHomeChargerConfig(chargerId)` | `get_home_charger_config()` | |
| `getUserChargingStatus()` | `get_user_charging_status()` | Account-wide; see session matching |
| `getChargingSession(sessionId)` | `get_charging_session()` | |
| `startChargingSessionAsync(deviceId)` | `start_charging_session()` | Fire-and-forget wrapper |
| `stopChargingSessionAsync(deviceId, portNumber, sessionId)` | `session.stop()` | Fire-and-forget wrapper |
| `setAmperageLimit(chargerId, amps)` | `set_amperage_limit()` | |

### chargerId vs deviceId

`getHomeChargers()` returns HCM charger IDs (used in `/api/v1/configuration/users/{userId}/chargers/{chargerId}/...`). The session start/stop commands (`/v1/driver/station/startsession`) use `deviceId`. For ChargePoint Home Flex these are the same integer, but this is an empirical observation, not a documented guarantee.

**Implementation rule**: when starting a session, pass `chargerId` as `deviceId`. After a session starts, the `ChargingSession` object carries `device_id` from the session status API — use that `device_id` for the stop command, not the original `chargerId`. This avoids any mismatch.

---

## Session Matching (Account-Wide Status)

`getUserChargingStatus()` returns a single account-level status that includes a `stations` array of `{ id: number }` (the `deviceId` of the charger hosting the session). It does **not** return one status per charger.

```typescript
// In platform.pollAll():
const accountStatus = await client.getUserChargingStatus();

for (const [chargerId, accessory] of configuredAccessories) {
  const stationMatch = accountStatus?.stations.find(s => s.id === chargerId);
  if (stationMatch && accountStatus) {
    // This charger has the active session
    const session = await client.getChargingSession(accountStatus.sessionId);
    await accessory.refresh(session);
  } else {
    // No session on this charger
    await accessory.refresh(null);
  }
}
```

`getUserChargingStatus()` is called **once per poll cycle** at the platform level, not inside each accessory's `refresh()`. Each accessory receives its resolved session (or null) as a parameter. This avoids N redundant API calls and the wrong-session bug.

---

## Accessory (`accessory.ts`)

```
ChargePointAccessory
  - chargerId: number
  - status: HomeChargerStatus | null
  - session: ChargingSession | null    // set by platform, not fetched here
  - techInfo: HomeChargerTechnicalInfo | null

  refresh(session: ChargingSession | null):
    → status = await client.getHomeChargerStatus(chargerId)
    → if !status.is_connected:
        markNoResponse()
        return
    → this.session = session
    → updateCharacteristics()

  updateCharacteristics():
    → isCharging = status.charging_status === "CHARGING"
    → powerW    = isCharging ? (session?.power_kw ?? 0) * 1000 : 0
    → currentA  = powerW / 240.0     // always consistent with power; 0 when not charging
    → outletService.updateCharacteristic(On, isCharging)
    → outletService.updateCharacteristic(OutletInUse, status.is_plugged_in)
    → outletService.updateCharacteristic(CurrentConsumption, powerW)
    → outletService.updateCharacteristic(TotalConsumption, lifetimeKwh)
    → outletService.updateCharacteristic(Voltage, 240.0)
    → outletService.updateCharacteristic(ElectricCurrent, currentA)

  markNoResponse():
    → outletService.getCharacteristic(On)
        .updateValue(new Error('NO_RESPONSE'))
    (HomeKit shows "No Response" for this accessory)
```

`is_connected === false` means the charger is offline (not just idle). Surface this as HomeKit "No Response" so the user is alerted rather than seeing stale data.

---

## setOn() — Fire-and-Forget Command

The ack-polling loop in `session.py` runs up to 20 attempts × 3 s = 60 s. If `setOn()` awaits this, the HAP set-handler times out and HomeKit shows the toggle as failed even when it eventually succeeds.

**Pattern**: the HAP set-handler returns immediately (optimistic); the ack loop runs in the background; the next poll reflects the real state.

```typescript
async setOn(value: boolean, callback: CharacteristicSetCallback): void {
  callback(null);  // return to HomeKit immediately

  try {
    if (value) {
      this.commandInFlight = true;
      // startChargingSessionAsync fires the command then polls ack in background
      client.startChargingSessionAsync(chargerId)
        .then(session => { this.session = session; })
        .catch(err => this.log.error('Start failed:', err))
        .finally(() => {
          this.commandInFlight = false;
          this.scheduleRapidRefresh();
        });
    } else {
      if (!this.session) {
        this.log.warn('Stop requested but no active session known; skipping');
        return;
      }
      this.commandInFlight = true;
      client.stopChargingSessionAsync(
        this.session.device_id,
        this.session.outlet_number,
        this.session.session_id,
      )
        .catch(err => this.log.error('Stop failed:', err))
        .finally(() => {
          this.commandInFlight = false;
          this.scheduleRapidRefresh();
        });
    }
  } catch (err) {
    this.log.error('Command dispatch error:', err);
  }
}
```

`scheduleRapidRefresh()` triggers 3 rapid polls at 5 s intervals before returning to the normal interval.

**Stop with no session**: if `this.session` is null at the time of a stop command (session not yet fetched, or account-wide status did not match this charger), log a warning and no-op rather than silently doing nothing or crashing. This is a user-visible corner case; the polling cycle will correct state within one interval.

---

## Eve Energy History — TotalConsumption

Eve treats `TotalConsumption` as a **lifetime cumulative kWh meter**, not a per-session value. Resetting it to 0 at session end corrupts Eve's energy history because Eve expects monotonic growth and calculates period usage by differencing readings.

**Implementation**: maintain a `lifetimeKwh` accumulator persisted alongside the coulomb token in `node-persist`:

```
PERSIST KEY: lifetime_kwh_{chargerId}  → number (kWh, float)
```

On each poll:
- If a session is active: `lifetimeKwh = persistedBase + session.energy_kwh`
- When session ends (session transitions from non-null to null):
  - `persistedBase += lastSession.energy_kwh`
  - `persist(lifetime_kwh_{chargerId}, persistedBase)`
  - `lifetimeKwh = persistedBase`
- `TotalConsumption` is always set to `lifetimeKwh` (never 0)

`lifetimeKwh` initializes to 0 on first run (no history). This is acceptable — Eve graphs will start from the plugin's first run.

---

## Platform (`platform.ts`)

```
ChargePointPlatform implements DynamicPlatformPlugin
  - configuredAccessories: Map<chargerId, ChargePointAccessory>
  - client: ChargePointClient

  constructor():
    → listen for api.on('didFinishLaunching', this.init)
    (do not call async work in constructor)

  init():  // called from didFinishLaunching
    → try:
        await initStore(api.user.storagePath)
        await initClient()          // full auth flow including discoverRegion
        await discoverDevices()     // getHomeChargers() or config.devices
        for each charger:
          registerOrRestoreAccessory(chargerId)
        startPolling()
      catch err:
        log.error('Plugin failed to initialize:', err)
        // Do NOT rethrow — Homebridge continues; cached accessories show "No Response"
        // which is more informative than Homebridge crashing
```

Errors during `init()` are caught and logged rather than rethrown. Cached accessories remain in HomeKit showing "No Response", giving the user a visible signal that something is wrong without taking down other plugins.

```
  startPolling():
    → scheduleNextPoll()

  scheduleNextPoll():
    → setTimeout(pollCycle, nextIntervalMs())

  pollCycle():
    → accountStatus = await client.getUserChargingStatus()  // once per cycle
    → for each accessory:
        stationMatch = accountStatus?.stations.find(s => s.id === chargerId)
        sessionForCharger = stationMatch
          ? await client.getChargingSession(accountStatus.sessionId)
          : null
        await accessory.refresh(sessionForCharger)
    → scheduleNextPoll()   // recursive, not setInterval, so slow polls don't stack
```

---

## Polling Strategy

| Condition | Interval |
|---|---|
| Default (idle / plugged-in but not charging) | `config.pollingIntervalSeconds` (default 30 s) |
| Actively charging (`charging_status === "CHARGING"`) | 15 s |
| `commandInFlight` rapid-refresh burst | 5 s × 3 polls, then return to normal |
| Datadome captcha encountered | 5 min backoff |
| `InvalidSession` after re-auth failed | 15 min backoff |

`nextIntervalMs()` examines whether any accessory is actively charging or has `commandInFlight` and returns the shortest applicable interval.

---

## Error Handling

| Error | Action |
|---|---|
| `InvalidSession` (401) during startup `getAccount()` | Fall through to password login (see auth flow) |
| `InvalidSession` (401) during polling | Clear token, re-login once, retry; on captcha enter backoff |
| `DatadomeCaptcha` (403 + url) | Log captcha URL at ERROR; set `captcha_blocked` flag; mark all accessories No Response; 5 min backoff; do not retry password login; user must recover via Setup tab |
| `CommunicationError` (other HTTP) | Log; skip this poll cycle for the affected accessory |
| Network timeout / ECONNREFUSED | Log; skip |
| Stop with no session | Log WARN; no-op |
| `is_connected === false` | Call `markNoResponse()` for that accessory |

All errors are caught per-accessory so one failing charger does not block others.

---

## Eve Characteristics Registration (`eveCharacteristics.ts`)

```typescript
import { Formats, Perms } from 'hap-nodejs';

export function buildEveCharacteristics(hap: HAP) {
  const CurrentConsumption = () => {
    const c = new hap.Characteristic('Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
    c.setProps({ format: Formats.FLOAT, minValue: 0, maxValue: 100000,
                 perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    c.value = 0;
    return c;
  };

  const TotalConsumption = () => {
    const c = new hap.Characteristic('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
    c.setProps({ format: Formats.FLOAT, minValue: 0, maxValue: 1000000,
                 perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    c.value = 0;
    return c;
  };

  const Voltage = () => {
    const c = new hap.Characteristic('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
    c.setProps({ format: Formats.FLOAT, minValue: 0, maxValue: 300,
                 perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    c.value = 0;
    return c;
  };

  const ElectricCurrent = () => {
    const c = new hap.Characteristic('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52');
    c.setProps({ format: Formats.FLOAT, minValue: 0, maxValue: 100,
                 perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    c.value = 0;
    return c;
  };

  return { CurrentConsumption, TotalConsumption, Voltage, ElectricCurrent };
}
```

All characteristics are initialized to 0 so HAP never receives `undefined` or `null`. `updateCharacteristic()` calls must always pass a finite `number` — guard before calling:

```typescript
function safeW(powerKw: number): number {
  const w = powerKw * 1000;
  return Number.isFinite(w) ? w : 0;
}

function safeA(powerKw: number): number {
  const a = (powerKw * 1000) / 240.0;
  return Number.isFinite(a) ? a : 0;
}
```

---

## API Data Mapping Reference

### `HomeChargerStatus` fields used

| Field | Python type | Used for |
|---|---|---|
| `charging_status` | `str` | `On` (`"CHARGING"` → true) |
| `is_plugged_in` | `bool` | `OutletInUse` |
| `is_connected` | `bool` | `markNoResponse()` when false |
| `amperage_limit` | `int` | Not used for characteristics (see voltage/current note) |
| `possible_amperage_limits` | `List[int]` | Future: expose as selectable amperage |

### `UserChargingStatus` fields used (account-wide)

| Field | Python type | Used for |
|---|---|---|
| `session_id` | `int` | Passed to `getChargingSession()` |
| `stations[].id` | `int` | Matched against `chargerId` to assign session to correct accessory |

### `ChargingSession` fields used

| Field | Python type | Used for |
|---|---|---|
| `device_id` | `int` | Used as `deviceId` for stop command |
| `outlet_number` | `int` | Used as `portNumber` for stop command |
| `session_id` | `int` | Used as `sessionId` for stop command |
| `power_kw` | `float` | `CurrentConsumption` (× 1000 → W); `ElectricCurrent` (÷ 240) |
| `energy_kwh` | `float` | Added to lifetime accumulator for `TotalConsumption` |
| `charging_state` | `str` | Supplemental state logging |

### `HomeChargerTechnicalInfo` fields used

| Field | Used for |
|---|---|
| `model_number` | Accessory Model |
| `serial_number` | Accessory Serial Number |
| `software_version` | Firmware Revision |

---

## Accessory UUID Strategy

Each charger's UUID is derived deterministically:

```typescript
const uuid = api.hap.uuid.generate(`chargepoint-${chargerId}`);
```

This ensures the same accessory is restored from Homebridge's cache across restarts without creating duplicates.

---

## Out of Scope (v1)

- Public / away station charging (the plugin targets home chargers only)
- Charging schedule management via HomeKit
- LED brightness control
- Vehicle information display
- Multi-account support
- OAuth / SSO login (password + stored token is sufficient)
