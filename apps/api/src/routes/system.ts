import { API_VERSION, metaResponse } from '@macrotracker/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { version } from '../version.js';

/** Liveness, readiness and server metadata. None of these need auth. */
export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, gotrue } = app.deps;

  app.get(
    '/healthz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Liveness',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Readiness: database and auth service reachable',
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: z.object({ status: z.literal('unavailable'), failing: z.array(z.string()) }),
        },
      },
    },
    async (req, reply) => {
      const checks = await Promise.allSettled([db.execute(sql`select 1`), gotrue.health()]);
      const failing = (['database', 'auth'] as const).filter((_, i) => checks[i]!.status === 'rejected');
      if (failing.length > 0) {
        req.log.warn({ failing }, 'not ready');
        return reply.status(503).send({ status: 'unavailable' as const, failing });
      }
      return { status: 'ready' as const };
    },
  );

  app.get(
    '/v1/meta',
    {
      schema: {
        tags: ['system'],
        summary: 'Server identity and API version',
        description:
          'The app calls this when a server URL is entered, to check it is a compatible MacroTracker server.',
        response: { 200: metaResponse },
      },
    },
    async () => ({
      name: 'macrotracker-server' as const,
      version,
      api_version: API_VERSION,
      signup: 'invite' as const,
    }),
  );
};
