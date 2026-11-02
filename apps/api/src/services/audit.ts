import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

export interface AuditEntry {
  event: string;
  userId?: string | null;
  actorId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Records a security-relevant event. Failing to audit must never fail the
 * request it describes, so errors are logged and swallowed.
 */
export async function audit(db: Db | Tx, req: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      event: entry.event,
      userId: entry.userId ?? null,
      actorId: entry.actorId ?? entry.userId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      requestId: req.id,
      details: entry.details ?? null,
    });
  } catch (err) {
    req.log.error({ err, event: entry.event }, 'audit write failed');
  }
}
