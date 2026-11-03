import { readFile } from 'node:fs/promises';
import { errorBody, SCOPES } from '@macrotracker/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { audit } from '../services/audit.js';
import { OAuthError, OAuthService, parseScopes } from '../services/oauth.js';
import { publicDir } from './pages.js';

/** What each scope lets a connector do, as the consent page says it. */
export const SCOPE_TEXT: Record<string, string> = {
  'mcp:read': 'See your diary, weight, targets, foods and recipes',
  'mcp:write': 'Log food and weight, create foods, share recipes, and edit entries',
  'mcp:destroy': 'Delete diary entries and weigh-ins',
};

const authorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2000).optional(),
  scope: z.string().max(200).optional(),
  /** RFC 8707; this server has one resource, so it's informational. */
  resource: z.string().max(2000).optional(),
});

const tokenBody = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_verifier: z.string().min(1),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    scope: z.string().optional(),
  }),
]);

const registerBody = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

function sendOAuthError(reply: FastifyReply, err: unknown) {
  if (err instanceof OAuthError) {
    return reply
      .status(err.status)
      .header('cache-control', 'no-store')
      .send({ error: err.error, error_description: err.message });
  }
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    return reply.status(400).send({
      error: 'invalid_request',
      error_description: `${issue?.path.join('.') || 'request'}: ${issue?.message ?? 'invalid'}`,
    });
  }
  throw err;
}

/**
 * OAuth 2.1 authorization server for MCP connectors (plan-11 S8; MCP
 * authorization spec): discovery documents, dynamic client registration
 * (RFC 7591), the authorization code flow with PKCE (S256 only) and rotating
 * refresh tokens. People sign in on our consent page with their password.
 */
export const oauthRoutes: FastifyPluginAsync<{ config: Config }> = async (app, { config }) => {
  if (!config.MCP_ENABLED) return;
  const oauth = new OAuthService(app.deps.db);
  const base = config.PUBLIC_URL;
  const authLimit = { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '15 minutes' };
  const consentHtml = await readFile(new URL('consent.html', publicDir), 'utf8');

  // The token endpoint takes form posts (RFC 6749).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const resourceMetadata = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'MacroTracker',
  };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, { schema: { hide: true } }, async () => resourceMetadata);
  }
  app.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async () => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...SCOPES],
  }));

  app.post(
    '/oauth/register',
    { config: { rateLimit: authLimit }, schema: { hide: true } },
    async (req, reply) => {
      try {
        const b = registerBody.parse(req.body);
        const { client, secret } = await oauth.register(b);
        await audit(app.deps.db, req, {
          event: 'oauth.client_registered',
          details: { client_id: client.id, name: client.name },
        });
        return reply
          .status(201)
          .header('cache-control', 'no-store')
          .send({
            client_id: client.id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: client.name,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: client.authMethod,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
          });
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  // The consent page; it reads the request from its own URL and asks /oauth/authorize/info.
  app.get('/oauth/authorize', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(consentHtml),
  );

  app.get('/oauth/authorize/info', { schema: { hide: true } }, async (req, reply) => {
    try {
      const q = authorizeQuery.parse(req.query);
      const client = await oauth.checkRequest(q);
      const scopes = parseScopes(q.scope);
      return {
        client_name: client.name,
        redirect_host: new URL(q.redirect_uri).host,
        scopes: scopes.map((x) => ({ scope: x, text: SCOPE_TEXT[x] ?? x })),
      };
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  app.post(
    '/oauth/authorize',
    { config: { rateLimit: authLimit }, schema: { hide: true } },
    async (req: FastifyRequest, reply) => {
      try {
        const body = z
          .object({
            query: authorizeQuery,
            approve: z.boolean(),
            email: z.string().max(320).optional(),
            password: z.string().max(256).optional(),
          })
          .parse(req.body);
        const q = body.query;
        const client = await oauth.checkRequest(q);
        const scopes = parseScopes(q.scope);
        const back = new URL(q.redirect_uri);
        if (q.state !== undefined) back.searchParams.set('state', q.state);
        back.searchParams.set('iss', base);
        if (!body.approve) {
          back.searchParams.set('error', 'access_denied');
          return { redirect: back.toString() };
        }
        if (!body.email || !body.password) throw new OAuthError('invalid_request', 'Sign in to approve');
        // Prove the password; this sign-in isn't kept.
        let userId: string;
        try {
          const gs = await app.deps.gotrue.passwordGrant(body.email.toLowerCase(), body.password, req.ip);
          userId = gs.user.id;
          await app.deps.gotrue.logout(gs.access_token, 'local').catch(() => undefined);
        } catch (err) {
          if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 401)) {
            await audit(app.deps.db, req, {
              event: 'oauth.login_failed',
              details: { email: body.email.toLowerCase(), client_id: client.id },
            });
            throw new OAuthError('access_denied', 'Wrong email or password', 401);
          }
          throw err;
        }
        const code = await oauth.issueCode(userId, {
          clientId: client.id,
          redirectUri: q.redirect_uri,
          challenge: q.code_challenge,
          scopes,
        });
        await audit(app.deps.db, req, {
          event: 'oauth.approved',
          userId,
          details: { client_id: client.id, client: client.name, scopes },
        });
        back.searchParams.set('code', code);
        return { redirect: back.toString() };
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  app.post(
    '/oauth/token',
    { config: { rateLimit: authLimit }, schema: { hide: true } },
    async (req, reply) => {
      try {
        const b = tokenBody.parse(req.body);
        // client_secret_basic, or client_id (+ secret) in the body.
        let clientId = b.client_id;
        let secret = b.client_secret;
        const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
        if (basic) {
          const [id, sec] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
          clientId = decodeURIComponent(id ?? '');
          secret = decodeURIComponent(sec ?? '');
        }
        if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
        const client = await oauth.client(clientId);
        if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
        oauth.authenticateClient(client, secret);
        const tokens =
          b.grant_type === 'authorization_code'
            ? await oauth.exchangeCode({
                client,
                code: b.code,
                redirectUri: b.redirect_uri,
                verifier: b.code_verifier,
              })
            : await oauth.refresh({ client, refreshToken: b.refresh_token });
        return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(tokens);
      } catch (err) {
        return sendOAuthError(reply, err);
      }
    },
  );

  // Connected apps, for Settings.
  const connection = z
    .object({
      id: z.uuid(),
      client_name: z.string(),
      scopes: z.array(z.string()),
      created_at: z.string(),
      last_used_at: z.string().nullable(),
    })
    .meta({ id: 'Connection' });
  app.get(
    '/v1/connections',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Apps connected with OAuth (MCP connectors)',
        security: [{ bearer: [] }],
        response: { 200: z.array(connection) },
      },
    },
    async (req) =>
      (await oauth.grants(req.auth!.userId)).map((g) => ({
        id: g.id,
        client_name: g.clientName,
        scopes: g.scopes,
        created_at: g.createdAt.toISOString(),
        last_used_at: g.lastUsedAt?.toISOString() ?? null,
      })),
  );
  app.delete(
    '/v1/connections/:id',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Disconnect an app (its tokens stop working at once)',
        security: [{ bearer: [] }],
        params: z.object({ id: z.uuid() }),
        response: { 204: z.undefined(), 404: errorBody },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await oauth.revoke(req.auth!.userId, id)))
        throw new AppError(404, 'not_found', 'No such connection');
      await audit(app.deps.db, req, {
        event: 'oauth.revoked',
        userId: req.auth!.userId,
        details: { grant_id: id },
      });
      return reply.status(204).send();
    },
  );
};
