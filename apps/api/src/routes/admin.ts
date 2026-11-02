import {
  adminUser,
  auditEvent,
  auditQuery,
  errorBody,
  idParams,
  inviteBody,
  linkResponse,
  updateUserBody,
  type AdminUser,
} from '@macrotracker/shared';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext, type Tx } from '../db/client.js';
import { appUsers, auditEvents } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { authOf, rlsFor } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import type { GoTrueUser, LinkType } from '../services/gotrue.js';

/** Builds the page URL a link points at. The token rides in the fragment so it never reaches server logs. */
export function actionUrl(publicUrl: string, type: LinkType, tokenHash: string): string {
  const page = type === 'invite' ? 'accept-invite' : 'reset-password';
  return `${publicUrl}/${page}#type=${type}&token_hash=${encodeURIComponent(tokenHash)}`;
}

async function adminCount(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appUsers)
    .where(eq(appUsers.role, 'admin'));
  return row?.n ?? 0;
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config, db, gotrue } = app.deps;
  const guard = app.requireAuth({ admin: true });
  const security = [{ bearer: [] }];

  app.get(
    '/users',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: 'All accounts on this server',
        security,
        response: { 200: z.array(adminUser) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const [rows, gtUsers] = await Promise.all([
        withContext(db, rlsFor(auth), (tx) => tx.select().from(appUsers)),
        gotrue.adminListUsers(),
      ]);
      const byId = new Map<string, GoTrueUser>(gtUsers.map((u) => [u.id, u]));
      return rows
        .map((r): AdminUser | null => {
          const u = byId.get(r.userId);
          if (!u) return null;
          return {
            id: r.userId,
            email: u.email ?? '',
            role: r.role,
            display_name: r.displayName,
            created_at: r.createdAt.toISOString(),
            invited_at: u.invited_at ?? null,
            last_sign_in_at: u.last_sign_in_at ?? null,
            pending: !u.last_sign_in_at,
          };
        })
        .filter((u): u is AdminUser => u !== null)
        .sort((a, b) => a.email.localeCompare(b.email));
    },
  );

  app.post(
    '/invites',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: 'Invite someone',
        description:
          'Creates the account and returns an invite link for the admin to pass on. No email is sent.',
        security,
        body: inviteBody,
        response: { 201: linkResponse, 409: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const email = req.body.email.toLowerCase();
      const link = await gotrue.adminGenerateLink('invite', email);
      let inserted: { userId: string }[];
      try {
        inserted = await withContext(db, rlsFor(auth), (tx) =>
          tx
            .insert(appUsers)
            .values({ userId: link.id, role: req.body.role, displayName: req.body.display_name ?? null })
            .onConflictDoNothing()
            .returning({ userId: appUsers.userId }),
        );
      } catch (err) {
        // Don't leave behind a GoTrue account nobody can use, but never touch
        // one that has already been signed in to.
        if (!link.last_sign_in_at) await gotrue.adminDeleteUser(link.id).catch(() => undefined);
        throw err;
      }
      // GoTrue re-issues an invite for a pending email instead of refusing it.
      if (inserted.length === 0) throw conflict('email_exists', 'A user with this email already exists');
      await audit(db, req, {
        event: 'admin.user_invited',
        userId: link.id,
        actorId: auth.userId,
        details: { email, role: req.body.role },
      });
      return reply
        .status(201)
        .send({ user_id: link.id, url: actionUrl(config.PUBLIC_URL, 'invite', link.hashed_token) });
    },
  );

  app.post(
    '/users/:id/reset-link',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: 'Make a password-reset link',
        description: 'Also works for someone whose invite expired.',
        security,
        params: idParams,
        response: { 200: linkResponse, 404: errorBody },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const [row] = await withContext(db, rlsFor(auth), (tx) =>
        tx.select().from(appUsers).where(eq(appUsers.userId, req.params.id)),
      );
      if (!row) throw notFound('No such user');
      const user = await gotrue.adminGetUser(req.params.id);
      const link = await gotrue.adminGenerateLink('recovery', user.email ?? '');
      await audit(db, req, { event: 'admin.reset_link', userId: row.userId, actorId: auth.userId });
      return { user_id: row.userId, url: actionUrl(config.PUBLIC_URL, 'recovery', link.hashed_token) };
    },
  );

  app.patch(
    '/users/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: "Change someone's role",
        security,
        params: idParams,
        body: updateUserBody,
        response: { 204: z.undefined(), 404: errorBody, 409: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await withContext(db, rlsFor(auth), async (tx) => {
        const [row] = await tx
          .select()
          .from(appUsers)
          .where(eq(appUsers.userId, req.params.id))
          .for('update');
        if (!row) throw notFound('No such user');
        if (row.role === 'admin' && req.body.role !== 'admin' && (await adminCount(tx)) <= 1) {
          throw conflict('last_admin', 'The server needs at least one admin');
        }
        await tx.update(appUsers).set({ role: req.body.role }).where(eq(appUsers.userId, row.userId));
      });
      await audit(db, req, {
        event: 'admin.role_changed',
        userId: req.params.id,
        actorId: auth.userId,
        details: { role: req.body.role },
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/users/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: 'Delete an account and all its data',
        security,
        params: idParams,
        response: { 204: z.undefined(), 404: errorBody, 409: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      if (req.params.id === auth.userId)
        throw conflict('self_delete', 'You cannot delete your own account here');
      await withContext(db, rlsFor(auth), async (tx) => {
        const [row] = await tx.select().from(appUsers).where(eq(appUsers.userId, req.params.id));
        if (!row) throw notFound('No such user');
        if (row.role === 'admin' && (await adminCount(tx)) <= 1) {
          throw conflict('last_admin', 'The server needs at least one admin');
        }
      });
      // Cascades from auth.users through every app table.
      await gotrue.adminDeleteUser(req.params.id);
      await audit(db, req, { event: 'admin.user_deleted', userId: req.params.id, actorId: auth.userId });
      return reply.status(204).send();
    },
  );

  app.get(
    '/audit',
    {
      preHandler: guard,
      schema: {
        tags: ['admin'],
        summary: 'Security audit log, newest first',
        security,
        querystring: auditQuery,
        response: { 200: z.array(auditEvent) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { limit, before } = req.query;
      const rows = await withContext(db, rlsFor(auth), (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(before ? and(lt(auditEvents.id, before)) : undefined)
          .orderBy(desc(auditEvents.id))
          .limit(limit),
      );
      return rows.map((r) => ({
        id: r.id,
        event: r.event,
        user_id: r.userId,
        actor_id: r.actorId,
        ip: r.ip,
        request_id: r.requestId,
        details: r.details ?? null,
        created_at: r.createdAt.toISOString(),
      }));
    },
  );
};
