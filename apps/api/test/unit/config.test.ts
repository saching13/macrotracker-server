import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, trustProxySetting } from '../../src/config.js';
import { generatePat, hashToken } from '../../src/services/tokens.js';

const base = {
  DATABASE_URL: 'postgres://u:p@db/postgres',
  GOTRUE_URL: 'http://auth:9999',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://mt.example.ts.net/',
};

describe('config', () => {
  it('applies defaults and normalizes values', () => {
    const c = loadConfig({ ...base, WEB_ORIGINS: ' http://a.test , http://b.test,' });
    expect(c.PORT).toBe(8080);
    expect(c.PUBLIC_URL).toBe('https://mt.example.ts.net');
    expect(c.WEB_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails fast and names every bad setting', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short', DATABASE_URL: 'nope' })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, JWT_SECRET: 'short', DATABASE_URL: 'nope' });
    } catch (err) {
      expect((err as Error).message).toMatch(/JWT_SECRET/);
      expect((err as Error).message).toMatch(/DATABASE_URL/);
    }
  });

  it('parses the trust-proxy setting', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});

describe('personal access tokens', () => {
  it('are random, prefixed and hashed', () => {
    const a = generatePat();
    const b = generatePat();
    expect(a.token).toMatch(/^mt_pat_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.prefix).toBe(a.token.slice(0, 13));
  });
});
