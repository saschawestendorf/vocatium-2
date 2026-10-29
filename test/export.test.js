import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { EXPORT_QUERIES, exportAll, exportKeyMatches, extractExportKey } from '../src/export.js';

const KEY = 'k'.repeat(40);

test('Export-Schlüssel: zeitkonstanter Vergleich, auch bei unterschiedlicher Länge', () => {
  assert.equal(exportKeyMatches(KEY, KEY), true);
  assert.equal(exportKeyMatches(`${KEY}x`, KEY), false);
  assert.equal(exportKeyMatches('kurz', KEY), false);
  assert.equal(exportKeyMatches('', KEY), false);
  assert.equal(exportKeyMatches(null, KEY), false);
  assert.equal(exportKeyMatches(KEY, undefined), false);
});

test('Export-Schlüssel nur aus Headern (Bearer oder X-Export-Key)', () => {
  assert.equal(extractExportKey({ authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(extractExportKey({ authorization: `bearer   ${KEY}  ` }), KEY);
  assert.equal(extractExportKey({ 'x-export-key': ` ${KEY} ` }), KEY);
  assert.equal(extractExportKey({ authorization: 'Basic YWRtaW46eA==' }), null);
  assert.equal(extractExportKey({ authorization: 'Bearer ' }), null);
  assert.equal(extractExportKey({}), null);
  assert.equal(extractExportKey(undefined), null);
});

test('EXPORT_API_KEY: ohne Schlüssel aus, zu kurz → aus statt Startabbruch, gültig → an', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x' }).export.apiKey, undefined);
  const short = loadConfig({ DATABASE_URL: 'postgres://x', EXPORT_API_KEY: 'zu-kurz' });
  assert.equal(short.export.apiKey, undefined);
  assert.equal(short.export.keyRejected, true);
  const ok = loadConfig({ DATABASE_URL: 'postgres://x', EXPORT_API_KEY: `  ${KEY}\n` });
  assert.equal(ok.export.apiKey, KEY);
  assert.equal(ok.export.keyRejected, false);
});

test('Export-Abfragen enthalten keine Token- oder Code-Hashes', () => {
  for (const [name, sql] of Object.entries(EXPORT_QUERIES)) {
    assert.doesNotMatch(sql, /hash/i, name);
    if (['leads', 'sessions', 'verifications'].includes(name)) assert.doesNotMatch(sql, /\*/, `${name} ohne SELECT *`);
  }
});

function fakeClient({ missing = [], failOn } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ present: !missing.includes(params[0].replace('public.', '')) }] };
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      return { rows: [{ sql }] };
    },
  };
}

test('exportAll: eine Read-only-Transaktion, fehlende Tabellen leer, Zähler im Meta-Block', async () => {
  const c = fakeClient({ missing: ['verifications'] });
  const dump = await exportAll(c, { now: () => new Date('2026-10-29T12:00:00Z') });
  assert.match(c.calls[0], /READ ONLY/);
  assert.equal(c.calls.at(-1), 'COMMIT');
  assert.deepEqual(dump.verifications, []);
  assert.equal(dump.leads.length, 1);
  assert.equal(dump.meta.exportedAt, '2026-10-29T12:00:00.000Z');
  assert.deepEqual(Object.keys(dump.meta.counts), Object.keys(EXPORT_QUERIES));
  assert.equal(dump.meta.counts.verifications, 0);
});

test('exportAll: bei Fehler Rollback und Fehler weiterreichen', async () => {
  const c = fakeClient({ failOn: 'FROM leads' });
  await assert.rejects(() => exportAll(c), /boom/);
  assert.equal(c.calls.at(-1), 'ROLLBACK');
});
