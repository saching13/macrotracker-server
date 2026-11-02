import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url(),
  /** Owner credentials; when set, migrations run on boot. */
  MIGRATION_DATABASE_URL: z.url().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  GOTRUE_URL: z.url(),
  /** HS256 secret GoTrue accepts for service-role (admin) calls. */
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('macrotracker-auth'),

  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  WEB_ORIGINS: list,
  /** `true`, or a comma-separated list of proxy addresses/CIDRs to trust for X-Forwarded-For. */
  TRUST_PROXY: z.string().optional(),

  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(5 * 1024 * 1024),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export function trustProxySetting(value: string | undefined): boolean | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return value;
}
