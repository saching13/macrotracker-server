import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, createUser, session, testApp, type TestUser } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const BASE = 'http://localhost:8080';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(method?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: {
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      ...(method ? { token_endpoint_auth_method: method } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ client_id: string; client_secret?: string; token_endpoint_auth_method: string }>();
}

/** The consent page's request: approve as `user`, returns the redirect URL. */
async function approve(
  user: TestUser,
  clientId: string,
  challenge: string,
  opts: { password?: string; scope?: string } = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    payload: {
      query: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        ...(opts.scope ? { scope: opts.scope } : {}),
      },
      approve: true,
      email: user.email,
      password: opts.password ?? user.password,
    },
  });
  return res;
}

const form = (body: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(body).toString(),
});

async function token(body: Record<string, string>, headers: Record<string, string> = {}) {
  const f = form(body);
  return app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { ...f.headers, ...headers },
    payload: f.payload,
  });
}

describe('OAuth for MCP connectors', () => {
  it('publishes discovery documents and points 401s at them', async () => {
    const prm = (await app.inject({ url: '/.well-known/oauth-protected-resource' })).json();
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(as).toMatchObject({
      issuer: BASE,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
    const page = await app.inject({ url: '/oauth/authorize?client_id=x' });
    expect(page.headers['content-type']).toContain('text/html');
  });

  it('runs the whole flow: register, consent, code with PKCE, tokens, refresh, revoke', async () => {
    const user = await createUser();
    const client = await register('none');
    const { verifier, challenge } = pkce();

    const info = await app.inject({
      url: `/oauth/authorize/info?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    });
    expect(info.json()).toMatchObject({ client_name: 'Claude', redirect_host: 'claude.ai' });

    expect(
      (await approve(user, client.client_id, challenge, { password: 'wrong-password-1' })).statusCode,
    ).toBe(401);
    const ok = await approve(user, client.client_id, challenge);
    expect(ok.statusCode, ok.body).toBe(200);
    const back = new URL(ok.json<{ redirect: string }>().redirect);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(BASE);
    const code = back.searchParams.get('code')!;

    const exchange = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
    };
    const t = await token(exchange);
    expect(t.statusCode, t.body).toBe(200);
    expect(t.headers['cache-control']).toBe('no-store');
    const tokens = t.json<{
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    }>();
    expect(tokens.access_token).toMatch(/^mt_oat_/);
    expect(tokens.scope).toBe('mcp:read mcp:write');

    // A code works once.
    expect((await token(exchange)).json()).toMatchObject({ error: 'invalid_grant' });

    // The token reads data and lists MCP tools.
    const status = await app.inject({ url: '/v1/day?date=2026-11-03', headers: bearer(tokens.access_token) });
    expect(status.statusCode).toBe(200);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(tokens.access_token), accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.body).toContain('log_food');
    // But it can't manage the account.
    expect((await app.inject({ url: '/v1/tokens', headers: bearer(tokens.access_token) })).statusCode).toBe(
      403,
    );

    // Refresh rotates.
    const r = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(r.statusCode, r.body).toBe(200);
    const again = r.json<{ access_token: string; refresh_token: string }>();
    expect(again.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        })
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });

    // The person sees the connection, not its tokens, and can disconnect it.
    const web = bearer((await session(app, user)).access_token);
    const pats = await app.inject({ url: '/v1/tokens', headers: web });
    expect(pats.json()).toEqual([]);
    const list = await app.inject({ url: '/v1/connections', headers: web });
    const [conn] = list.json<{ id: string; client_name: string }[]>();
    expect(conn).toMatchObject({ client_name: 'Claude' });
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/connections/${conn!.id}`, headers: web })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: '/v1/day?date=2026-11-03', headers: bearer(again.access_token) })).statusCode,
    ).toBe(401);
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: again.refresh_token,
          client_id: client.client_id,
        })
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
  });

  it('checks PKCE, the redirect URI and the client', async () => {
    const user = await createUser();
    const client = await register('none');
    const { challenge } = pkce();
    const code = new URL(
      (await approve(user, client.client_id, challenge)).json<{ redirect: string }>().redirect,
    ).searchParams.get('code')!;
    const bad = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: pkce().verifier,
    });
    expect(bad.json()).toMatchObject({ error: 'invalid_grant' });

    const wrongRedirect = await app.inject({
      url: `/oauth/authorize/info?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'https://evil.example/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    });
    expect(wrongRedirect.statusCode).toBe(400);

    const insecure = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['http://evil.example/cb'] },
    });
    expect(insecure.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nope' })).statusCode,
    ).toBe(401);
  });

  it('confidential clients authenticate with their secret (HTTP Basic)', async () => {
    const user = await createUser();
    const client = await register(); // defaults to client_secret_basic
    expect(client.client_secret).toBeTruthy();
    const { verifier, challenge } = pkce();
    const code = new URL(
      (await approve(user, client.client_id, challenge, { scope: 'mcp:read' })).json<{ redirect: string }>()
        .redirect,
    ).searchParams.get('code')!;
    const body = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier };
    const basic = (secret: string) => ({
      authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString('base64')}`,
    });
    expect((await token(body, basic('wrong'))).statusCode).toBe(401);
    const ok = await token(body, basic(client.client_secret!));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ scope: 'mcp:read' });
  });
});
