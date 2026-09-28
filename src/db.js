// PostgreSQL-Zugriff: Pool, Transaktionen, Migrationen.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const MIGRATION_LOCK_ID = 7_310_442; // beliebige, feste ID für pg_advisory_lock

export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Verhindert Prozessabsturz bei Verbindungsabbrüchen ruhender Clients.
  pool.on('error', (err) => console.error('[db] Pool-Fehler:', err.message));
  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Führt alle noch nicht angewendeten *.sql-Dateien in alphabetischer Reihenfolge aus.
// Advisory-Lock verhindert Parallelausführung bei mehreren Instanzen.
export async function migrate(pool, log = console) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info(`[db] Migration angewendet: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} fehlgeschlagen: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
