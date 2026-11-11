import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Container } from './container.js';
import { authPlugin } from './platform/auth/auth.js';
import { errors, registerErrorHandling } from './platform/http/errors.js';
import { registerHealthRoutes } from './platform/observability/health.js';
import { loggerOptions } from './platform/observability/logger.js';
import { registerLegalPages, registerLegalRoutes } from './modules/legal/index.js';
import { registerRealtimeGateway } from './platform/realtime/gateway.js';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export async function buildApp(c: Container, state = { shuttingDown: false }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(c.config),
    trustProxy: c.config.TRUST_PROXY,
    bodyLimit: 100 * 1024,
    // Keep a caller's X-Request-Id when it looks sane (correlation across the app and proxies), otherwise make one.
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID_RE.test(given) ? given : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerErrorHandling(app);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  const origins = c.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) {
    await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], exposedHeaders: ['x-request-id', 'retry-after'], maxAge: 600 });
  }
  await app.register(rateLimit, {
    global: false,
    redis: c.redis,
    nameSpace: `${c.config.REDIS_PREFIX}:rl-ip:`,
    skipOnError: false,
    errorResponseBuilder: (_req, ctx) => errors.tooMany(undefined, Math.ceil(ctx.ttl / 1000)),
  });

  if (c.config.DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'UGB Connect API', version: '1.0.0', description: 'Backend of the UGB Connect app. Swagger UI is the temporary back office (non-production only).' },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
        security: [{ bearer: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(authPlugin, { tokens: c.tokens, denylist: c.denylist });
  // Client frames are tiny (auth, sub, unsub): anything bigger is refused by the socket itself.
  await app.register(websocket, { options: { maxPayload: 4096 } });
  registerHealthRoutes(app, { db: c.mongo.db, redis: c.redis, isShuttingDown: () => state.shuttingDown });
  // The privacy policy and the terms as pages (the store listing links them).
  registerLegalPages(app, { phone: c.config.SUPPORT_PHONE, email: c.config.SUPPORT_EMAIL });

  const { accounts, organizations, identity, payments, messaging, taxi, ticketing, caravans, notifications, alerts, publicRestos, media, events, banners, lost, commerce, places, ratings } = c.modules;
  await app.register(
    async (api) => {
      identity.registerRoutes(api);
      accounts.registerRoutes(api);
      // "Aide & support": the contacts come from the configuration, not the app.
      registerLegalRoutes(api, { phone: c.config.SUPPORT_PHONE, email: c.config.SUPPORT_EMAIL });
      api.get('/reference/support', { schema: { tags: ['reference'] } }, async () => ({ phone: c.config.SUPPORT_PHONE, whatsapp: c.config.SUPPORT_PHONE, email: c.config.SUPPORT_EMAIL, hours: 'Lun.-sam. · 8h-20h' }));
      organizations.registerRoutes(api, accounts.requirePlatformRole('admin'), accounts.requireAnyPlatformRole(['caravan_editor']));
      payments.registerRoutes(api, accounts.requirePlatformRole('finance'), accounts.requirePlatformRole('admin'));
      messaging.registerRoutes(api, accounts.requirePlatformRole('admin'));
      taxi.registerRoutes(api);
      ticketing.registerRoutes(api);
      caravans.registerRoutes(api);
      notifications.registerRoutes(api, accounts.requirePlatformRole('admin'));
      alerts.registerRoutes(api, accounts.requireAnyPlatformRole(['content_editor', 'academic_editor']));
      publicRestos.registerRoutes(api, { requireStaff: accounts.requirePlatformRole('resto_u_staff'), requireAdmin: accounts.requirePlatformRole('admin'), restosOf: (u) => accounts.restosOf(u) });
      await media.registerRoutes(api);
      events.registerRoutes(api, accounts.requirePlatformRole('admin'));
      // After media: the card photo is a multipart upload.
      lost.registerRoutes(api, accounts.requirePlatformRole('lost_office'));
      // Restaurants and shops are added by the super admin's restaurant and shop editors (admins pass).
      commerce.registerRoutes(api, accounts.requireAnyPlatformRole(['restaurant_editor', 'shop_editor']));
      places.registerRoutes(api, accounts.requireAnyPlatformRole(['place_editor']));
      ratings.registerRoutes(api);
      banners.registerRoutes(api, { requireEditor: accounts.requirePlatformRole('content_editor'), requireAdmin: accounts.requirePlatformRole('admin') });
      registerRealtimeGateway(api, { hub: c.hub, tokens: c.tokens, denylist: c.denylist, clock: c.clock });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
