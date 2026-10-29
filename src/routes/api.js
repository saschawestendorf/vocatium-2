// Öffentliche API für das Frontend.
import { AppError } from '../leads.js';

const bearer = (req) => {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

export default async function apiRoutes(app, { leads, sessions, publicEventData }) {
  app.get('/event', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return publicEventData;
  });

  // Neuer Lead
  app.post('/leads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const result = await leads.submit(req.body, { userAgent: req.headers['user-agent'] });
    reply.code(201);
    return result;
  });

  // Korrektur eines noch offenen Leads
  app.put('/leads/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const token = bearer(req);
    if (!token) throw new AppError(401, 'unauthorized', 'Nicht autorisiert.');
    return leads.submit(req.body, { leadId: req.params.id, token, userAgent: req.headers['user-agent'] });
  });

  app.get('/leads/:id', async (req) => leads.status(req.params.id, bearer(req)));

  app.post('/leads/:id/verifications/:channel/send', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
    leads.sendCode(req.params.id, bearer(req), req.params.channel),
  );

  // Sitzungen: Zwischenstände auch ohne Abschluss speichern (anonym). Großzügige Limits: Messe-WLAN = eine IP.
  app.post('/sessions', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const result = await sessions.create(req.body, { userAgent: req.headers['user-agent'] });
    reply.code(201);
    return result;
  });

  app.put('/sessions/:id', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) =>
    sessions.update(req.params.id, bearer(req), req.body),
  );

  app.post('/sessions/:id/abort', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) =>
    sessions.abort(req.params.id, bearer(req), req.body),
  );

  app.post('/leads/:id/verifications/:channel/check', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) =>
    leads.verifyCode(req.params.id, bearer(req), req.params.channel, req.body?.code),
  );
}
