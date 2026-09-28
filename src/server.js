// Einstiegspunkt: Konfiguration laden, DB migrieren, Event synchronisieren, HTTP-Server starten.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { loadEventConfig, publicEvent, syncEvent } from './event.js';
import { AppError, createLeadService } from './leads.js';
import { createEmailProvider } from './providers/email.js';
import { createSmsProvider } from './providers/sms.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};

export async function buildApp({ config, pool, event, ids }) {
  const app = Fastify({
    trustProxy: true, // Railway terminiert TLS am Proxy
    bodyLimit: 32 * 1024,
    logger: {
      level: config.isProd ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  const emailProvider = createEmailProvider(config, app.log);
  const smsProvider = createSmsProvider(config, app.log);
  const leads = createLeadService({ pool, config, event, ids, emailProvider, smsProvider, log: app.log });

  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000');
  });

  // Großzügiges globales Limit: Am Messestand teilen sich viele Geräte eine IP.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', err.retryAfter);
      return reply.code(err.status).send({ error: err.code, message: err.message, fieldErrors: err.fieldErrors });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Zu viele Anfragen. Bitte kurz warten.' });
    }
    if (err.validation || (err.statusCode >= 400 && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: 'bad_request', message: 'Ungültige Anfrage.' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Da ist etwas schiefgelaufen. Bitte versuche es erneut.' });
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(apiRoutes, { prefix: '/api', leads, publicEventData: publicEvent(event, config) });
  await app.register(adminRoutes, { prefix: '/admin', pool, config, ids });
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    // @fastify/static ≥ 10 übergibt hier das Fastify-Reply-Objekt.
    setHeaders: (reply, filePath) => {
      const longCache = /[\\/](fonts|assets)[\\/]/.test(filePath);
      reply.header('Cache-Control', longCache ? 'public, max-age=604800' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not_found' }) : reply.sendFile('index.html'),
  );

  return app;
}

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  await migrate(pool);
  const event = await loadEventConfig(config.eventConfigPath);
  const ids = await syncEvent(pool, event);
  const app = await buildApp({ config, pool, event, ids });

  app.log.info(
    { event: event.slug, email: config.email.provider, sms: config.sms.provider, verify: config.verify },
    'Konfiguration geladen',
  );
  if (config.isProd && (config.email.provider === 'console' || config.sms.provider === 'console')) {
    app.log.warn('Produktion mit Console-Provider: Codes werden nur geloggt, nicht versendet!');
  }

  const shutdown = async (signal) => {
    app.log.info(`${signal} empfangen, fahre herunter …`);
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
