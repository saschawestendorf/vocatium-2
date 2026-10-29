// Vollständiger, schreibgeschützter Datenexport aller Tabellen – bewusst ohne Token-/Code-Hashes.
// Genutzt vom Export-Endpunkt (GET /export/data.json) und von tools/report/dump_db.mjs.
import { createHash, timingSafeEqual } from 'node:crypto';

export const EXPORT_MIN_KEY_LENGTH = 32;

export const EXPORT_QUERIES = {
  events: 'SELECT * FROM events ORDER BY id',
  projects: 'SELECT * FROM projects ORDER BY event_id, sort_order, id',
  companies: 'SELECT * FROM companies ORDER BY event_id, sort_order, id',
  leads: `SELECT id, event_id, status, first_name, last_name, email, phone_e164, company_id, email_verified_at,
            phone_verified_at, consent_text, consent_at, confirmation_sent_at, completed_at, user_agent, created_at, updated_at
          FROM leads ORDER BY created_at, id`,
  lead_allocations: 'SELECT lead_id, project_id, amount_euro FROM lead_allocations ORDER BY lead_id, project_id',
  sessions: `SELECT id, event_id, status, last_step, allocations, company_id, lead_id, abort_reason, user_agent,
               created_at, updated_at, ended_at
             FROM sessions ORDER BY created_at, id`,
  verifications: `SELECT id, lead_id, channel, target, attempts, expires_at, consumed_at, created_at
                  FROM verifications ORDER BY created_at, id`,
  schema_migrations: 'SELECT * FROM schema_migrations ORDER BY applied_at',
};

// Konsistenter Stand über alle Tabellen (eine Read-only-Transaktion). Fehlende Tabellen → leere Liste.
export async function exportAll(client, { now = () => new Date() } = {}) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const dump = {};
    for (const [name, sql] of Object.entries(EXPORT_QUERIES)) {
      // Existenz vorab prüfen: Ein Fehler würde die Transaktion abbrechen.
      const { rows: [t] } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`]);
      dump[name] = t?.present ? (await client.query(sql)).rows : [];
    }
    await client.query('COMMIT');
    dump.meta = {
      exportedAt: now().toISOString(),
      counts: Object.fromEntries(Object.keys(EXPORT_QUERIES).map((k) => [k, dump[k].length])),
    };
    return dump;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Schlüssel aus `Authorization: Bearer …` oder `X-Export-Key` – bewusst nicht aus der URL (landet sonst in Logs).
export function extractExportKey(headers = {}) {
  const auth = typeof headers.authorization === 'string' ? headers.authorization : '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
  const x = headers['x-export-key'];
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

// Zeitkonstanter Vergleich ohne Längen-Leck (Vergleich der SHA-256-Digests).
export function exportKeyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
