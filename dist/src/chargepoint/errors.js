"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatadomeCaptcha = exports.InvalidSession = exports.LoginError = exports.CommunicationError = exports.APIError = void 0;
class APIError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}
exports.APIError = APIError;
class CommunicationError extends APIError {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
exports.CommunicationError = CommunicationError;
class LoginError extends CommunicationError {
}
exports.LoginError = LoginError;
class InvalidSession extends CommunicationError {
}
exports.InvalidSession = InvalidSession;
class DatadomeCaptcha extends APIError {
    captchaUrl;
    constructor(captchaUrl, message) {
        super(message);
        this.captchaUrl = captchaUrl;
    }
}
exports.DatadomeCaptcha = DatadomeCaptcha;
