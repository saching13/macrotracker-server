import {
  checkInPreview,
  createEntryBody,
  createFoodBody,
  createWeightBody,
  dateQuery,
  day,
  entry,
  errorBody,
  food,
  foodSearchQuery,
  idParam,
  profile,
  rangeQuery,
  recipe,
  status,
  todayQuery,
  updateEntryBody,
  updateProfileBody,
  weight,
} from '@macrotracker/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../plugins/auth.js';
import { DataService } from '../services/data.js';
import type { SyncActor } from '../services/sync.js';

const actorOf = (req: FastifyRequest): SyncActor => {
  const auth = authOf(req);
  return { userId: auth.userId, deviceId: auth.deviceId ?? null };
};

/**
 * The account's data for the web app and agents (plan-11 S5). Password
 * sessions can do everything; personal access tokens need `mcp:read` to
 * read, `mcp:write` to add or change and `mcp:destroy` to delete.
 */
export const dataRoutes: FastifyPluginAsyncZod = async (app) => {
  const data = new DataService(app.deps.db);
  const security = [{ bearer: [] }];
  const read = app.requireAuth({ scope: 'mcp:read' });
  const write = app.requireAuth({ scope: 'mcp:write' });
  const destroy = app.requireAuth({ scope: 'mcp:destroy' });
  const errors = { 401: errorBody, 403: errorBody };

  app.get(
    '/status',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Dashboard: estimate, today, targets, check-in',
        security,
        querystring: todayQuery,
        response: { 200: status, ...errors },
      },
    },
    async (req) => data.status(actorOf(req), req.query.today),
  );

  app.get(
    '/day',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: "A day's diary, totals and targets",
        security,
        querystring: dateQuery,
        response: { 200: day, ...errors },
      },
    },
    async (req) => data.day(actorOf(req), req.query.date),
  );

  app.post(
    '/entries',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: 'Log a food, a recipe or quick-add macros',
        description:
          'Macros are snapshotted from the food or recipe now; later edits to the food never change this entry.',
        security,
        body: createEntryBody,
        response: { 201: entry, 400: errorBody, 404: errorBody, ...errors },
      },
    },
    async (req, reply) => reply.status(201).send(await data.createEntry(actorOf(req), req.body)),
  );

  app.patch(
    '/entries/:id',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: 'Change an entry (amount, time, day, or quick-add macros)',
        security,
        params: idParam,
        body: updateEntryBody,
        response: { 200: entry, 400: errorBody, 404: errorBody, 422: errorBody, ...errors },
      },
    },
    async (req) => data.updateEntry(actorOf(req), req.params.id, req.body),
  );

  app.delete(
    '/entries/:id',
    {
      preHandler: destroy,
      schema: {
        tags: ['data'],
        summary: 'Delete an entry',
        security,
        params: idParam,
        response: { 204: z.undefined(), 404: errorBody, ...errors },
      },
    },
    async (req, reply) => {
      await data.deleteEntry(actorOf(req), req.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/foods/search',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Search your foods and the USDA reference foods',
        security,
        querystring: foodSearchQuery,
        response: { 200: z.object({ foods: z.array(food) }), ...errors },
      },
    },
    async (req) => ({ foods: await data.searchFoods(actorOf(req), req.query.q, req.query.limit) }),
  );

  app.get(
    '/foods/recent',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Foods from your latest entries',
        security,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
        response: { 200: z.object({ foods: z.array(food) }), ...errors },
      },
    },
    async (req) => ({ foods: await data.recentFoods(actorOf(req), req.query.limit) }),
  );

  app.get(
    '/foods/:id',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'A food with its servings',
        security,
        params: idParam,
        response: { 200: food, 404: errorBody, ...errors },
      },
    },
    async (req) => data.food(actorOf(req), req.params.id),
  );

  app.post(
    '/foods',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: 'Create a food',
        security,
        body: createFoodBody,
        response: { 201: food, 400: errorBody, ...errors },
      },
    },
    async (req, reply) => reply.status(201).send(await data.createFood(actorOf(req), req.body)),
  );

  app.get(
    '/recipes',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Your recipes',
        security,
        response: { 200: z.object({ recipes: z.array(recipe) }), ...errors },
      },
    },
    async (req) => ({ recipes: await data.recipes(actorOf(req)) }),
  );

  app.get(
    '/weights',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Weigh-ins between two days',
        security,
        querystring: rangeQuery,
        response: { 200: z.object({ weights: z.array(weight) }), ...errors },
      },
    },
    async (req) => ({ weights: await data.weights(actorOf(req), req.query.from, req.query.to) }),
  );

  app.post(
    '/weights',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: 'Log a weigh-in (kg)',
        security,
        body: createWeightBody,
        response: { 201: weight, 400: errorBody, ...errors },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await data.addWeight(actorOf(req), req.body.date, req.body.weight_kg)),
  );

  app.delete(
    '/weights/:id',
    {
      preHandler: destroy,
      schema: {
        tags: ['data'],
        summary: 'Delete a weigh-in',
        security,
        params: idParam,
        response: { 204: z.undefined(), 404: errorBody, ...errors },
      },
    },
    async (req, reply) => {
      await data.deleteWeight(actorOf(req), req.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/profile',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: 'Your profile (null until set up in the app)',
        security,
        response: { 200: z.object({ profile: profile.nullable() }), ...errors },
      },
    },
    async (req) => ({ profile: await data.profile(actorOf(req)) }),
  );

  app.patch(
    '/profile',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: 'Change display units',
        security,
        body: updateProfileBody,
        response: { 200: profile, 404: errorBody, ...errors },
      },
    },
    async (req) => data.updateProfile(actorOf(req), req.body),
  );

  app.get(
    '/check-in',
    {
      preHandler: read,
      schema: {
        tags: ['data'],
        summary: "Preview this week's check-in",
        security,
        querystring: todayQuery,
        response: { 200: checkInPreview, 409: errorBody, ...errors },
      },
    },
    async (req) => data.checkInPreview(actorOf(req), req.query.today),
  );

  app.post(
    '/check-in',
    {
      preHandler: write,
      schema: {
        tags: ['data'],
        summary: "Accept this week's check-in: new targets from today",
        security,
        body: todayQuery,
        response: { 200: status, 409: errorBody, ...errors },
      },
    },
    async (req) => data.completeCheckIn(actorOf(req), req.body.today),
  );
};
