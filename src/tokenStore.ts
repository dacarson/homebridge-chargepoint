import storage from 'node-persist';

const TOKEN_KEY = 'coulomb_token';
export const CAPTCHA_FLAG = 'captcha_blocked';

let _initialized = false;
let _cachedToken: string | undefined;

export async function initStore(storagePath: string): Promise<void> {
  await storage.init({ dir: `${storagePath}/chargepoint-plugin` });
  _initialized = true;
  _cachedToken = await storage.getItem(TOKEN_KEY) as string | undefined;
}

export async function loadToken(): Promise<string | undefined> {
  return _cachedToken;
}

export async function saveToken(token: string): Promise<void> {
  if (!_initialized) return;
  if (token === _cachedToken) return; // avoid unnecessary disk writes
  _cachedToken = token;
  await storage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  _cachedToken = undefined;
  if (_initialized) {
    await storage.removeItem(TOKEN_KEY);
  }
}

export async function getFlag(key: string): Promise<boolean> {
  if (!_initialized) return false;
  return (await storage.getItem(key)) === true;
}

export async function saveFlag(key: string, value: boolean): Promise<void> {
  if (!_initialized) return;
  await storage.setItem(key, value);
}

export async function clearFlag(key: string): Promise<void> {
  if (!_initialized) return;
  await storage.removeItem(key);
}

export async function loadLifetimeKwh(chargerId: number): Promise<number> {
  if (!_initialized) return 0;
  return (await storage.getItem(`lifetime_kwh_${chargerId}`)) as number ?? 0;
}

export async function saveLifetimeKwh(chargerId: number, kwh: number): Promise<void> {
  if (!_initialized) return;
  await storage.setItem(`lifetime_kwh_${chargerId}`, kwh);
}
