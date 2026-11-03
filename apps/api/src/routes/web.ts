import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

/** The web app's build (apps/web builds into apps/api/web). */
export const webDir = new URL('../../web/', import.meta.url);

/** The web app's pages; each serves the same document and the app routes itself. */
export const WEB_PAGES = ['/', '/diary', '/weight', '/settings'];

/**
 * Serves the React web app from the same origin as the API, so its session
 * cookie stays first-party and the CSP can stay at 'self'. Skipped when the
 * web app hasn't been built (API-only development and tests).
 */
export const webRoutes: FastifyPluginAsync = async (app) => {
  const index = new URL('index.html', webDir);
  if (!existsSync(fileURLToPath(index))) {
    app.log.info('web app not built; serving the API only');
    return;
  }
  // Hashed bundles and fonts; one route per file (no wildcard).
  await app.register(fastifyStatic, {
    root: fileURLToPath(webDir),
    prefix: '/',
    index: false,
    wildcard: false,
    decorateReply: false,
    allowedPath: (path) => path !== '/index.html',
    setHeaders: (res, path) => {
      if (path.includes('/static/')) res.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  const html = await readFile(index, 'utf8');
  for (const path of WEB_PAGES) {
    app.get(path, { schema: { hide: true } }, async (_req, reply) =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html),
    );
  }
};
