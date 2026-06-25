"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const plugin_ui_utils_1 = require("@homebridge/plugin-ui-utils");
const client_1 = require("../src/chargepoint/client");
const errors_1 = require("../src/chargepoint/errors");
const tokenStore_1 = require("../src/tokenStore");
class ChargePointUiServer extends plugin_ui_utils_1.HomebridgePluginUiServer {
    constructor() {
        super();
        this.onRequest('/auth/status', this.handleStatus.bind(this));
        this.onRequest('/auth/login', this.handleLogin.bind(this));
        this.onRequest('/auth/retry', this.handleLogin.bind(this));
        this.onRequest('/auth/validate-token', this.handleValidateToken.bind(this));
        this.onRequest('/auth/clear', this.handleClear.bind(this));
        this.ready();
    }
    get storagePath() {
        return this.homebridgeStoragePath ?? '';
    }
    async _initStore() {
        await (0, tokenStore_1.initStore)(this.storagePath);
    }
    /** Read ChargePoint username from homebridge config.json */
    _readUsernameFromConfig() {
        try {
            // homebridgeConfigPath is the config.json file path; fall back to storagePath/config.json
            const configFile = this.homebridgeConfigPath
                ?? path.join(this.storagePath, 'config.json');
            const raw = fs.readFileSync(configFile, 'utf-8');
            const config = JSON.parse(raw);
            const platforms = config.platforms ?? [];
            const cp = platforms.find(p => p.platform === 'ChargePoint');
            return typeof cp?.username === 'string' ? cp.username : '';
        }
        catch {
            return '';
        }
    }
    _makeClient(username) {
        const log = {
            info: () => { }, warn: () => { },
            error: () => { }, debug: () => { },
            success: () => { }, log: () => { },
        };
        return new client_1.ChargePointClient(username, log);
    }
    async handleStatus(_body) {
        try {
            await this._initStore();
            const captchaBlocked = await (0, tokenStore_1.getFlag)(tokenStore_1.CAPTCHA_FLAG);
            if (captchaBlocked) {
                return { state: 'captcha_blocked' };
            }
            const token = await (0, tokenStore_1.loadToken)();
            if (!token) {
                return { state: 'disconnected' };
            }
            const username = this._readUsernameFromConfig();
            if (!username) {
                return { state: 'disconnected' };
            }
            const client = this._makeClient(username);
            try {
                await client.discoverRegion(username);
                client.setCoulombToken(token);
                const account = await client.getAccount();
                return {
                    state: 'connected',
                    username: account.username,
                    lastRefresh: new Date().toISOString(),
                };
            }
            catch (err) {
                if (err instanceof errors_1.InvalidSession) {
                    return { state: 'disconnected' };
                }
                return { state: 'error', message: String(err) };
            }
        }
        catch (err) {
            return { state: 'error', message: String(err) };
        }
    }
    async handleLogin(body) {
        const { username, password } = (body ?? {});
        if (!username || !password) {
            throw new plugin_ui_utils_1.RequestError('Username and password are required.', { status: 400 });
        }
        try {
            await this._initStore();
            const client = this._makeClient(username);
            await client.discoverRegion(username);
            await client.loginWithPassword(password);
            const token = client.getCoulombToken();
            if (token)
                await (0, tokenStore_1.saveToken)(token);
            await (0, tokenStore_1.clearFlag)(tokenStore_1.CAPTCHA_FLAG);
            const account = await client.getAccount();
            return { state: 'connected', username: account.username };
        }
        catch (err) {
            if (err instanceof errors_1.DatadomeCaptcha) {
                await (0, tokenStore_1.saveFlag)(tokenStore_1.CAPTCHA_FLAG, true);
                return { state: 'captcha', captchaUrl: err.captchaUrl };
            }
            return { state: 'error', message: String(err) };
        }
    }
    async handleValidateToken(body) {
        const { username, token } = (body ?? {});
        if (!username || !token) {
            throw new plugin_ui_utils_1.RequestError('Username and token are required.', { status: 400 });
        }
        try {
            await this._initStore();
            const client = this._makeClient(username);
            await client.discoverRegion(username);
            client.setCoulombToken(token);
            const account = await client.getAccount();
            const refreshedToken = client.getCoulombToken() ?? token;
            await (0, tokenStore_1.saveToken)(refreshedToken);
            await (0, tokenStore_1.clearFlag)(tokenStore_1.CAPTCHA_FLAG);
            return { state: 'connected', username: account.username };
        }
        catch (err) {
            if (err instanceof errors_1.InvalidSession || err instanceof errors_1.CommunicationError) {
                return { state: 'error', message: 'Token is invalid or expired. Please re-copy the cookie.' };
            }
            return { state: 'error', message: String(err) };
        }
    }
    async handleClear(_body) {
        try {
            await this._initStore();
            await (0, tokenStore_1.clearToken)();
            await (0, tokenStore_1.clearFlag)(tokenStore_1.CAPTCHA_FLAG);
            return { success: true };
        }
        catch (err) {
            throw new plugin_ui_utils_1.RequestError(String(err), { status: 500 });
        }
    }
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const server = new ChargePointUiServer();
