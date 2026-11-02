import type { Session } from '@macrotracker/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, createUser, login, owner, session, testApp, tokenHashOf, uniqueEmail } from './helpers.js';

let app: FastifyInstance;
let admin: Session;
beforeAll(async () => {
  app = await testApp();
  admin = await session(app, await createUser('admin'));
});

const asAdmin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: bearer(admin.access_token) });

function completeLink(type: 'invite' | 'recovery', url: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/complete-link',
    payload: {
      type,
      token_hash: tokenHashOf(url),
      password,
      device: { name: 'Browser', platform: 'web' },
      client: 'app',
    },
  });
}

describe('admin guard', () => {
  it('turns away members and personal access tokens', async () => {
    const member = await session(app, await createUser('member'));
    const res = await app.inject({ url: '/v1/admin/users', headers: bearer(member.access_token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');

    const pat = await asAdmin('POST', '/v1/tokens', { name: 'agent', scopes: ['mcp:read'] });
    const viaPat = await app.inject({ url: '/v1/admin/users', headers: bearer(pat.json().token) });
    expect(viaPat.statusCode).toBe(403);
  });
});

describe('invites', () => {
  it('creates a pending account whose link sets the password and signs in', async () => {
    const email = uniqueEmail('invitee');
    const res = await asAdmin('POST', '/v1/admin/invites', { email, display_name: 'Spouse' });
    expect(res.statusCode).toBe(201);
    const { url, user_id } = res.json();
    expect(url).toMatch(/^http:\/\/localhost:8080\/accept-invite#type=invite&token_hash=/);

    const listed = (await asAdmin('GET', '/v1/admin/users')).json();
    expect(listed).toContainEqual(
      expect.objectContaining({ id: user_id, email, pending: true, display_name: 'Spouse' }),
    );

    const done = await completeLink('invite', url, 'spouse-password-1');
    expect(done.statusCode).toBe(200);
    expect(done.json().user).toMatchObject({ id: user_id, role: 'member' });
    expect((await login(app, { id: user_id, email, password: 'spouse-password-1' })).statusCode).toBe(200);

    // A link works once.
    expect((await completeLink('invite', url, 'another-password')).statusCode).toBe(401);
  });

  it('refuses a second account for the same email', async () => {
    const email = uniqueEmail('dup');
    expect((await asAdmin('POST', '/v1/admin/invites', { email })).statusCode).toBe(201);
    const again = await asAdmin('POST', '/v1/admin/invites', { email });
    expect(again.statusCode).toBe(409);
  });

  it('serves the page the link opens', async () => {
    const page = await app.inject({ url: '/accept-invite' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await app.inject({ url: '/assets/link.js' })).statusCode).toBe(200);
  });
});

describe('password reset links', () => {
  it('sets a new password and signs out every existing device', async () => {
    const user = await createUser();
    const before = await session(app, user);
    const res = await asAdmin('POST', `/v1/admin/users/${user.id}/reset-link`);
    expect(res.statusCode).toBe(200);
    const done = await completeLink('recovery', res.json().url, 'reset-password-123');
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: bearer(before.access_token) })).statusCode).toBe(401);
    expect((await login(app, user)).statusCode).toBe(401);
    expect((await login(app, user, { password: 'reset-password-123' })).statusCode).toBe(200);
  });
});

describe('roles and deletion', () => {
  it('promotes and demotes, but never removes the last admin', async () => {
    const member = await createUser();
    expect((await asAdmin('PATCH', `/v1/admin/users/${member.id}`, { role: 'admin' })).statusCode).toBe(204);
    expect((await asAdmin('PATCH', `/v1/admin/users/${member.id}`, { role: 'member' })).statusCode).toBe(204);

    // Make the caller the only admin, then try to demote them.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query("set local app.is_admin = 'on'");
      await c.query("update app.app_users set role = 'member' where role = 'admin' and user_id <> $1", [
        admin.user.id,
      ]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const last = await asAdmin('PATCH', `/v1/admin/users/${admin.user.id}`, { role: 'member' });
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('last_admin');
  });

  it('deleting an account removes its data everywhere', async () => {
    const user = await createUser();
    const s = await session(app, user);
    await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: bearer(s.access_token),
      payload: { name: 't', scopes: ['mcp:read'] },
    });

    expect((await asAdmin('DELETE', `/v1/admin/users/${user.id}`)).statusCode).toBe(204);
    for (const table of ['app_users', 'devices', 'api_tokens']) {
      const rows = await owner.query(`select 1 from app.${table} where user_id = $1`, [user.id]);
      expect(rows.rowCount, table).toBe(0);
    }
    expect((await app.inject({ url: '/v1/me', headers: bearer(s.access_token) })).statusCode).not.toBe(200);
    expect((await asAdmin('DELETE', `/v1/admin/users/${admin.user.id}`)).statusCode).toBe(409);
  });

  it('keeps an audit trail of admin actions', async () => {
    const res = await asAdmin('GET', '/v1/admin/audit?limit=200');
    expect(res.statusCode).toBe(200);
    const events = res.json().map((e: { event: string }) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['admin.user_invited', 'admin.user_deleted', 'admin.role_changed']),
    );
  });
});
