import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

describe('system endpoints', () => {
  it('is ready when the database and GoTrue answer', async () => {
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('reports not ready when GoTrue is unreachable', async () => {
    const broken = await testApp({ GOTRUE_URL: 'http://127.0.0.1:1' });
    const res = await broken.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', failing: ['auth'] });
  });
});
