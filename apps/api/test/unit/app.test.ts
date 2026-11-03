import { API_VERSION } from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';

// No database or GoTrue: only routes that never touch them are exercised.
const fakeDatabase = { db: {} as Database['db'], pool: {} as Database['pool'], close: async () => {} };
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused@localhost/unused',
  GOTRUE_URL: 'http://127.0.0.1:1',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'http://localhost:8080',
  WEB_ORIGINS: 'http://localhost:5173',
  BODY_LIMIT_BYTES: '2048',
});

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ config, database: fakeDatabase, logger: false });
});
afterAll(() => app.close());

describe('request ids', () => {
  it('echoes a well-formed client id', async () => {
    const res = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'app-1234-abcd' } });
    expect(res.headers['x-request-id']).toBe('app-1234-abcd');
  });

  it('replaces a malformed one', async () => {
    const res = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'bad id\n' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error shape', () => {
  it('returns JSON 404s carrying the request id', async () => {
    const res = await app.inject({ url: '/nope?secret=1' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).not.toContain('secret');
    expect(body.error.request_id).toBe(res.headers['x-request-id']);
  });

  it('reports validation errors as 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('says how big a too-large body was and what the limit is', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'a@b.test', password: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'body_too_large', details: { limit_bytes: 2048 } });
  });
});

describe('meta and docs', () => {
  it('identifies itself', async () => {
    const res = await app.inject({ url: '/v1/meta' });
    expect(res.json()).toMatchObject({
      name: 'macrotracker-server',
      api_version: API_VERSION,
      signup: 'invite',
    });
  });

  it('publishes an OpenAPI 3.1 document', async () => {
    const doc = (await app.inject({ url: '/v1/openapi.json' })).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/auth/login', '/v1/me', '/v1/admin/invites']),
    );
    expect(doc.components.schemas).toHaveProperty('Session');
  });
});

describe('browser protections', () => {
  it('sends security headers', async () => {
    const res = await app.inject({ url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Plain HTTP (a tailnet address): upgrading would break the web app's assets.
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('allows only configured origins', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
