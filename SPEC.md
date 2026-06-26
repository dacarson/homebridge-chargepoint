# Homebridge ChargePoint Plugin — Specification

## Overview

A native Homebridge dynamic platform plugin written in TypeScript that exposes a ChargePoint Home Flex EV charger as an **Eve Energy** accessory in HomeKit. The Eve Energy representation surfaces real-time power consumption, total session energy, plug state, and charging state.

The Python library at `python-chargepoint/` is the authoritative reference for all API communication. The script `solar_charge_controller.py` is the authoritative reference for how to correctly interpret charger state and power data. All HTTP logic is ported to TypeScript; there is no Python runtime dependency.

---

## Package

| Field | Value |
|---|---|
| npm name | `homebridge-chargepoint` |
| Language | TypeScript (ES2022, strict mode) |
| Node target | ≥ 18 |
| Peer deps | `homebridge >= 1.8.0`, `hap-nodejs >= 0.12.0` |
| Runtime deps | `axios` (HTTP), `tough-cookie` + `axios-cookiejar-support` (cookie jar), `node-persist` (token storage) |
| Dev deps | `typescript`, `eslint`, `@homebridge/eslint-config` |

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
| `CurrentConsumption` | `E863F10D-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | W | See Power Source Logic below |
| `TotalConsumption` | `E863F10C-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | kWh | Persistent lifetime accumulator (see Eve energy history section) |
| `Voltage` | `E863F10A-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | V | Fixed `240.0` V for L2 chargers |
| `ElectricCurrent` | `E863F126-079E-48FF-8F27-9C2605A29F52` | `FLOAT` | A | `CurrentConsumption (W) / 240.0`; 0 when not charging |

All four Eve characteristics are declared with `perms: [READ, NOTIFY]`.

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
      "sessionToken": {
        "title": "Session Token (coulomb_sess cookie value)",
        "type": "string",
        "description": "Paste the coulomb_sess cookie value here to bypass Datadome bot-protection."
      },
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

`devices` is optional — if omitted, the platform auto-discovers via `getHomeChargers()`.

`username` and `password` remain in config as credentials for mid-polling re-authentication. `sessionToken` allows bypassing the Datadome-protected password login entirely.

---

## Credential Token Persistence

### The Problem

ChargePoint's login endpoint is protected by Datadome bot-detection. Repeated programmatic logins (e.g. on every Homebridge restart) trigger a gateway captcha that blocks further access. The `coulomb_sess` session cookie is long-lived and is refreshed on every API response, so it should survive indefinitely as long as it is persisted between restarts.

### Storage Mechanism

Use `node-persist` initialized at `{api.user.storagePath}/chargepoint-plugin/`. The stored value is the raw cookie string exactly as returned by the server.

```typescript
// tokenStore.ts
const STORE_KEY = 'coulomb_token';
let _cached: string | undefined;

export async function initStore(storagePath: string): Promise<void>
export async function loadToken(): Promise<string | undefined>
export async function saveToken(token: string): Promise<void>   // no-op if unchanged
export async function clearToken(): Promise<void>
export async function loadLifetimeKwh(chargerId: number): Promise<number>
export async function saveLifetimeKwh(chargerId: number, kwh: number): Promise<void>
```

### Cookie Jar and Token Handling

Use `tough-cookie` + `axios-cookiejar-support` as the cookie jar for the axios instance. After each HTTP response, read the refreshed `coulomb_sess` value from the jar.

**Critical**: `tough-cookie` silently rejects cookies with a leading-dot domain (`.chargepoint.com`). Strip the leading dot when constructing the `Cookie` object — use `domain: 'chargepoint.com'`, not `domain: '.chargepoint.com'`.

**Critical**: Cache the token as an instance variable (`this._token`) as a fallback when the jar domain-match fails. `getCoulombToken()` should try the jar first, then fall back to `this._token`.

```typescript
setCoulombToken(token: string): void {
  this._token = token;
  const cookie = new Cookie({
    key: 'coulomb_sess',
    value: token,
    domain: 'chargepoint.com',    // NO leading dot — tough-cookie rejects leading-dot domain
    path: '/',
    maxAge: 10 * 365 * 24 * 3600,
  });
  this.jar.setCookieSync(cookie, 'https://account.chargepoint.com/');
}

getCoulombToken(): string | undefined {
  const fromJar = this.jar.getCookiesSync('https://account.chargepoint.com/')
    .find(c => c.key === 'coulomb_sess')?.value;
  return fromJar ?? this._token;
}
```

After each request, read the token from the jar and call `saveToken()` — the in-memory guard in `tokenStore` makes this cheap when the value hasn't changed.

The `cp-session-token` request header must be rebuilt from the current token before each request, so it stays in sync as the cookie rotates:

```typescript
// Inside _request() before sending:
const token = getCoulombToken();
if (token && this.globalConfig) {
  headers['cp-session-type'] = 'CP_SESSION_TOKEN';
  headers['cp-session-token'] = token;
  headers['cp-region'] = this.globalConfig.region;
}
```

### Startup Auth Flow

Region discovery (`POST https://discovery.chargepoint.com/discovery/v3/globalconfig`) is **always required** on startup — it returns the region-specific API endpoints that all subsequent calls depend on. It does not require authentication.

```
On platform startup:
  1. await discoverRegion(username)        // ALWAYS — retrieves globalConfig / endpoints
  2a. config.sessionToken exists:
        → setCoulombToken(config.sessionToken) into jar
        → try: await getAccount()          // validates token AND populates userId
          catch InvalidSession (401):
            → log "config sessionToken expired, falling through"
            → goto step 2b
  2b. storedToken = await tokenStore.loadToken()
      storedToken exists:
        → setCoulombToken(storedToken) into jar
        → try: await getAccount()          // validates token AND populates userId
          catch InvalidSession (401):
            → log "stored token expired, re-authenticating"
            → goto step 2c
  2c. No valid token:
        → await loginWithPassword(username, password)
          → on success: saveToken(getCoulombToken())
          → on DatadomeCaptcha:
              log captcha URL at ERROR
              throw  (plugin fails to load; cached accessories show "No Response")
  3. Polling loop begins
  4. After every API response: saveToken(getCoulombToken())
```

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
| `startChargingSession(deviceId)` | `start_charging_session()` | Returns ChargingSession |
| `stopChargingSession(deviceId, portNumber, sessionId)` | `session.stop()` | |
| `setAmperageLimit(chargerId, amps)` | `set_amperage_limit()` | |

---

## Exact API Response Formats

These are validated against the Python test suite in `python-chargepoint/tests/conftest.py`.

### `getUserChargingStatus`

**Request**: `POST {mapcache_endpoint}v2` with body `{"user_status": {"mfhs": {}}}`

**Response when charging**:
```json
{
  "user_status": {
    "charging": {
      "sessionId": 12345,
      "state": "in_use",
      "startTimeUTC": 1234567890.123,
      "stations": [
        { "deviceId": 67890, "name": "CP HOME", "lat": 30.0, "lon": 70.0 }
      ]
    }
  }
}
```

**Response when not charging**: `{"user_status": {}}`

**Critical parsing requirement**: The data is nested under `user_status.charging`. The `charging` key **must be unwrapped** before reading `sessionId`, `state`, and `stations`. The Python model does this automatically via:
```python
@model_validator(mode="before")
def unwrap_charging(cls, data):
    return data.get("charging", data)
```

The TypeScript implementation must do the same:
```typescript
const userStatus = response.data?.user_status;
if (!userStatus || Object.keys(userStatus).length === 0) return null;
const d = userStatus.charging ?? userStatus;   // unwrap charging key
const sessionId = d.sessionId != null ? Number(d.sessionId) : null;
const state: string = d.state ?? '';
const stations = (d.stations ?? []).map((s: any) => ({ id: Number(s.deviceId ?? 0) }));
```

**`state` values**: `"in_use"` (charging), `"waiting"` (plugged in, not yet drawing), `"fully_charged"` (battery full).

**`stations[].id`** comes from `deviceId` in the JSON, not from `id`.

### `getChargingSession`

**Request**: `POST {internal_api_gateway_endpoint}driver-bff/v1/sessions/{sessionId}` with body `{"charging_status": {"session_id": sessionId, "mfhs": []}}`

**Response**:
```json
{
  "charging_status": {
    "start_time": 1234567890000,
    "device_id": 67890,
    "device_name": "CP HOME",
    "current_charging": "CHARGING",
    "charging_time": 3600,
    "energy_kwh": 5.2,
    "power_kw": 7.2,
    "outlet_number": 1,
    "last_update_data_timestamp": 1234567890000,
    "update_data": [
      { "energy_kwh": 5.1, "power_kw": 7.1, "timestamp": 1234567882000 },
      { "energy_kwh": 5.2, "power_kw": 7.2, "timestamp": 1234567890000 }
    ],
    "update_period": 8000
  }
}
```

**Critical**: `current_charging` maps to `charging_state`. `update_data[-1].power_kw` is the most current power reading. `power_kw` at the top level can be stale.

**Error detection**: If `response.charging_status` is absent, or contains `error_message` or `error` fields, treat as an error.

### `getHomeChargerStatus`

**Request**: `GET {hcpo_hcm_endpoint}api/v1/configuration/users/{userId}/chargers/{chargerId}/status`

**Response**:
```json
{
  "brand": "CP",
  "isPluggedIn": true,
  "isConnected": true,
  "chargingStatus": "CHARGING",
  "isReminderEnabled": false,
  "model": "HOME FLEX",
  "macAddress": "00:00:00:00:00:00",
  "isDuringScheduledTime": false,
  "chargeAmperageSettings": {
    "chargeLimit": 24,
    "inProgress": false,
    "possibleChargeLimit": [16, 20, 24, 32, 40, 48]
  }
}
```

**`chargingStatus` values**: `"CHARGING"`, `"AVAILABLE"`, `"CHARGING_STOPPED"`, `"IDLE"`.
**`isConnected`**: `false` means the charger is offline/unreachable (not that the EV is disconnected). Surface as HomeKit "No Response".
**`isPluggedIn`**: `true` when an EV is physically connected to the charger.

---

## UserChargingStatus State Machine

The `state` field in `UserChargingStatus.charging.state` drives the power calculation:

| `state` | `HomeChargerStatus.charging_status` | Interpretation | Power Source |
|---|---|---|---|
| `"in_use"` | `"CHARGING"` | Actively delivering energy | `session.update_data[-1].power_kw` |
| `"waiting"` | `"CHARGING"` | Charger on, car not yet drawing | Estimate: `amperage_limit × 240 / 1000` kW |
| `"waiting"` | `"CHARGING_STOPPED"` / `"AVAILABLE"` / `"IDLE"` | Scheduled but paused | 0 W (no current flowing) |
| `"fully_charged"` | any | Battery full, tapering off | `session.power_kw` if ≥ 0.1 kW, else 0 |
| `null` / absent | `"CHARGING"` | No account session (rare) | Estimate: `amperage_limit × 240 / 1000` kW |
| `null` / absent | other | Not charging | 0 W |

---

## Power Source Logic (Critical for Eve Energy)

**Getting current power watts**:

```
1. Get UserChargingStatus (once per poll cycle at platform level)
2. If status is null → 0 W
3. If status.state == "in_use":
     → fetch ChargingSession if not already fetched
     → use session.update_data[-1].power_kw  (most accurate, regularly updated)
     → if update_data is empty, fall back to session.power_kw
     → multiply by 1000 for watts
4. If status.state == "waiting":
     → if HomeChargerStatus.charging_status is "CHARGING_STOPPED", "AVAILABLE", or "IDLE" → 0 W
     → else estimate: HomeChargerStatus.amperage_limit * 240 W
5. If status.state == "fully_charged":
     → fetch ChargingSession
     → if session.power_kw >= 0.1 → use session.power_kw * 1000 W
     → else → 0 W (charge complete)
6. Otherwise → 0 W
```

**`CurrentConsumption`** is always consistent with `ElectricCurrent` via `I = P / V = watts / 240`.

**`Voltage`** is always fixed at `240.0 V`.

When `power_kw` is 0 (not charging), `ElectricCurrent` is also 0.

**Why `update_data[-1].power_kw` instead of top-level `power_kw`**: The session API is eventually-consistent. The top-level `power_kw` field can lag by several minutes. `update_data` is a rolling list of metered readings; the last entry is always the freshest measurement. The Python solar controller uses `session.update_data[-1].power_kw` for the `in_use` state for this reason.

---

## Session Matching (Account-Wide Status)

`getUserChargingStatus()` returns a single account-level status that includes a `stations` array of `{ id: number }` (the `deviceId` of the charger hosting the session). It does **not** return one status per charger.

```typescript
// In platform.pollAll():
const accountStatus = await client.getUserChargingStatus();

// accountStatus?.charging?.sessionId is the session to fetch
// accountStatus?.charging?.stations[].id (from JSON deviceId) matches chargerId

let activeSession: ChargingSession | null = null;
if (accountStatus?.session_id != null) {
  activeSession = await client.getChargingSession(accountStatus.session_id);
}

for (const [chargerId, accessory] of configuredAccessories) {
  const stationMatch = accountStatus?.stations.find(s => s.id === chargerId);
  const session = stationMatch ? activeSession : null;
  await accessory.refresh(accountStatus, session);
}
```

`getUserChargingStatus()` is called **once per poll cycle** at the platform level. Each accessory receives the account-level status and its resolved session (or null) as parameters. This avoids N redundant API calls.

---

## Accessory (`accessory.ts`)

```
ChargePointAccessory
  - chargerId: number
  - status: HomeChargerStatus | null
  - accountStatus: UserChargingStatus | null
  - session: ChargingSession | null

  refresh(accountStatus: UserChargingStatus | null, session: ChargingSession | null):
    → this.status = await client.getHomeChargerStatus(chargerId)
    → if !this.status.is_connected:
        markNoResponse()
        return
    → this.accountStatus = accountStatus
    → this.session = session
    → [TotalConsumption accumulation — see Eve energy history section]
    → updateCharacteristics()

  updateCharacteristics():
    → isCharging = status.charging_status === "CHARGING"
    → powerW = computePowerW(accountStatus, status, session)
    → currentA = powerW / 240.0
    → outletService.updateCharacteristic(On, isCharging)
    → outletService.updateCharacteristic(OutletInUse, status.is_plugged_in)
    → outletService.updateCharacteristic(CurrentConsumption, powerW)
    → outletService.updateCharacteristic(TotalConsumption, lifetimeKwh)
    → outletService.updateCharacteristic(Voltage, 240.0)
    → outletService.updateCharacteristic(ElectricCurrent, currentA)

  computePowerW(accountStatus, status, session):
    → follows the Power Source Logic table above
    → returns a finite non-negative number (0 when not charging)
```

`is_connected === false` means the charger is offline (not just idle). Surface this as HomeKit "No Response" so the user is alerted rather than seeing stale data.

---

## setOn() — Fire-and-Forget Command

The ack-polling loop runs up to 20 attempts × 3 s = 60 s. If `setOn()` awaits this, the HAP set-handler times out and HomeKit shows the toggle as failed even when it eventually succeeds.

**Pattern**: the HAP set-handler returns immediately (optimistic); the ack loop runs in the background; the next poll reflects the real state.

```typescript
async setOn(value: boolean, callback: CharacteristicSetCallback): void {
  callback(null);  // return to HomeKit immediately

  try {
    if (value) {
      this.commandInFlight = true;
      client.startChargingSession(chargerId)
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
      client.stopChargingSession(
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

### Start/Stop Command API

**Start**: `POST {accounts_endpoint}v1/driver/station/startsession` with body `{"deviceId": chargerId}`

**Stop**: `POST {accounts_endpoint}v1/driver/station/stopSession` with body `{"deviceId": deviceId, "portNumber": outletNumber, "sessionId": sessionId}`

Both commands return an `ackId`. Then poll `POST {accounts_endpoint}v1/driver/station/session/ack` with body `{"ackId": ackId, "action": "start_session" | "stop_session"}` up to 20 times × 3 s. HTTP 200 = confirmed; non-200 = pending.

**After start**: The `sessionId` returned by the start command is not the real session ID. After start is confirmed, call `getUserChargingStatus()` to get the real `session_id`, then call `getChargingSession(session_id)` to get the full session object.

---

## Eve Energy History — TotalConsumption

Eve treats `TotalConsumption` as a **lifetime cumulative kWh meter**, not a per-session value. Resetting it to 0 at session end corrupts Eve's energy history because Eve expects monotonic growth.

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

`lifetimeKwh` initializes to 0 on first run (no history). Eve graphs start from the plugin's first run.

---

## Platform (`platform.ts`)

```
ChargePointPlatform implements DynamicPlatformPlugin
  - configuredAccessories: Map<chargerId, ChargePointAccessory>
  - client: ChargePointClient

  constructor():
    → listen for api.on('didFinishLaunching', this.init)

  init():
    → try:
        await initStore(api.user.storagePath())
        await initClient()          // full auth flow including discoverRegion
        await discoverDevices()     // getHomeChargers() or config.devices
        for each charger:
          registerOrRestoreAccessory(chargerId)
        startPolling()
      catch err:
        log.error('Plugin failed to initialize:', err)
        // Do NOT rethrow — cached accessories show "No Response"
```

```
  pollCycle():
    → accountStatus = await client.getUserChargingStatus()  // once per cycle
    → activeSession = null
    → if accountStatus?.session_id != null:
        activeSession = await client.getChargingSession(accountStatus.session_id)
    → for each [chargerId, accessory]:
        stationMatch = accountStatus?.stations.find(s => s.id === chargerId)
        session = stationMatch ? activeSession : null
        await accessory.refresh(accountStatus, session)
    → scheduleNextPoll()
```

---

## Polling Strategy

| Condition | Interval |
|---|---|
| Default (idle / plugged-in but not charging) | `config.pollingIntervalSeconds` (default 30 s) |
| Actively charging (`state === "in_use"`) | 15 s |
| `commandInFlight` rapid-refresh burst | 5 s × 3 polls, then return to normal |
| `InvalidSession` after re-auth failed | 15 min backoff |
| `DatadomeCaptcha` encountered | 5 min backoff |

`nextIntervalMs()` examines whether any accessory has an active session or `commandInFlight` and returns the shortest applicable interval.

---

## Error Handling

| Error | Action |
|---|---|
| `InvalidSession` (401) during startup `getAccount()` | Fall through to password login (see auth flow) |
| `InvalidSession` (401) during polling | Clear token, re-login once, retry; on captcha enter backoff |
| `DatadomeCaptcha` (403 + url) | Log captcha URL at ERROR; mark all accessories No Response; 5 min backoff; do not retry password login |
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

All characteristics are initialized to 0 so HAP never receives `undefined` or `null`. Guard before calling `updateCharacteristic()`:

```typescript
function safeW(powerKw: number): number {
  const w = powerKw * 1000;
  return Number.isFinite(w) && w >= 0 ? w : 0;
}

function safeA(powerW: number): number {
  const a = powerW / 240.0;
  return Number.isFinite(a) && a >= 0 ? a : 0;
}
```

---

## API Data Mapping Reference

### `HomeChargerStatus` fields used

| JSON field | TS field | Used for |
|---|---|---|
| `chargingStatus` | `charging_status` | `On` (`"CHARGING"` → true); drive power source logic |
| `isPluggedIn` | `is_plugged_in` | `OutletInUse` |
| `isConnected` | `is_connected` | `markNoResponse()` when false (charger offline) |
| `chargeAmperageSettings.chargeLimit` | `amperage_limit` | Power estimate for `waiting` state |
| `chargeAmperageSettings.possibleChargeLimit` | `possible_amperage_limits` | Available amperage steps |
| `isDuringScheduledTime` | `is_during_scheduled_time` | Indicates charger is within its scheduled window |

### `UserChargingStatus` fields used (account-wide)

| JSON path | TS field | Used for |
|---|---|---|
| `user_status.charging.sessionId` | `session_id` | Passed to `getChargingSession()` |
| `user_status.charging.state` | `state` | Drive power source logic (see State Machine table) |
| `user_status.charging.stations[].deviceId` | `stations[].id` | Matched against `chargerId` to assign session to correct accessory |

### `ChargingSession` fields used

| JSON field | TS field | Used for |
|---|---|---|
| `device_id` | `device_id` | Used as `deviceId` for stop command |
| `outlet_number` | `outlet_number` | Used as `portNumber` for stop command |
| `session_id` (from UserChargingStatus) | `session_id` | Used as `sessionId` for stop command |
| `update_data[-1].power_kw` | `update_data[-1].power_kw` | `CurrentConsumption` when `in_use` |
| `power_kw` | `power_kw` | `CurrentConsumption` fallback; used for `fully_charged` state |
| `energy_kwh` | `energy_kwh` | Added to lifetime accumulator for `TotalConsumption` |
| `current_charging` | `charging_state` | Supplemental state logging |

### `HomeChargerTechnicalInfo` fields used

| JSON field | Used for |
|---|---|
| `modelNumber` | Accessory Model |
| `serialNumber` | Accessory Serial Number |
| `softwareVersion` | Firmware Revision |

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
