import { readFile } from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

export const publicDir = new URL('../../public/', import.meta.url);

/**
 * The two pages an invite or reset link opens. They post to
 * /v1/auth/complete-link; the React web app will take these over later.
 */
export const pageRoutes: FastifyPluginAsync = async (app) => {
  await app.register(fastifyStatic, { root: publicDir, prefix: '/assets/', index: false, wildcard: false });
  const html = await readFile(new URL('link.html', publicDir), 'utf8');

  for (const path of ['/accept-invite', '/reset-password']) {
    app.get(path, { schema: { hide: true } }, async (_req, reply) =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html),
    );
  }
};
