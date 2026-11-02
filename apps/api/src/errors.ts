/** An error that is safe to show the client: status, stable code and message. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
