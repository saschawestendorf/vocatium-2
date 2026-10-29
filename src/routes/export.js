// Datenexport für Auswertungen per API-Schlüssel (EXPORT_API_KEY). Ohne gültigen Schlüssel ist der Endpunkt aus (404).
import { exportAll, exportKeyMatches, extractExportKey } from '../export.js';

export default async function exportRoutes(app, { pool, config }) {
  // Strenges Limit: Der Endpunkt liefert personenbezogene Daten.
  app.get('/data.json', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.export.apiKey) return reply.code(404).send({ error: 'not_found' });
    if (!exportKeyMatches(extractExportKey(req.headers), config.export.apiKey)) {
      req.log.warn({ ip: req.ip }, 'Export: Zugriff mit ungültigem Schlüssel abgelehnt');
      return reply.code(401).send({ error: 'unauthorized', message: 'Nicht autorisiert.' });
    }
    const client = await pool.connect();
    try {
      const dump = await exportAll(client);
      req.log.info({ ip: req.ip, counts: dump.meta.counts }, 'Export abgerufen');
      const stamp = dump.meta.exportedAt.slice(0, 10);
      reply.header('Content-Disposition', `attachment; filename="export-${stamp}.json"`);
      return dump;
    } finally {
      client.release();
    }
  });
}
