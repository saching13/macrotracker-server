import type { Me, Session } from '@macrotracker/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  bearer,
  createUser,
  gotrue,
  login,
  owner,
  PASSWORD,
  session,
  testApp,
  uniqueEmail,
} from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

type Cookie = { name: string; value: string; httpOnly?: boolean; sameSite?: string; path?: string };

function cookieOf(res: { cookies: Cookie[] }, name: string) {
  return res.cookies.find((c) => c.name === name);
}

describe('password login', () => {
  it('returns a session and records the device', async () => {
    const user = await createUser();
    const res = await login(app, user, { device: 'My iPhone' });
    expect(res.statusCode).toBe(200);
    const s = res.json<Session>();
    expect(s.refresh_token).toBeTruthy();
    expect(s.user).toMatchObject({ id: user.id, email: user.email, role: 'member' });

    const me = await app.inject({ url: '/v1/me', headers: bearer(s.access_token) });
    expect(me.statusCode).toBe(200);
    expect(me.json<Me>().id).toBe(user.id);

    const devices = await app.inject({ url: '/v1/devices', headers: bearer(s.access_token) });
    expect(devices.json()).toEqual([
      expect.objectContaining({ id: s.device_id, name: 'My iPhone', current: true }),
    ]);
  });

  it('rejects a wrong password without saying which part was wrong, and audits it', async () => {
    const user = await createUser();
    const res = await login(app, user, { password: 'not-the-password' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    const audit = await owner.query(
      "select 1 from app.audit_events where event = 'auth.login_failed' and details->>'email' = $1",
      [user.email],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses a GoTrue account that was never provisioned here', async () => {
    const email = uniqueEmail('orphan');
    await gotrue.adminCreateUser(email, PASSWORD);
    const res = await login(app, { id: '', email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_provisioned');
  });

  it('rejects requests without a valid bearer token', async () => {
    expect((await app.inject({ url: '/v1/me' })).statusCode).toBe(401);
    const res = await app.inject({ url: '/v1/me', headers: bearer('not.a.jwt') });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
  });

  it('rate-limits repeated sign-in attempts', async () => {
    const strict = await testApp({ AUTH_RATE_LIMIT_MAX: '2' });
    const user = await createUser();
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await login(strict, user, { password: 'wrong-wrong' })).statusCode);
    expect(codes).toEqual([401, 401, 429]);
  });
});

describe('app refresh', () => {
  it('rotates the refresh token and keeps the device', async () => {
    const user = await createUser();
    const s = await session(app, user);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: s.refresh_token },
    });
    expect(res.statusCode).toBe(200);
    const next = res.json<Session>();
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(s.refresh_token);
    expect(next.device_id).toBe(s.device_id);
  });
});

describe('web session', () => {
  it('keeps the refresh token in an httpOnly cookie and demands the CSRF header', async () => {
    const user = await createUser();
    const res = await login(app, user, { client: 'web' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Session>().refresh_token).toBeUndefined();
    const rt = cookieOf(res, 'mt_rt');
    const csrf = cookieOf(res, 'mt_csrf');
    expect(rt).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/v1/auth' });
    expect(csrf?.httpOnly).toBeFalsy();

    const cookies = { mt_rt: rt!.value, mt_csrf: csrf!.value };
    const noHeader = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('csrf_failed');

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies,
      headers: { 'x-csrf-token': csrf!.value },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok, 'mt_rt')?.value).not.toBe(rt!.value);
  });
});

describe('signing out', () => {
  it('logout kills the access token and the refresh token', async () => {
    const user = await createUser();
    const s = await session(app, user);
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(s.access_token) });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({ url: '/v1/me', headers: bearer(s.access_token) });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('session_revoked');
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: s.refresh_token },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('revoking another device signs it out immediately', async () => {
    const user = await createUser();
    const phone = await session(app, user, 'Phone');
    const laptop = await session(app, user, 'Laptop');
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${phone.device_id}`,
      headers: bearer(laptop.access_token),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/me', headers: bearer(phone.access_token) })).statusCode).toBe(401);
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: phone.refresh_token },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().error.code).toBe('session_revoked');
    expect((await app.inject({ url: '/v1/me', headers: bearer(laptop.access_token) })).statusCode).toBe(200);
  });

  it("can't revoke someone else's device", async () => {
    const a = await session(app, await createUser());
    const b = await session(app, await createUser());
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${b.device_id}`,
      headers: bearer(a.access_token),
    });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/me', headers: bearer(b.access_token) })).statusCode).toBe(200);
  });
});

describe('change password', () => {
  it('needs the current password, then signs out every other device', async () => {
    const user = await createUser();
    const phone = await session(app, user, 'Phone');
    const laptop = await session(app, user, 'Laptop');

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: bearer(laptop.access_token),
      payload: { current_password: 'nope-nope-nope', new_password: 'a-brand-new-password' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: bearer(laptop.access_token),
      payload: { current_password: PASSWORD, new_password: 'a-brand-new-password' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/me', headers: bearer(phone.access_token) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/me', headers: bearer(laptop.access_token) })).statusCode).toBe(200);
    expect((await login(app, user)).statusCode).toBe(401);
    expect((await login(app, user, { password: 'a-brand-new-password' })).statusCode).toBe(200);
  });
});
