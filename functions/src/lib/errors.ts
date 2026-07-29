/** Errores de aplicación con código estable para que el frontend reaccione. */

export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_argument'
  | 'failed_precondition'
  | 'already_exists'
  | 'rate_limited'
  | 'provider_error'
  | 'payment_rejected'
  | 'maintenance'
  | 'internal';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_argument: 400,
  failed_precondition: 409,
  already_exists: 409,
  rate_limited: 429,
  provider_error: 502,
  payment_rejected: 402,
  maintenance: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const unauthenticated = (msg = 'Debes iniciar sesión.') =>
  new AppError('unauthenticated', msg);

export const forbidden = (msg = 'No tienes permiso para hacer esto.') =>
  new AppError('forbidden', msg);

export const notFound = (msg = 'No encontramos lo que buscas.') =>
  new AppError('not_found', msg);

export const invalidArgument = (msg: string, details?: Record<string, unknown>) =>
  new AppError('invalid_argument', msg, details);

export const failedPrecondition = (msg: string, details?: Record<string, unknown>) =>
  new AppError('failed_precondition', msg, details);

export const rateLimited = (msg = 'Demasiadas solicitudes. Espera un momento.') =>
  new AppError('rate_limited', msg);

export const providerError = (msg: string, details?: Record<string, unknown>) =>
  new AppError('provider_error', msg, details);

export const paymentRejected = (msg: string, details?: Record<string, unknown>) =>
  new AppError('payment_rejected', msg, details);

export const maintenance = (msg: string) => new AppError('maintenance', msg);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
