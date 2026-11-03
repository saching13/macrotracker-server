import { copyResponse, errorBody, libraryQuery, publishBody, sharedRecipe } from '@macrotracker/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import { LibraryService } from '../services/library.js';

/**
 * The shared recipe library: everyone on the server can browse it and copy
 * recipes into their own; owners publish, update and remove theirs (admins
 * can remove any). Tokens need mcp:read / mcp:write / mcp:destroy.
 */
export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  const library = new LibraryService(app.deps.db);
  const security = [{ bearer: [] }];
  const actor = (req: Parameters<typeof authOf>[0]) => {
    const a = authOf(req);
    return { userId: a.userId, deviceId: a.deviceId ?? null };
  };
  const params = z.object({ id: z.uuid() });
  const errors = { 401: errorBody, 403: errorBody };

  app.get(
    '/',
    {
      preHandler: app.requireAuth({ scope: 'mcp:read' }),
      schema: {
        tags: ['library'],
        summary: 'Browse the shared recipes',
        security,
        querystring: libraryQuery,
        response: { 200: z.object({ recipes: z.array(sharedRecipe) }), ...errors },
      },
    },
    async (req) => ({ recipes: await library.list(actor(req), req.query.q, req.query.limit) }),
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireAuth({ scope: 'mcp:read' }),
      schema: {
        tags: ['library'],
        summary: 'A shared recipe with its ingredients',
        security,
        params,
        response: { 200: sharedRecipe, 404: errorBody, ...errors },
      },
    },
    async (req) => library.get(actor(req), req.params.id),
  );

  app.post(
    '/',
    {
      preHandler: app.requireAuth({ scope: 'mcp:write' }),
      schema: {
        tags: ['library'],
        summary: 'Share one of your recipes (or update the shared copy)',
        description:
          'Every ingredient must be on the server: your synced foods or USDA foods. Recipes with INDB foods can’t be shared.',
        security,
        body: publishBody,
        response: { 200: sharedRecipe, 404: errorBody, 422: errorBody, ...errors },
      },
    },
    async (req) => {
      const shared = await library.publish(actor(req), req.body.recipe_id, authOf(req).email);
      await audit(app.deps.db, req, {
        event: 'library.publish',
        userId: authOf(req).userId,
        details: { shared_recipe_id: shared.id, version: shared.version },
      });
      return shared;
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireAuth({ scope: 'mcp:destroy' }),
      schema: {
        tags: ['library'],
        summary: 'Remove a recipe from the library (yours, or any as an admin)',
        description: 'Copies people already added stay theirs.',
        security,
        params,
        response: { 204: z.undefined(), 404: errorBody, ...errors },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await library.unpublish(actor(req), req.params.id, auth.role === 'admin' && auth.kind === 'session');
      await audit(app.deps.db, req, {
        event: 'library.unpublish',
        userId: auth.userId,
        details: { shared_recipe_id: req.params.id },
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/:id/copy',
    {
      preHandler: app.requireAuth({ scope: 'mcp:write' }),
      schema: {
        tags: ['library'],
        summary: 'Add a shared recipe to your recipes',
        description:
          'Creates your own copy (and foods for its ingredients; USDA ones are reused). It syncs to your phones. Later changes by its owner don’t change your copy.',
        security,
        params,
        response: { 200: copyResponse, 404: errorBody, 409: errorBody, ...errors },
      },
    },
    async (req) => library.copy(actor(req), req.params.id),
  );
};
