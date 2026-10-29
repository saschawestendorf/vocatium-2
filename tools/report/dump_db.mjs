// Read-only JSON-Dump aller Tabellen für den Lead-Report (tools/report/build_report.py).
// Bewusst ohne Token-/Code-Hashes. Nutzt die DB-Verbindung der App (DATABASE_URL, optional DATABASE_SSL=true).
//
//   node tools/report/dump_db.mjs <ziel-ordner>   → eine JSON-Datei je Tabelle
//   node tools/report/dump_db.mjs -               → alles als ein JSON-Objekt auf stdout
//                                                   (z. B. `railway ssh --service vocatium-2 -- node tools/report/dump_db.mjs - > dump.json`)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TABLES = {
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

const target = process.argv[2];
if (!target) {
  console.error('Verwendung: node tools/report/dump_db.mjs <ziel-ordner | ->');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ist nicht gesetzt.');
  process.exit(2);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  statement_timeout: 60_000,
});
await client.connect();
try {
  // Konsistenter Stand über alle Tabellen.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const dump = {};
  for (const [name, sql] of Object.entries(TABLES)) {
    try {
      dump[name] = (await client.query(sql)).rows;
    } catch (err) {
      // Tabelle fehlt (ältere Migration) → leer statt Abbruch.
      if (err.code === '42P01') dump[name] = [];
      else throw err;
    }
  }
  await client.query('COMMIT');
  const host = (() => {
    try { return new URL(process.env.DATABASE_URL).host; } catch { return null; }
  })();
  dump.meta = {
    dumpedAt: new Date().toISOString(),
    databaseHost: host,
    counts: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])),
  };

  if (target === '-') {
    process.stdout.write(JSON.stringify(dump));
  } else {
    await mkdir(target, { recursive: true });
    for (const [name, rows] of Object.entries(dump)) {
      await writeFile(path.join(target, `${name}.json`), JSON.stringify(rows, null, 1));
    }
    for (const [name, n] of Object.entries(dump.meta.counts)) console.error(`${name}: ${n} Zeilen`);
    console.error(`Dump geschrieben nach ${path.resolve(target)}`);
  }
} finally {
  await client.end();
}
