import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { engine, type Scope } from '@macrotracker/shared';
import { displayToKg } from '@macrotracker/shared/units';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { type AuthContext, authOf } from '../plugins/auth.js';
import { DataService } from '../services/data.js';
import type { SyncActor } from '../services/sync.js';
import { version } from '../version.js';

/** Body measurements the app stores, with their units. */
export const BODY_METRICS: Record<string, string> = {
  neck: 'cm',
  shoulders: 'cm',
  chest: 'cm',
  waist: 'cm',
  abdomen: 'cm',
  hips: 'cm',
  bicep_left: 'cm',
  bicep_right: 'cm',
  forearm_left: 'cm',
  forearm_right: 'cm',
  thigh_left: 'cm',
  thigh_right: 'cm',
  calf_left: 'cm',
  calf_right: 'cm',
  body_fat: '%',
  lean_mass: 'kg',
};

const date = z.iso.date().describe('Local date, YYYY-MM-DD. Defaults to today.');
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('Local time eaten, HH:mm (24 h); sets the meal. Defaults to now.');
const confirm = z.literal(true).describe('Must be true: confirms the change with the user first.');

const INSTRUCTIONS = `MacroTracker: the user's food diary, weight and adaptive calorie targets.
- Dates are the user's local calendar days (YYYY-MM-DD). Pass the date when you know it; otherwise "today" is taken in the server's timezone.
- Energy is kcal and mass is kg in every result; the user's preferred display units are in get_status.profile.
- To log a food: search_foods (or recent_foods), then log_food with its id and an amount (grams/ml, or a named serving). Macros are snapshotted when logged.
- Prefer foods from search over quick_add; use quick_add only for bare calories/macros.
- Ask the user before changing or deleting entries; those tools need confirm: true.`;

/** What the caller may do, from token scopes and server flags. */
function allowed(auth: AuthContext, config: Config) {
  const has = (s: Scope) => auth.scopes === null || auth.scopes.has(s);
  return {
    read: has('mcp:read'),
    write: config.MCP_WRITE_ENABLED && has('mcp:write'),
    destroy: config.MCP_DESTROY_ENABLED && has('mcp:destroy'),
  };
}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }],
});

/**
 * Runs a tool body; errors become tool errors the agent can read (not
 * protocol failures).
 */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof AppError) {
      return { isError: true, content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }] };
    }
    throw err;
  }
}

function buildServer(data: DataService, actor: SyncActor, can: ReturnType<typeof allowed>, timeZone: string) {
  const today = () => engine.localToday(new Date(), timeZone);
  /** The local time now, HH:mm. */
  const nowHm = () =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
  const server = new McpServer({ name: 'macrotracker', version }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const add = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const change = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const span = (from: string, to: string, max: number) => {
    const days = engine.toDay(to) - engine.toDay(from);
    if (days < 0) throw new AppError(400, 'bad_range', '`from` is after `to`');
    if (days >= max) throw new AppError(400, 'bad_range', `at most ${max} days at a time`);
  };

  if (can.read) {
    server.registerTool(
      'get_status',
      {
        title: 'Status',
        description:
          "Today's totals and targets, trend weight, estimated expenditure (TDEE), this week's targets and the check-in schedule.",
        inputSchema: { date: date.optional() },
        annotations: read,
      },
      ({ date: d }) => run(() => data.status(actor, d ?? today())),
    );
    server.registerTool(
      'get_day',
      {
        title: 'Diary day',
        description: "One day's diary entries with totals and that day's targets.",
        inputSchema: { date: date.optional() },
        annotations: read,
      },
      ({ date: d }) => run(() => data.day(actor, d ?? today())),
    );
    server.registerTool(
      'daily_totals',
      {
        title: 'Daily totals',
        description:
          'Calories and macros per logged day over a range (at most 92 days), with each day’s kcal target.',
        inputSchema: { from: z.iso.date(), to: z.iso.date() },
        annotations: read,
      },
      ({ from, to }) =>
        run(async () => {
          span(from, to, 92);
          return { days: await data.dailyTotals(actor, from, to) };
        }),
    );
    server.registerTool(
      'list_diary',
      {
        title: 'Diary entries',
        description: 'Every entry over a range of days (at most 31).',
        inputSchema: { from: z.iso.date(), to: z.iso.date() },
        annotations: read,
      },
      ({ from, to }) =>
        run(async () => {
          span(from, to, 31);
          return { entries: await data.entriesBetween(actor, from, to) };
        }),
    );
    server.registerTool(
      'search_foods',
      {
        title: 'Search foods',
        description:
          "The user's own foods first, then USDA reference foods. Macros are per serving_qty of serving_unit; servings are named portions in base units.",
        inputSchema: { query: z.string().min(1).max(100), limit: z.number().int().min(1).max(50).optional() },
        annotations: read,
      },
      ({ query, limit }) => run(async () => ({ foods: await data.searchFoods(actor, query, limit ?? 15) })),
    );
    server.registerTool(
      'recent_foods',
      {
        title: 'Recent foods',
        description:
          'Foods from the latest diary entries, newest first: usually what the user means by "the usual".',
        inputSchema: { limit: z.number().int().min(1).max(50).optional() },
        annotations: read,
      },
      ({ limit }) => run(async () => ({ foods: await data.recentFoods(actor, limit ?? 15) })),
    );
    server.registerTool(
      'list_recipes',
      {
        title: 'Recipes',
        description: "The user's recipes, with totals for the whole recipe and its number of servings.",
        annotations: read,
      },
      () => run(async () => ({ recipes: await data.recipes(actor) })),
    );
    server.registerTool(
      'list_weights',
      {
        title: 'Weigh-ins',
        description: 'Weigh-ins (kg) over a range of days (at most 366).',
        inputSchema: { from: z.iso.date(), to: z.iso.date() },
        annotations: read,
      },
      ({ from, to }) =>
        run(async () => {
          span(from, to, 366);
          return { weights: await data.weights(actor, from, to) };
        }),
    );
  }

  if (can.write) {
    server.registerTool(
      'log_food',
      {
        title: 'Log a food',
        description:
          'Logs a food by id (from search_foods or recent_foods). Give `quantity` in its base unit (g or ml), or `serving` (a name from its servings) and `servings` (how many).',
        inputSchema: {
          food_id: z.string(),
          quantity: z.number().positive().optional(),
          serving: z.string().optional(),
          servings: z.number().positive().optional(),
          date: date.optional(),
          time: time.optional(),
        },
        annotations: add,
      },
      (a) =>
        run(async () => {
          let quantity = a.quantity;
          let label: string | undefined;
          let amount: number | undefined;
          if (a.serving !== undefined) {
            const food = await data.food(actor, a.food_id);
            const sv = food.servings.find((s) => s.label.toLowerCase() === a.serving!.toLowerCase());
            if (!sv) {
              throw new AppError(
                400,
                'unknown_serving',
                `No serving "${a.serving}"; this food has ${food.servings.map((s) => s.label).join(', ') || 'none'}`,
              );
            }
            amount = a.servings ?? 1;
            label = sv.label;
            quantity = sv.base_amount * amount;
          } else if (quantity !== undefined) {
            const food = await data.food(actor, a.food_id);
            label = food.serving_unit;
            amount = quantity;
          }
          if (quantity === undefined)
            throw new AppError(400, 'no_amount', 'Give quantity, or serving and servings');
          return data.createEntry(actor, {
            date: a.date ?? today(),
            time: a.time ?? nowHm(),
            food_id: a.food_id,
            quantity,
            serving_label: label,
            serving_amount: amount,
          });
        }),
    );
    server.registerTool(
      'log_recipe',
      {
        title: 'Log a recipe',
        description: 'Logs servings of one of the user’s recipes (list_recipes).',
        inputSchema: {
          recipe_id: z.string(),
          servings: z.number().positive().optional(),
          date: date.optional(),
          time: time.optional(),
        },
        annotations: add,
      },
      (a) =>
        run(() =>
          data.createEntry(actor, {
            date: a.date ?? today(),
            time: a.time ?? nowHm(),
            recipe_id: a.recipe_id,
            quantity: a.servings ?? 1,
          }),
        ),
    );
    server.registerTool(
      'quick_add',
      {
        title: 'Quick add',
        description: 'Logs bare calories and macros with no food. Prefer log_food when the food is known.',
        inputSchema: {
          kcal: z.number().min(0).max(20_000),
          protein_g: z.number().min(0).optional(),
          carb_g: z.number().min(0).optional(),
          fat_g: z.number().min(0).optional(),
          date: date.optional(),
          time: time.optional(),
        },
        annotations: add,
      },
      (a) =>
        run(() =>
          data.createEntry(actor, {
            date: a.date ?? today(),
            time: a.time ?? nowHm(),
            kcal: a.kcal,
            protein_g: a.protein_g ?? 0,
            carb_g: a.carb_g ?? 0,
            fat_g: a.fat_g ?? 0,
          }),
        ),
    );
    server.registerTool(
      'update_entry',
      {
        title: 'Change an entry',
        description:
          'Changes a diary entry: its amount (base units, or `servings` of the serving it was logged in), time or day; quick-add entries change their macros instead. Confirm with the user first.',
        inputSchema: {
          entry_id: z.string(),
          quantity: z.number().positive().optional(),
          servings: z.number().positive().optional(),
          date: z.iso.date().optional(),
          time: time.optional(),
          kcal: z.number().min(0).optional(),
          protein_g: z.number().min(0).optional(),
          carb_g: z.number().min(0).optional(),
          fat_g: z.number().min(0).optional(),
          confirm,
        },
        annotations: change,
      },
      ({ entry_id, servings, confirm: _confirm, ...rest }) =>
        run(() => data.updateEntry(actor, entry_id, { ...rest, serving_amount: servings })),
    );
    server.registerTool(
      'create_food',
      {
        title: 'Create a food',
        description:
          'Adds a food to the user’s foods (macros per serving_qty g or ml), e.g. from a nutrition label.',
        inputSchema: {
          name: z.string().min(1).max(200),
          brand: z.string().max(200).optional(),
          serving_qty: z.number().positive(),
          serving_unit: z.enum(['g', 'ml']),
          kcal_per_serving: z.number().min(0),
          protein_g: z.number().min(0),
          carb_g: z.number().min(0),
          fat_g: z.number().min(0),
          fiber_g: z.number().min(0).optional(),
          servings: z
            .array(z.object({ label: z.string().min(1).max(80), base_amount: z.number().positive() }))
            .max(20)
            .optional(),
        },
        annotations: add,
      },
      (a) => run(() => data.createFood(actor, a)),
    );
    server.registerTool(
      'log_weight',
      {
        title: 'Log a weigh-in',
        description: 'Logs a scale weight.',
        inputSchema: {
          weight: z.number().positive(),
          unit: z.enum(['kg', 'lb']),
          date: date.optional(),
        },
        annotations: add,
      },
      (a) =>
        run(async () => {
          const kg = displayToKg(a.weight, a.unit);
          if (kg < 20 || kg > 400) throw new AppError(400, 'out_of_range', 'That weight looks wrong');
          return data.addWeight(actor, a.date ?? today(), kg);
        }),
    );
    server.registerTool(
      'log_body_metric',
      {
        title: 'Log a body measurement',
        description: `Logs a measurement. Metrics and units: ${Object.entries(BODY_METRICS)
          .map(([k, u]) => `${k} (${u})`)
          .join(', ')}.`,
        inputSchema: {
          metric: z.enum(Object.keys(BODY_METRICS) as [string, ...string[]]),
          value: z.number().positive().max(1000),
          date: date.optional(),
        },
        annotations: add,
      },
      (a) => run(() => data.addBodyMetric(actor, a.date ?? today(), a.metric, a.value)),
    );
    server.registerTool(
      'check_in',
      {
        title: 'Weekly check-in',
        description:
          "Without confirm: previews this week's new targets from the latest expenditure. With confirm: true, saves them (they apply from today). Confirm with the user first.",
        inputSchema: { date: date.optional(), confirm: z.boolean().optional() },
        annotations: change,
      },
      (a) =>
        run(() =>
          a.confirm === true
            ? data.completeCheckIn(actor, a.date ?? today())
            : data.checkInPreview(actor, a.date ?? today()),
        ),
    );
  }

  if (can.destroy) {
    server.registerTool(
      'delete_entry',
      {
        title: 'Delete an entry',
        description: 'Deletes a diary entry. Confirm with the user first.',
        inputSchema: { entry_id: z.string(), confirm },
        annotations: change,
      },
      ({ entry_id }) =>
        run(async () => {
          await data.deleteEntry(actor, entry_id);
          return { deleted: entry_id };
        }),
    );
    server.registerTool(
      'delete_weight',
      {
        title: 'Delete a weigh-in',
        description: 'Deletes a weigh-in. Confirm with the user first.',
        inputSchema: { weight_id: z.string(), confirm },
        annotations: change,
      },
      ({ weight_id }) =>
        run(async () => {
          await data.deleteWeight(actor, weight_id);
          return { deleted: weight_id };
        }),
    );
  }

  return server;
}

/**
 * MCP over Streamable HTTP at /mcp, stateless: each request gets a fresh
 * server bound to its caller. Personal access tokens (`mt_pat_…`) decide what
 * an agent may do (mcp:read / mcp:write / mcp:destroy), within the server's
 * MCP_*_ENABLED flags; tools the caller can't use aren't listed at all.
 */
export const mcpRoutes: FastifyPluginAsync<{ config: Config }> = async (app, { config }) => {
  if (!config.MCP_ENABLED) return;
  const data = new DataService(app.deps.db);

  app.post('/mcp', { preHandler: app.requireAuth(), schema: { hide: true } }, async (req, reply) => {
    const auth = authOf(req);
    const can = allowed(auth, config);
    if (!can.read && !can.write) {
      throw new AppError(403, 'insufficient_scope', 'This token has no mcp scopes');
    }
    const actor = { userId: auth.userId, deviceId: auth.deviceId ?? null };
    const server = buildServer(data, actor, can, config.DEFAULT_TIMEZONE);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless: no server-initiated streams and no sessions to end.
  const notAllowed = { error: { code: 'method_not_allowed', message: 'Use POST', request_id: '' } };
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      schema: { hide: true },
      handler: async (req, reply) =>
        reply
          .status(405)
          .header('allow', 'POST')
          .send({ error: { ...notAllowed.error, request_id: req.id } }),
    });
  }
};
