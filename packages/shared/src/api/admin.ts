import { z } from 'zod';
import { role } from './auth.js';

export const adminUser = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role,
    display_name: z.string().nullable(),
    created_at: z.string(),
    invited_at: z.string().nullable(),
    last_sign_in_at: z.string().nullable(),
    /** True until the invite has been accepted. */
    pending: z.boolean(),
  })
  .meta({ id: 'AdminUser' });
export type AdminUser = z.infer<typeof adminUser>;

export const inviteBody = z.object({
  email: z.email().max(320),
  display_name: z.string().trim().min(1).max(80).optional(),
  role: role.default('member'),
});

/** No email is sent: the admin passes the link on themselves. */
export const linkResponse = z
  .object({
    user_id: z.uuid(),
    url: z.string(),
  })
  .meta({ id: 'ActionLink' });

export const updateUserBody = z.object({ role });

export const auditEvent = z
  .object({
    id: z.number().int(),
    event: z.string(),
    user_id: z.uuid().nullable(),
    actor_id: z.uuid().nullable(),
    ip: z.string().nullable(),
    request_id: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'AuditEvent' });

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().optional(),
});
