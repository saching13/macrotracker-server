import { z } from 'zod';

/** Bumped only for breaking changes; the app refuses servers it doesn't know. */
export const API_VERSION = 1;

export const errorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      request_id: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'Error' });
export type ErrorBody = z.infer<typeof errorBody>;

export const metaResponse = z
  .object({
    name: z.literal('macrotracker-server'),
    version: z.string(),
    api_version: z.number().int(),
    signup: z.enum(['invite', 'closed']),
  })
  .meta({ id: 'Meta' });
export type MetaResponse = z.infer<typeof metaResponse>;

export const idParams = z.object({ id: z.uuid() });
