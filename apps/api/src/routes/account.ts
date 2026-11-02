import {
  apiToken,
  createdToken,
  createTokenBody,
  device,
  errorBody,
  idParams,
  me,
  updateMeBody,
} from '@macrotracker/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '../db/client.js';
import { apiTokens, appUsers, devices } from '../db/schema.js';
import { notFound } from '../errors.js';
import { authOf, rlsFor } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import { generatePat } from '../services/tokens.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The signed-in user's own account: profile, devices, access tokens. */
export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, gotrue } = app.deps;
  const security = [{ bearer: [] }];

  app.get(
    '/me',
    {
      preHandler: app.requireAuth(),
      schema: { tags: ['account'], summary: 'Who am I', security, response: { 200: me, 401: errorBody } },
    },
    async (req) => {
      const auth = authOf(req);
      const [user] = await withContext(db, rlsFor(auth), (tx) =>
        tx.select().from(appUsers).where(eq(appUsers.userId, auth.userId)),
      );
      const email = auth.email ?? (await gotrue.adminGetUser(auth.userId)).email ?? '';
      return { id: auth.userId, email, role: user!.role, display_name: user!.displayName };
    },
  );

  app.patch(
    '/me',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Update my profile',
        security,
        body: updateMeBody,
        response: { 200: me },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const [user] = await withContext(db, rlsFor(auth), (tx) =>
        tx
          .update(appUsers)
          .set({ displayName: req.body.display_name })
          .where(eq(appUsers.userId, auth.userId))
          .returning(),
      );
      return { id: auth.userId, email: auth.email ?? '', role: user!.role, display_name: user!.displayName };
    },
  );

  app.get(
    '/devices',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Devices signed in to my account',
        security,
        response: { 200: z.array(device) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const rows = await withContext(db, rlsFor(auth), (tx) =>
        tx.select().from(devices).orderBy(desc(devices.lastSeenAt)),
      );
      return rows.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform as z.infer<typeof device>['platform'],
        created_at: d.createdAt.toISOString(),
        last_seen_at: iso(d.lastSeenAt),
        revoked_at: iso(d.revokedAt),
        current: d.id === auth.deviceId,
      }));
    },
  );

  app.delete(
    '/devices/:id',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Sign a device out',
        description: 'Its access token stops working at once and its refresh token is refused.',
        security,
        params: idParams,
        response: { 204: z.undefined(), 404: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const updated = await withContext(db, rlsFor(auth), (tx) =>
        tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(and(eq(devices.id, req.params.id), isNull(devices.revokedAt)))
          .returning({ id: devices.id }),
      );
      if (updated.length === 0) throw notFound('No such signed-in device');
      await audit(db, req, {
        event: 'device.revoked',
        userId: auth.userId,
        details: { device_id: req.params.id },
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/tokens',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'My personal access tokens',
        security,
        response: { 200: z.array(apiToken) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const rows = await withContext(db, rlsFor(auth), (tx) =>
        tx.select().from(apiTokens).orderBy(desc(apiTokens.createdAt)),
      );
      return rows.map(toApiToken);
    },
  );

  app.post(
    '/tokens',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Create a personal access token (for MCP and agents)',
        description: 'The token is returned once; only its hash is kept.',
        security,
        body: createTokenBody,
        response: { 201: createdToken, 400: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { token, prefix, hash } = generatePat();
      const expiresAt = req.body.expires_in_days
        ? new Date(Date.now() + req.body.expires_in_days * 86_400_000)
        : null;
      const [row] = await withContext(db, rlsFor(auth), (tx) =>
        tx
          .insert(apiTokens)
          .values({
            userId: auth.userId,
            name: req.body.name,
            prefix,
            tokenHash: hash,
            scopes: [...new Set(req.body.scopes)],
            expiresAt,
          })
          .returning(),
      );
      await audit(db, req, {
        event: 'token.created',
        userId: auth.userId,
        details: { token_id: row!.id, scopes: row!.scopes },
      });
      return reply.status(201).send({ ...toApiToken(row!), token });
    },
  );

  app.delete(
    '/tokens/:id',
    {
      preHandler: app.requireAuth({ sessionOnly: true }),
      schema: {
        tags: ['account'],
        summary: 'Revoke a personal access token',
        security,
        params: idParams,
        response: { 204: z.undefined(), 404: errorBody },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const updated = await withContext(db, rlsFor(auth), (tx) =>
        tx
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, req.params.id), isNull(apiTokens.revokedAt)))
          .returning({ id: apiTokens.id }),
      );
      if (updated.length === 0) throw notFound('No such active token');
      await audit(db, req, {
        event: 'token.revoked',
        userId: auth.userId,
        details: { token_id: req.params.id },
      });
      return reply.status(204).send();
    },
  );
};

function toApiToken(t: typeof apiTokens.$inferSelect): z.infer<typeof apiToken> {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as z.infer<typeof apiToken>['scopes'],
    created_at: t.createdAt.toISOString(),
    last_used_at: iso(t.lastUsedAt),
    expires_at: iso(t.expiresAt),
    revoked_at: iso(t.revokedAt),
  };
}
