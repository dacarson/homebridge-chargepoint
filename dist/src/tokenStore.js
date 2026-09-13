"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initStore = initStore;
exports.loadToken = loadToken;
exports.saveToken = saveToken;
exports.clearToken = clearToken;
exports.loadLifetimeKwh = loadLifetimeKwh;
exports.saveLifetimeKwh = saveLifetimeKwh;
const node_persist_1 = __importDefault(require("node-persist"));
const TOKEN_KEY = 'coulomb_token';
let _initialized = false;
let _cachedToken;
async function initStore(storagePath) {
    await node_persist_1.default.init({ dir: `${storagePath}/chargepoint-plugin` });
    _initialized = true;
    _cachedToken = await node_persist_1.default.getItem(TOKEN_KEY);
}
async function loadToken() {
    return _cachedToken;
}
async function saveToken(token) {
    if (!_initialized)
        return;
    if (token === _cachedToken)
        return; // avoid unnecessary disk writes
    _cachedToken = token;
    await node_persist_1.default.setItem(TOKEN_KEY, token);
}
async function clearToken() {
    _cachedToken = undefined;
    if (_initialized) {
        await node_persist_1.default.removeItem(TOKEN_KEY);
    }
}
async function loadLifetimeKwh(chargerId) {
    if (!_initialized)
        return 0;
    return (await node_persist_1.default.getItem(`lifetime_kwh_${chargerId}`)) ?? 0;
}
async function saveLifetimeKwh(chargerId, kwh) {
    if (!_initialized)
        return;
    await node_persist_1.default.setItem(`lifetime_kwh_${chargerId}`, kwh);
}
