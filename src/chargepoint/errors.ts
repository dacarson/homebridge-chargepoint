export class APIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class CommunicationError extends APIError {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export class LoginError extends CommunicationError {}

export class InvalidSession extends CommunicationError {}

export class DatadomeCaptcha extends APIError {
  constructor(public readonly captchaUrl: string, message: string) {
    super(message);
  }
}
