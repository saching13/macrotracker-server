import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCOPES, type Scope } from '@macrotracker/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withContext, type Db } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashToken } from './tokens.js';

/** Recognizable prefixes, like personal access tokens (`mt_pat_`). */
export const ACCESS_PREFIX = 'mt_oat_';
export const REFRESH_PREFIX = 'mt_ort_';

export const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

/** What a client gets when it asks for nothing in particular. */
export const DEFAULT_SCOPES: Scope[] = ['mcp:read', 'mcp:write'];

/** An OAuth error, sent as `{error, error_description}` (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');

/** Scopes from a space-separated `scope` parameter; unknown ones are an error. */
export function parseScopes(scope: string | undefined): Scope[] {
  if (!scope?.trim()) return DEFAULT_SCOPES;
  const asked = [...new Set(scope.trim().split(/\s+/))];
  const unknown = asked.filter((x) => !(SCOPES as readonly string[]).includes(x));
  if (unknown.length > 0) throw new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(' ')}`);
  return asked as Scope[];
}

/** Redirect URIs must be HTTPS, or HTTP on this machine (native and CLI clients). */
export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** PKCE S256: base64url(SHA-256(verifier)) equals the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: string;
  secretHash: string | null;
}

/**
 * The authorization server behind /oauth/*, so MCP connectors (claude.ai,
 * desktop clients) can sign in without a hand-made token. Access tokens are
 * short-lived rows in api_tokens tied to a grant, so the existing token
 * checks (scopes, expiry, revocation) apply to them unchanged.
 */
export class OAuthService {
  constructor(private readonly db: Db) {}

  async register(b: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
  }): Promise<{ client: Client; secret: string | null }> {
    const method = b.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      throw new OAuthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method ${method}`);
    }
    if (b.redirect_uris.length === 0 || !b.redirect_uris.every(validRedirectUri)) {
      throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be https, or http on localhost');
    }
    const secret = method === 'none' ? null : randomBytes(32).toString('base64url');
    const client: Client = {
      id: `mtc_${randomBytes(16).toString('base64url')}`,
      name: (b.client_name ?? 'An MCP client').slice(0, 100),
      redirectUris: b.redirect_uris,
      authMethod: method,
      secretHash: secret ? hashToken(secret) : null,
    };
    await withContext(this.db, { userId: null }, (tx) => tx.insert(s.oauthClients).values(client));
    return { client, secret };
  }

  async client(id: string): Promise<Client | null> {
    const [c] = await withContext(this.db, { userId: null }, (tx) =>
      tx.select().from(s.oauthClients).where(eq(s.oauthClients.id, id)),
    );
    return c ?? null;
  }

  /** Checks an authorization request's client and redirect URI (never redirect on these errors). */
  async checkRequest(q: { client_id: string; redirect_uri: string }): Promise<Client> {
    const client = await this.client(q.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client');
    if (!client.redirectUris.includes(q.redirect_uri)) {
      throw new OAuthError('invalid_request', 'That redirect URI isn’t registered for this client');
    }
    return client;
  }

  /** After the person signed in and approved: a single-use code for the client. */
  async issueCode(
    userId: string,
    a: { clientId: string; redirectUri: string; challenge: string; scopes: Scope[] },
  ) {
    const code = token('');
    await withContext(this.db, { userId }, (tx) =>
      tx.insert(s.oauthCodes).values({
        codeHash: hashToken(code),
        clientId: a.clientId,
        userId,
        redirectUri: a.redirectUri,
        codeChallenge: a.challenge,
        scopes: a.scopes,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      }),
    );
    return code;
  }

  /** Confidential clients prove themselves with their secret; public ones with PKCE alone. */
  authenticateClient(client: Client, secret: string | undefined): void {
    if (client.authMethod === 'none') return;
    if (!secret || !client.secretHash)
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    const a = Buffer.from(hashToken(secret));
    const b = Buffer.from(client.secretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
  }

  async exchangeCode(a: { client: Client; code: string; redirectUri: string; verifier: string }) {
    const rows = await this.db.execute<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      scopes: string[];
    }>(sql`select * from app.oauth_take_code(${hashToken(a.code)})`);
    const c = rows.rows[0];
    if (!c || c.client_id !== a.client.id || c.redirect_uri !== a.redirectUri) {
      throw new OAuthError('invalid_grant', 'The code is invalid, used or expired');
    }
    if (!pkceMatches(a.verifier, c.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    const refresh = token(REFRESH_PREFIX);
    const grantId = await withContext(this.db, { userId: c.user_id }, async (tx) => {
      const [g] = await tx
        .insert(s.oauthGrants)
        .values({
          userId: c.user_id,
          clientId: a.client.id,
          scopes: c.scopes,
          refreshHash: hashToken(refresh),
          refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        })
        .returning({ id: s.oauthGrants.id });
      return g!.id;
    });
    return this.tokens(c.user_id, grantId, a.client, c.scopes as Scope[], refresh);
  }

  async refresh(a: { client: Client; refreshToken: string }) {
    const rows = await this.db.execute<{
      id: string;
      user_id: string;
      client_id: string;
      scopes: string[];
      refresh_expires_at: Date;
      revoked_at: Date | null;
    }>(sql`select * from app.oauth_find_refresh(${hashToken(a.refreshToken)})`);
    const g = rows.rows[0];
    if (!g || g.client_id !== a.client.id || g.revoked_at || new Date(g.refresh_expires_at) < new Date()) {
      throw new OAuthError('invalid_grant', 'The refresh token is invalid, revoked or expired');
    }
    // Rotate: the old refresh token stops working.
    const refresh = token(REFRESH_PREFIX);
    const rotated = await withContext(this.db, { userId: g.user_id }, (tx) =>
      tx
        .update(s.oauthGrants)
        .set({
          refreshHash: hashToken(refresh),
          refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          lastUsedAt: new Date(),
        })
        .where(and(eq(s.oauthGrants.id, g.id), eq(s.oauthGrants.refreshHash, hashToken(a.refreshToken))))
        .returning({ id: s.oauthGrants.id }),
    );
    if (rotated.length === 0) throw new OAuthError('invalid_grant', 'The refresh token was already used');
    return this.tokens(g.user_id, g.id, a.client, g.scopes as Scope[], refresh);
  }

  private async tokens(userId: string, grantId: string, client: Client, scopes: Scope[], refresh: string) {
    const access = token(ACCESS_PREFIX);
    await withContext(this.db, { userId }, (tx) =>
      tx.insert(s.apiTokens).values({
        userId,
        name: client.name,
        prefix: access.slice(0, ACCESS_PREFIX.length + 6),
        tokenHash: hashToken(access),
        scopes,
        expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
        grantId,
      }),
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  /** The person's connected apps. */
  async grants(userId: string) {
    return withContext(this.db, { userId }, (tx) =>
      tx
        .select({
          id: s.oauthGrants.id,
          clientName: s.oauthClients.name,
          scopes: s.oauthGrants.scopes,
          createdAt: s.oauthGrants.createdAt,
          lastUsedAt: s.oauthGrants.lastUsedAt,
        })
        .from(s.oauthGrants)
        .innerJoin(s.oauthClients, eq(s.oauthClients.id, s.oauthGrants.clientId))
        .where(and(eq(s.oauthGrants.userId, userId), isNull(s.oauthGrants.revokedAt))),
    );
  }

  /** Disconnects an app: its refresh token and every access token it holds stop working. */
  async revoke(userId: string, grantId: string): Promise<boolean> {
    return withContext(this.db, { userId }, async (tx) => {
      const done = await tx
        .update(s.oauthGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(s.oauthGrants.id, grantId),
            eq(s.oauthGrants.userId, userId),
            isNull(s.oauthGrants.revokedAt),
          ),
        )
        .returning({ id: s.oauthGrants.id });
      if (done.length === 0) return false;
      await tx
        .update(s.apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(s.apiTokens.grantId, grantId), isNull(s.apiTokens.revokedAt)));
      return true;
    });
  }
}
