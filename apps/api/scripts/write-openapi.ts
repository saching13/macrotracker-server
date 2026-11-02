// Writes the OpenAPI document without a database or GoTrue: routes are
// registered but never called. Usage: tsx scripts/write-openapi.ts <out.json>
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db/client.js';

const out = process.argv[2] ?? 'openapi.json';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused@localhost/unused',
  GOTRUE_URL: 'http://localhost:9999',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'http://localhost:8080',
});
const app = await buildApp({
  config,
  logger: false,
  database: { db: {} as Database['db'], pool: {} as Database['pool'], close: async () => {} },
});
await app.ready();
writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log(`wrote ${out}`);
