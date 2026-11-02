import {
  acceptLinkBody,
  changePasswordBody,
  errorBody,
  loginBody,
  refreshBody,
  session,
  type Session,
} from '@macrotracker/shared';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { withContext } from '../db/client.js';
import { appUsers, devices } from '../db/schema.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { authOf } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import type { GoTrueSession } from '../services/gotrue.js';
import { randomToken } from '../services/tokens.js';

export const REFRESH_COOKIE = 'mt_rt';
export const CSRF_COOKIE = 'mt_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;

type Client = 'web' | 'app';
type DeviceInput = { name: string; platform: string };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config, db, gotrue } = app.deps;
  const secureCookies = config.PUBLIC_URL.startsWith('https://');
  const authLimit = { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '15 minutes' };

  function setWebCookies(reply: FastifyReply, refreshToken: string) {
    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'strict',
      path: '/v1/auth',
      maxAge: COOKIE_MAX_AGE_S,
    });
    // Double-submit CSRF token: readable by our pages, sent back as a header.
    reply.setCookie(CSRF_COOKIE, randomToken(24), {
      httpOnly: false,
      secure: secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    });
  }

  function clearWebCookies(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  function checkCsrf(req: FastifyRequest) {
    const cookie = req.cookies[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    if (!cookie || typeof header !== 'string' || header !== cookie) {
      throw forbidden('Missing or wrong CSRF token', 'csrf_failed');
    }
  }

  /**
   * Turns a fresh GoTrue session into ours: the account must be provisioned
   * (an app_users row), and the session is recorded as a device.
   */
  async function startSession(
    req: FastifyRequest,
    reply: FastifyReply,
    gs: GoTrueSession,
    device: DeviceInput,
    client: Client,
  ): Promise<Session> {
    const { session_id: sessionId } = decodeJwt(gs.access_token) as { session_id?: string };
    if (!sessionId) throw new AppError(502, 'auth_unavailable', 'Sign-in service returned no session');
    const result = await withContext(db, { userId: gs.user.id }, async (tx) => {
      const [user] = await tx.select().from(appUsers).where(eq(appUsers.userId, gs.user.id));
      if (!user) return null;
      const [row] = await tx
        .insert(devices)
        .values({
          userId: user.userId,
          sessionId,
          name: device.name,
          platform: device.platform,
          lastSeenAt: new Date(),
        })
        .returning({ id: devices.id });
      return { user, deviceId: row!.id };
    });
    if (!result) {
      await gotrue.logout(gs.access_token, 'local').catch(() => undefined);
      throw forbidden('This account is not set up on this server', 'not_provisioned');
    }
    if (client === 'web') setWebCookies(reply, gs.refresh_token);
    return {
      access_token: gs.access_token,
      token_type: 'bearer',
      expires_in: gs.expires_in,
      expires_at: gs.expires_at,
      ...(client === 'app' ? { refresh_token: gs.refresh_token } : {}),
      device_id: result.deviceId,
      user: {
        id: result.user.userId,
        email: gs.user.email ?? '',
        role: result.user.role,
        display_name: result.user.displayName,
      },
    };
  }

  app.post(
    '/login',
    {
      config: { rateLimit: authLimit },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        body: loginBody,
        response: { 200: session, 401: errorBody, 403: errorBody },
      },
    },
    async (req, reply) => {
      const { email, password, device, client } = req.body;
      let gs: GoTrueSession;
      try {
        gs = await gotrue.passwordGrant(email.toLowerCase(), password, req.ip);
      } catch (err) {
        await audit(db, req, { event: 'auth.login_failed', details: { email: email.toLowerCase() } });
        throw err;
      }
      const result = await startSession(req, reply, gs, device, client);
      await audit(db, req, {
        event: 'auth.login',
        userId: gs.user.id,
        details: { device: device.name, client },
      });
      return result;
    },
  );

  app.post(
    '/refresh',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new session',
        description:
          'Apps send `refresh_token` in the body. Browsers send nothing in the body: the httpOnly cookie is used, and the `x-csrf-token` header must match the `mt_csrf` cookie.',
        body: refreshBody.nullish(),
        response: { 200: session, 401: errorBody, 403: errorBody },
      },
    },
    async (req, reply) => {
      const fromBody = req.body?.refresh_token;
      const client: Client = fromBody ? 'app' : 'web';
      if (client === 'web') checkCsrf(req);
      const refreshToken = fromBody ?? req.cookies[REFRESH_COOKIE];
      if (!refreshToken) throw unauthorized('No refresh token', 'session_expired');

      const gs = await gotrue.refreshGrant(refreshToken, req.ip);
      const claims = await app.verifyAccessToken(gs.access_token);
      const found = await withContext(db, { userId: claims.sub }, async (tx) => {
        const [user] = await tx.select().from(appUsers).where(eq(appUsers.userId, claims.sub));
        const [device] = await tx.select().from(devices).where(eq(devices.sessionId, claims.sessionId));
        if (!user || !device || device.revokedAt) return null;
        await tx.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
        return { user, device };
      });
      if (!found) {
        // Signed out from another device: end the GoTrue session too.
        await gotrue.logout(gs.access_token, 'local').catch(() => undefined);
        if (client === 'web') clearWebCookies(reply);
        throw unauthorized('This device has been signed out', 'session_revoked');
      }
      if (client === 'web') setWebCookies(reply, gs.refresh_token);
      return {
        access_token: gs.access_token,
        token_type: 'bearer' as const,
        expires_in: gs.expires_in,
        expires_at: gs.expires_at,
        ...(client === 'app' ? { refresh_token: gs.refresh_token } : {}),
        device_id: found.device.id,
        user: {
          id: found.user.userId,
          email: gs.user.email ?? '',
          role: found.user.role,
          display_name: found.user.displayName,
        },
      };
    },
  );

  app.post(
    '/logout',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['auth'],
        summary: 'Sign this device out',
        security: [{ bearer: [] }],
        response: { 204: z.undefined(), 401: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await withContext(db, { userId: auth.userId }, (tx) =>
        tx.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, auth.deviceId!)),
      );
      await gotrue
        .logout(auth.accessToken!, 'local')
        .catch((err) => req.log.warn({ err }, 'GoTrue logout failed'));
      clearWebCookies(reply);
      await audit(db, req, { event: 'auth.logout', userId: auth.userId });
      return reply.status(204).send();
    },
  );

  app.post(
    '/complete-link',
    {
      config: { rateLimit: authLimit },
      schema: {
        tags: ['auth'],
        summary: 'Redeem an invite or password-reset link and set a password',
        body: acceptLinkBody.extend({ type: z.enum(['invite', 'recovery']) }),
        response: { 200: session, 401: errorBody, 403: errorBody, 422: errorBody },
      },
    },
    async (req, reply) => {
      const { type, token_hash, password, device, client } = req.body;
      const linked = await gotrue.verify(type, token_hash, req.ip);
      await gotrue.setPassword(linked.access_token, password);
      // A reset invalidates every other way in: GoTrue sessions and our devices.
      await gotrue.logout(linked.access_token, 'others');
      await withContext(db, { userId: linked.user.id }, (tx) =>
        tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(and(eq(devices.userId, linked.user.id), isNull(devices.revokedAt))),
      );
      const result = await startSession(req, reply, linked, device, client);
      await audit(db, req, {
        event: type === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
        userId: linked.user.id,
      });
      return result;
    },
  );

  app.post(
    '/change-password',
    {
      config: { rateLimit: authLimit },
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['auth'],
        summary: 'Change password; signs out every other device',
        security: [{ bearer: [] }],
        body: changePasswordBody,
        response: { 204: z.undefined(), 401: errorBody, 422: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const email = auth.email ?? (await gotrue.adminGetUser(auth.userId)).email ?? '';
      // Proving the current password opens a throwaway session; close it at once.
      const check = await gotrue.passwordGrant(email, req.body.current_password, req.ip).catch((err) => {
        throw err?.status === 400
          ? unauthorized('Current password is incorrect', 'invalid_credentials')
          : err;
      });
      await gotrue.logout(check.access_token, 'local').catch(() => undefined);

      await gotrue.setPassword(auth.accessToken!, req.body.new_password);
      await gotrue.logout(auth.accessToken!, 'others');
      await withContext(db, { userId: auth.userId }, (tx) =>
        tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(devices.userId, auth.userId), ne(devices.id, auth.deviceId!), isNull(devices.revokedAt)),
          ),
      );
      await audit(db, req, { event: 'auth.password_changed', userId: auth.userId });
      return reply.status(204).send();
    },
  );
};
