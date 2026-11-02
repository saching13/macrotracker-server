import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { GoTrueError } from '../services/gotrue.js';

function send(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply.status(status).send({
    error: { code, message, request_id: req.id, ...(details === undefined ? {} : { details }) },
  });
}

/** Maps GoTrue failures to client-facing errors without leaking internals. */
function fromGoTrue(err: GoTrueError): AppError {
  if (err.status === 429) return new AppError(429, 'rate_limited', 'Too many attempts; try again later');
  if (err.status >= 500) return new AppError(502, 'auth_unavailable', 'The sign-in service is unavailable');
  if (err.code === 'invalid_credentials' || err.code === 'invalid_grant')
    return new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
  if (err.code === 'otp_expired' || err.status === 403)
    return new AppError(401, 'link_invalid', 'This link is invalid or has expired');
  if (
    err.code === 'refresh_token_not_found' ||
    err.code === 'refresh_token_already_used' ||
    err.code === 'session_not_found'
  )
    return new AppError(401, 'session_expired', 'Your session has ended; sign in again');
  if (err.code === 'weak_password') return new AppError(422, 'weak_password', err.message);
  if (err.code === 'email_exists' || err.code === 'user_already_exists')
    return new AppError(409, 'email_exists', 'A user with this email already exists');
  return new AppError(err.status === 422 ? 422 : 400, err.code, err.message);
}

export function registerErrorHandling(app: FastifyInstance, bodyLimit: number): void {
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, req, 400, 'validation_error', 'The request is invalid', error.validation);
    }
    if (error instanceof GoTrueError) {
      const mapped = fromGoTrue(error);
      if (mapped.statusCode >= 500) req.log.error({ err: error }, 'GoTrue call failed');
      return send(reply, req, mapped.statusCode, mapped.code, mapped.message);
    }
    if (error instanceof AppError) {
      return send(reply, req, error.statusCode, error.code, error.message, error.details);
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return send(reply, req, 413, 'body_too_large', 'The request body is too large', {
        declared_bytes: Number(req.headers['content-length']) || null,
        limit_bytes: bodyLimit,
      });
    }
    if (error.statusCode === 429) {
      return send(reply, req, 429, 'rate_limited', 'Too many requests; slow down');
    }
    if (isResponseSerializationError(error)) {
      req.log.error({ err: error }, 'response did not match its schema');
      return send(reply, req, 500, 'internal_error', 'Something went wrong');
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return send(reply, req, error.statusCode, error.code?.toLowerCase() ?? 'bad_request', error.message);
    }
    req.log.error({ err: error }, 'unhandled error');
    return send(reply, req, 500, 'internal_error', 'Something went wrong');
  });

  app.setNotFoundHandler((req, reply) =>
    send(reply, req, 404, 'not_found', `No route for ${req.method} ${req.url.split('?')[0]}`),
  );
}
