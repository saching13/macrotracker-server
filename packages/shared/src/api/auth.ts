import { z } from 'zod';

/**
 * Personal-access-token scopes. A scope is added only when the endpoints that
 * check it ship; session (password) logins implicitly hold every scope.
 */
export const SCOPES = ['mcp:read', 'mcp:write', 'mcp:destroy'] as const;
export const scope = z.enum(SCOPES);
export type Scope = z.infer<typeof scope>;

/** Prefix lets secret scanners and humans recognize a leaked token. */
export const PAT_PREFIX = 'mt_pat_';

export const role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof role>;

export const platform = z.enum(['ios', 'android', 'web', 'cli', 'other']);

export const deviceInfo = z.object({
  name: z.string().trim().min(1).max(80),
  platform,
});

export const password = z.string().min(10).max(256);

/** `web` keeps the refresh token in an httpOnly cookie; `app` gets it in the body. */
export const clientKind = z.enum(['web', 'app']).default('app');

export const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
  device: deviceInfo,
  client: clientKind,
});

export const refreshBody = z.object({
  refresh_token: z.string().min(1).max(512).optional(),
});

export const acceptLinkBody = z.object({
  token_hash: z.string().min(10).max(512),
  password,
  device: deviceInfo,
  client: clientKind,
});

export const changePasswordBody = z.object({
  current_password: z.string().min(1).max(256),
  new_password: password,
});

export const me = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role,
    display_name: z.string().nullable(),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof me>;

export const session = z
  .object({
    access_token: z.string(),
    token_type: z.literal('bearer'),
    expires_in: z.number().int(),
    expires_at: z.number().int(),
    /** Absent for web clients: it lives in the httpOnly cookie instead. */
    refresh_token: z.string().optional(),
    device_id: z.uuid(),
    user: me,
  })
  .meta({ id: 'Session' });
export type Session = z.infer<typeof session>;

export const updateMeBody = z.object({
  display_name: z.string().trim().min(1).max(80).nullable(),
});

export const device = z
  .object({
    id: z.uuid(),
    name: z.string(),
    platform,
    created_at: z.string(),
    last_seen_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    current: z.boolean(),
  })
  .meta({ id: 'Device' });

export const apiToken = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(scope),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
  })
  .meta({ id: 'ApiToken' });

export const createTokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(scope).min(1),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

export const createdToken = apiToken
  .extend({
    /** Shown exactly once; only its hash is stored. */
    token: z.string(),
  })
  .meta({ id: 'CreatedApiToken' });
