import { PAT_PREFIX, type Role, type Scope } from '@macrotracker/shared';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { withContext, type RlsContext } from '../db/client.js';
import { apiTokens, appUsers, devices } from '../db/schema.js';
import { forbidden, unauthorized } from '../errors.js';
import { hashToken } from '../services/tokens.js';

export interface AuthContext {
  userId: string;
  role: Role;
  kind: 'session' | 'pat';
  /** Email from the access token; absent for personal access tokens. */
  email?: string;
  sessionId?: string;
  deviceId?: string;
  tokenId?: string;
  accessToken?: string;
  /** Null means every scope (password sessions). */
  scopes: ReadonlySet<Scope> | null;
}

export interface RequireAuthOptions {
  /** Needed by personal access tokens; sessions always pass. */
  scope?: Scope;
  /** Reject personal access tokens (account management, token minting). */
  sessionOnly?: boolean;
  admin?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth(opts?: RequireAuthOptions): preHandlerAsyncHookHandler;
    verifyAccessToken(token: string): Promise<{ sub: string; sessionId: string; email?: string }>;
  }
}

/** Last-seen/last-used stamps are refreshed at most this often per device/token. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function rlsFor(auth: AuthContext): RlsContext {
  return { userId: auth.userId, isAdmin: auth.role === 'admin' };
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export interface AuthPluginOptions {
  jwks?: JWTVerifyGetKey;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app: FastifyInstance, opts) => {
    const { config, db } = app.deps;
    const jwks =
      opts.jwks ??
      createRemoteJWKSet(new URL('/.well-known/jwks.json', config.GOTRUE_URL), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });

    app.decorateRequest('auth', null);

    app.decorate('verifyAccessToken', async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.JWT_ISSUER,
          audience: 'authenticated',
          algorithms: ['ES256'],
        });
        if (typeof payload.sub !== 'string' || typeof payload.session_id !== 'string') {
          throw unauthorized('Malformed access token', 'invalid_token');
        }
        return {
          sub: payload.sub,
          sessionId: payload.session_id,
          email: typeof payload.email === 'string' ? payload.email : undefined,
        };
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw unauthorized('Access token expired', 'token_expired');
        if (err instanceof joseErrors.JOSEError) throw unauthorized('Invalid access token', 'invalid_token');
        throw err;
      }
    });

    async function fromSession(token: string): Promise<AuthContext> {
      const claims = await app.verifyAccessToken(token);
      return withContext(db, { userId: claims.sub }, async (tx) => {
        const [user] = await tx.select().from(appUsers).where(eq(appUsers.userId, claims.sub));
        if (!user) throw forbidden('This account is not set up on this server', 'not_provisioned');
        const [device] = await tx.select().from(devices).where(eq(devices.sessionId, claims.sessionId));
        if (!device || device.revokedAt)
          throw unauthorized('This device has been signed out', 'session_revoked');
        if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
          await tx.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
        }
        return {
          userId: user.userId,
          role: user.role,
          kind: 'session' as const,
          email: claims.email,
          sessionId: claims.sessionId,
          deviceId: device.id,
          accessToken: token,
          scopes: null,
        };
      });
    }

    async function fromPat(token: string): Promise<AuthContext> {
      const rows = await db.execute<{
        id: string;
        user_id: string;
        scopes: string[];
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(sql`select * from app.lookup_api_token(${hashToken(token)})`);
      const row = rows.rows[0];
      if (!row || row.revoked_at) throw unauthorized('Invalid or revoked token', 'invalid_token');
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        throw unauthorized('Token expired', 'token_expired');
      }
      return withContext(db, { userId: row.user_id }, async (tx) => {
        const [user] = await tx.select().from(appUsers).where(eq(appUsers.userId, row.user_id));
        if (!user) throw unauthorized('Invalid or revoked token', 'invalid_token');
        await tx
          .update(apiTokens)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(apiTokens.id, row.id),
              or(
                isNull(apiTokens.lastUsedAt),
                lt(apiTokens.lastUsedAt, new Date(Date.now() - TOUCH_INTERVAL_MS)),
              ),
            ),
          );
        return {
          userId: user.userId,
          role: user.role,
          kind: 'pat' as const,
          tokenId: row.id,
          scopes: new Set(row.scopes as Scope[]),
        };
      });
    }

    app.decorate('requireAuth', (options: RequireAuthOptions = {}): preHandlerAsyncHookHandler => {
      return async (req) => {
        const token = bearer(req);
        if (!token) throw unauthorized();
        const auth = token.startsWith(PAT_PREFIX) ? await fromPat(token) : await fromSession(token);
        if (auth.kind === 'pat') {
          if (options.sessionOnly || options.admin) {
            throw forbidden('Sign in with a password session for this', 'session_required');
          }
          if (options.scope && !auth.scopes?.has(options.scope)) {
            throw forbidden(`This token lacks the ${options.scope} scope`, 'insufficient_scope');
          }
        }
        if (options.admin && auth.role !== 'admin') throw forbidden('Admins only', 'admin_required');
        req.auth = auth;
      };
    });
  },
  { name: 'auth', dependencies: [] },
);

/** The authenticated caller; only valid in handlers behind requireAuth. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
