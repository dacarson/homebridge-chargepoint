export declare class APIError extends Error {
    constructor(message: string);
}
export declare class CommunicationError extends APIError {
    readonly statusCode: number;
    constructor(statusCode: number, message: string);
}
export declare class LoginError extends CommunicationError {
}
export declare class InvalidSession extends CommunicationError {
}
export declare class DatadomeCaptcha extends APIError {
    readonly captchaUrl: string;
    constructor(captchaUrl: string, message: string);
}
