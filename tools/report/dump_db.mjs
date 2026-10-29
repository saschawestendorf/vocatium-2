// Read-only JSON-Dump aller Tabellen für den Lead-Report (tools/report/build_report.py).
// Gleiche Abfragen wie der Export-Endpunkt (src/export.js), bewusst ohne Token-/Code-Hashes.
// Nutzt die DB-Verbindung der App (DATABASE_URL, optional DATABASE_SSL=true).
//
//   node tools/report/dump_db.mjs <ziel-ordner>   → eine JSON-Datei je Tabelle
//   node tools/report/dump_db.mjs -               → alles als ein JSON-Objekt auf stdout
//                                                   (z. B. `railway ssh --service vocatium-2 -- node tools/report/dump_db.mjs - > dump.json`)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { exportAll } from '../../src/export.js';

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
  const dump = await exportAll(client);
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
