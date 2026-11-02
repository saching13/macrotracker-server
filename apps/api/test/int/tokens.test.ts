import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authOf } from '../../src/plugins/auth.js';
import { bearer, createUser, owner, session, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
  // Stand-ins for the MCP routes that will check these scopes.
  app.get('/test/read', { preHandler: app.requireAuth({ scope: 'mcp:read' }) }, async (req) => ({
    user: authOf(req).userId,
  }));
  app.get('/test/write', { preHandler: app.requireAuth({ scope: 'mcp:write' }) }, async () => ({ ok: true }));
});

async function createToken(accessToken: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/tokens', headers: bearer(accessToken), payload: body });
}

describe('personal access tokens', () => {
  it('is shown once, stored only as a hash, and works for its scopes', async () => {
    const user = await createUser();
    const s = await session(app, user);
    const res = await createToken(s.access_token, { name: 'Claude', scopes: ['mcp:read'] });
    expect(res.statusCode).toBe(201);
    const { token, id, prefix } = res.json();
    expect(token).toMatch(/^mt_pat_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(prefix)).toBe(true);

    const stored = await owner.query('select token_hash from app.api_tokens where id = $1', [id]);
    expect(stored.rows[0].token_hash).not.toContain(token.slice(7));

    const read = await app.inject({ url: '/test/read', headers: bearer(token) });
    expect(read.statusCode).toBe(200);
    expect(read.json().user).toBe(user.id);
    const me = await app.inject({ url: '/v1/me', headers: bearer(token) });
    expect(me.json().email).toBe(user.email);

    const write = await app.inject({ url: '/test/write', headers: bearer(token) });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('insufficient_scope');

    const list = await app.inject({ url: '/v1/tokens', headers: bearer(s.access_token) });
    expect(list.json()).toEqual([expect.not.objectContaining({ token: expect.anything() })]);
  });

  it("can't manage the account or mint more tokens", async () => {
    const s = await session(app, await createUser());
    const { token } = (
      await createToken(s.access_token, { name: 'Agent', scopes: ['mcp:read', 'mcp:write'] })
    ).json();
    for (const [method, url] of [
      ['GET', '/v1/tokens'],
      ['GET', '/v1/devices'],
      ['POST', '/v1/auth/logout'],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(token) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('session_required');
    }
    const mint = await createToken(token, { name: 'Child', scopes: ['mcp:read'] });
    expect(mint.statusCode).toBe(403);
  });

  it('stops working once revoked or expired', async () => {
    const s = await session(app, await createUser());
    const a = (await createToken(s.access_token, { name: 'A', scopes: ['mcp:read'] })).json();
    const b = (
      await createToken(s.access_token, { name: 'B', scopes: ['mcp:read'], expires_in_days: 1 })
    ).json();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/tokens/${a.id}`,
      headers: bearer(s.access_token),
    });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: '/test/read', headers: bearer(a.token) })).statusCode).toBe(401);

    await owner.query("update app.api_tokens set expires_at = now() - interval '1 minute' where id = $1", [
      b.id,
    ]);
    const expired = await app.inject({ url: '/test/read', headers: bearer(b.token) });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('token_expired');
  });

  it('rejects unknown scopes and unknown tokens', async () => {
    const s = await session(app, await createUser());
    expect((await createToken(s.access_token, { name: 'X', scopes: ['admin:*'] })).statusCode).toBe(400);
    const fake = await app.inject({ url: '/test/read', headers: bearer('mt_pat_' + 'a'.repeat(43)) });
    expect(fake.statusCode).toBe(401);
  });
});
