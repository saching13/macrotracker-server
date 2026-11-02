import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { JWTVerifyGetKey } from 'jose';
import { trustProxySetting, type Config } from './config.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/errors.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { pageRoutes } from './routes/pages.js';
import { systemRoutes } from './routes/system.js';
import { GoTrue } from './services/gotrue.js';
import { version } from './version.js';

export interface Deps {
  config: Config;
  db: Db;
  gotrue: GoTrue;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}

export interface BuildOptions {
  config: Config;
  /** Injected in tests; otherwise created from config and closed with the app. */
  database?: Database;
  gotrue?: GoTrue;
  jwks?: JWTVerifyGetKey;
  logger?: boolean;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          },
    // Clients may send their own id so app and server logs line up; anything
    // odd-looking is replaced rather than echoed.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
    logController: new LogController({
      requestIdLogLabel: 'request_id',
      // Container health probes would otherwise flood the log.
      disableRequestLogging: (req) => req.url === '/healthz' || req.url === '/readyz',
    }),
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  const database = opts.database ?? createDatabase(config.DATABASE_URL, config.DB_POOL_MAX);
  if (!opts.database) app.addHook('onClose', () => database.close());
  app.decorate('deps', {
    config,
    db: database.db,
    gotrue: opts.gotrue ?? new GoTrue(config.GOTRUE_URL, config.JWT_SECRET, config.JWT_ISSUER),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app, config.BODY_LIMIT_BYTES);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    // HSTS only makes sense once the server is behind HTTPS.
    hsts: config.PUBLIC_URL.startsWith('https://'),
  });
  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, !origin || config.WEB_ORIGINS.includes(origin)),
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    maxAge: 600,
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'MacroTracker server API',
        version,
        description:
          'REST API for the MacroTracker app, web app and agents. MCP is served separately at /mcp.',
        license: { name: 'MIT', identifier: 'MIT' },
      },
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'A session access token from /v1/auth/login, or a personal access token (mt_pat_…).',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(authPlugin, { jwks: opts.jwks });
  await app.register(systemRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(accountRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.register(pageRoutes);

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
