import { randomUUID } from 'node:crypto';
import type { Session } from '@macrotracker/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { GoTrue } from '../../src/services/gotrue.js';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; run integration tests with \`make test-int\``);
  return v;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: env('TEST_DATABASE_URL'),
    GOTRUE_URL: env('GOTRUE_URL'),
    JWT_SECRET: env('JWT_SECRET'),
    PUBLIC_URL: 'http://localhost:8080',
    WEB_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    ...overrides,
  });
}

export const gotrue = new GoTrue(env('GOTRUE_URL'), env('JWT_SECRET'), 'macrotracker-auth');

/** Schema owner: bypasses row-level security, for arranging and inspecting test data. */
export const owner = new pg.Pool({ connectionString: env('TEST_MIGRATION_DATABASE_URL'), max: 2 });

const apps: FastifyInstance[] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

export async function testApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(overrides), logger: false });
  apps.push(app);
  return app;
}

export const uniqueEmail = (tag = 'user') => `${tag}-${randomUUID().slice(0, 8)}@example.test`;
export const PASSWORD = 'correct-horse-battery';

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** A confirmed GoTrue account plus its app_users row. */
export async function createUser(role: 'admin' | 'member' = 'member', tag?: string): Promise<TestUser> {
  const email = uniqueEmail(tag ?? role);
  const user = await gotrue.adminCreateUser(email, PASSWORD);
  await owner.query('insert into app.app_users (user_id, role) values ($1, $2)', [user.id, role]);
  return { id: user.id, email, password: PASSWORD };
}

export async function login(
  app: FastifyInstance,
  user: TestUser,
  opts: { client?: 'web' | 'app'; device?: string; password?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      email: user.email,
      password: opts.password ?? user.password,
      device: { name: opts.device ?? 'Test phone', platform: 'ios' },
      client: opts.client ?? 'app',
    },
  });
}

export async function session(app: FastifyInstance, user: TestUser, device?: string): Promise<Session> {
  const res = await login(app, user, { device });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return res.json<Session>();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Pulls `token_hash` out of an invite/reset URL's fragment. */
export function tokenHashOf(url: string): string {
  const hash = new URL(url).hash.slice(1);
  const value = new URLSearchParams(hash).get('token_hash');
  if (!value) throw new Error(`no token_hash in ${url}`);
  return value;
}
