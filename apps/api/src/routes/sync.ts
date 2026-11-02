import {
  errorBody,
  syncBootstrapBody,
  syncBootstrapResponse,
  syncPullQuery,
  syncPullResponse,
  syncPushBody,
  syncPushResponse,
  syncStatus,
} from '@macrotracker/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authOf } from '../plugins/auth.js';
import { SyncService, type SyncActor } from '../services/sync.js';

const actorOf = (req: FastifyRequest): SyncActor => {
  const auth = authOf(req);
  return { userId: auth.userId, deviceId: auth.deviceId ?? null };
};

/**
 * Offline-first sync for the app (see packages/shared/src/api/sync.ts for the
 * protocol). Signed-in devices only: the web app and agents write through the
 * regular endpoints.
 */
export const syncRoutes: FastifyPluginAsyncZod = async (app) => {
  const sync = new SyncService(app.deps.db);
  const security = [{ bearer: [] }];
  const preHandler = app.requireAuth({ sessionOnly: true });

  app.get(
    '/status',
    {
      preHandler,
      schema: {
        tags: ['sync'],
        summary: 'Account and server identity, current rev',
        description:
          'Called when the app connects, to decide between uploading its data, merging, or replacing it.',
        security,
        response: { 200: syncStatus, 401: errorBody },
      },
    },
    async (req) => sync.status(actorOf(req)),
  );

  app.post(
    '/push',
    {
      preHandler,
      schema: {
        tags: ['sync'],
        summary: 'Send local changes',
        description:
          'Each change gets its own result. Retrying a change id is harmless. Stale and duplicate results carry the ' +
          "row's current server state.",
        security,
        body: syncPushBody,
        response: { 200: syncPushResponse, 400: errorBody, 401: errorBody, 409: errorBody },
      },
    },
    async (req) => sync.push(actorOf(req), req.body),
  );

  app.get(
    '/pull',
    {
      preHandler,
      schema: {
        tags: ['sync'],
        summary: 'Fetch changes after a rev',
        description:
          'Returns the current state of each row changed after `since`, in rev order. 409 `cursor_ahead` means the ' +
          'server is behind the app (restored from a backup); pull again from 0.',
        security,
        querystring: syncPullQuery,
        response: { 200: syncPullResponse, 401: errorBody, 409: errorBody },
      },
    },
    async (req) => sync.pull(actorOf(req), req.query.since, req.query.limit),
  );

  app.post(
    '/bootstrap',
    {
      preHandler,
      schema: {
        tags: ['sync'],
        summary: "Upload an app's existing data on first connect",
        description:
          "Adds rows the server doesn't have; rows it already has (or has deleted) keep the server's version. Send " +
          'in batches, then pull from 0.',
        security,
        body: syncBootstrapBody,
        response: { 200: syncBootstrapResponse, 400: errorBody, 401: errorBody, 409: errorBody },
      },
    },
    async (req) => {
      const result = await sync.bootstrap(actorOf(req), req.body);
      req.log.info(
        { inserted: result.inserted, skipped: result.skipped, rejected: result.rejected.length },
        'sync bootstrap',
      );
      return result;
    },
  );
};
