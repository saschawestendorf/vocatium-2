// Geschützter Admin-Bereich: Live-Auswertung und CSV-Export (HTTP Basic Auth).
import { timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { escapeHtml, formatEuro } from '../format.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Schutz vor CSV-/Formel-Injection in Excel.
const csvCell = (value) => {
  let s = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// "0049 151 …" statt "+49 …": Excel würde ein führendes "+" als Formel interpretieren.
const formatPhone = (e164) => (parsePhoneNumberFromString(e164)?.formatInternational() ?? e164).replace(/^\+/, '00');
const DATE_FMT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const formatDate = (d) => (d ? DATE_FMT.format(new Date(d)).replace(',', '') : '');

export default async function adminRoutes(app, { pool, config, ids }) {
  app.addHook('onRequest', async (req, reply) => {
    if (!config.admin.password) {
      return reply.code(503).send({ error: 'admin_disabled', message: 'ADMIN_PASSWORD ist nicht gesetzt.' });
    }
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const [user, ...rest] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':') : [];
    if (!safeEqual(user ?? '', config.admin.user) || !safeEqual(rest.join(':'), config.admin.password)) {
      return reply.header('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"').code(401).send('Nicht autorisiert');
    }
  });

  async function loadProjects() {
    const { rows } = await pool.query('SELECT id, slug, title, active FROM projects WHERE event_id = $1 ORDER BY sort_order, id', [ids.eventId]);
    return rows;
  }

  app.get('/export.csv', async (req, reply) => {
    const onlyCompleted = req.query.status !== 'all';
    const projects = await loadProjects();
    const { rows } = await pool.query(
      `SELECT l.*, c.name AS company_name,
         COALESCE(json_object_agg(a.project_id, a.amount_euro) FILTER (WHERE a.project_id IS NOT NULL), '{}') AS alloc
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN lead_allocations a ON a.lead_id = l.id
       WHERE l.event_id = $1 AND ($2::boolean = FALSE OR l.status = 'completed')
       GROUP BY l.id, c.name ORDER BY l.created_at`,
      [ids.eventId, onlyCompleted],
    );
    const header = [
      'Lead-ID', 'Status', 'Erstellt', 'Abgeschlossen', 'Vorname', 'Name', 'E-Mail',
      'Telefon', 'Telefon verifiziert', 'Glücksrad-Betrieb', ...projects.map((p) => `${p.title} (€)`),
      'Einwilligung',
    ];
    const lines = rows.map((r) =>
      [
        r.id, r.status, formatDate(r.created_at), formatDate(r.completed_at), r.first_name, r.last_name, r.email,
        formatPhone(r.phone_e164), formatDate(r.phone_verified_at), r.company_name,
        ...projects.map((p) => r.alloc[p.id] ?? 0), formatDate(r.consent_at),
      ].map(csvCell).join(';'),
    );
    return sendCsv(reply, 'leads', header, lines);
  });

  // Alle Sitzungen inkl. Abbrüche (anonym: Schritt, Budget, Glücksrad, ggf. verknüpfter Lead).
  app.get('/sessions.csv', async (_req, reply) => {
    const projects = await loadProjects();
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS company_name FROM sessions s
       LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.event_id = $1 ORDER BY s.created_at`,
      [ids.eventId],
    );
    const header = [
      'Sitzungs-ID', 'Status', 'Letzter Schritt', 'Abbruchgrund', 'Gestartet', 'Zuletzt aktiv', 'Beendet',
      'Glücksrad-Betrieb', ...projects.map((p) => `${p.title} (€)`), 'Lead-ID',
    ];
    const lines = rows.map((r) =>
      [
        r.id, r.status, r.last_step, r.abort_reason, formatDate(r.created_at), formatDate(r.updated_at), formatDate(r.ended_at),
        r.company_name, ...projects.map((p) => r.allocations?.[p.slug] ?? 0), r.lead_id,
      ].map(csvCell).join(';'),
    );
    return sendCsv(reply, 'sitzungen', header, lines);
  });

  function sendCsv(reply, name, header, lines) {
    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`)
      .header('Cache-Control', 'no-store');
    // BOM für korrekte Umlaute in Excel.
    return `﻿${[header.map(csvCell).join(';'), ...lines].join('\r\n')}\r\n`;
  }

  app.get('/stats', async () => stats());

  async function stats() {
    const [{ rows: [counts] }, { rows: byProject }, { rows: byCompany }, { rows: [sessions] }, { rows: sessionSums }] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM leads WHERE event_id = $1`,
        [ids.eventId],
      ),
      pool.query(
        `SELECT p.slug, p.title, p.active,
           COALESCE(sum(a.amount_euro) FILTER (WHERE l.id IS NOT NULL), 0)::bigint AS sum,
           count(l.id) FILTER (WHERE a.amount_euro > 0)::int AS votes
         FROM projects p
         LEFT JOIN lead_allocations a ON a.project_id = p.id
         LEFT JOIN leads l ON l.id = a.lead_id AND l.status = 'completed'
         WHERE p.event_id = $1
         GROUP BY p.id ORDER BY p.sort_order`,
        [ids.eventId],
      ),
      pool.query(
        `SELECT c.name, count(l.id)::int AS leads FROM companies c
         LEFT JOIN leads l ON l.company_id = c.id AND l.status = 'completed'
         WHERE c.event_id = $1 GROUP BY c.id ORDER BY c.sort_order`,
        [ids.eventId],
      ),
      pool.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'open')::int AS open,
           count(*) FILTER (WHERE status = 'aborted')::int AS aborted,
           count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM sessions WHERE event_id = $1`,
        [ids.eventId],
      ),
      // Budget über alle Sitzungen – inkl. abgebrochener (Stimmungsbild ohne Kontaktdaten).
      pool.query(
        `SELECT a.key AS slug, sum(a.value::bigint)::bigint AS sum
         FROM sessions s, jsonb_each_text(s.allocations) a
         WHERE s.event_id = $1 GROUP BY a.key`,
        [ids.eventId],
      ),
    ]);
    const allSessions = new Map(sessionSums.map((r) => [r.slug, Number(r.sum)]));
    return {
      ...counts,
      sessions,
      byProject: byProject.map((p) => ({ ...p, sum: Number(p.sum), sessionSum: allSessions.get(p.slug) ?? 0 })),
      byCompany,
    };
  }

  app.get('/', async (_req, reply) => {
    const s = await stats();
    const rows = (list, cols) => list.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(c(r))}</td>`).join('')}</tr>`).join('');
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store');
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin – Leads</title><link rel="stylesheet" href="/app.css"></head><body class="admin">
<main class="shell"><p class="kicker">Admin</p><h1 class="display">Auswertung</h1>
<div class="stat-row"><div class="card stat"><span>Abgeschlossen</span><strong>${s.completed}</strong></div>
<div class="card stat"><span>Begonnen</span><strong>${s.total}</strong></div></div>
<div class="stat-row"><div class="card stat"><span>Sitzungen</span><strong>${s.sessions.total}</strong></div>
<div class="card stat"><span>Abgebrochen</span><strong>${s.sessions.aborted}</strong></div>
<div class="card stat"><span>Offen</span><strong>${s.sessions.open}</strong></div></div>
<p><a class="btn btn-primary" href="/admin/export.csv">CSV (abgeschlossen)</a>
<a class="btn btn-ghost" href="/admin/export.csv?status=all">CSV (alle)</a>
<a class="btn btn-ghost" href="/admin/sessions.csv">CSV Sitzungen (inkl. Abbrüche)</a></p>
<h2>Budget je Projekt</h2>
<table class="table"><thead><tr><th>Projekt</th><th>Summe (abgeschlossen)</th><th>Stimmen</th><th>Summe (alle Sitzungen)</th></tr></thead>
<tbody>${rows(s.byProject, [(p) => p.title + (p.active ? '' : ' (inaktiv)'), (p) => formatEuro(p.sum), (p) => p.votes, (p) => formatEuro(p.sessionSum)])}</tbody></table>
<h2>Glücksrad je Betrieb</h2>
<table class="table"><thead><tr><th>Betrieb</th><th>Leads</th></tr></thead>
<tbody>${rows(s.byCompany, [(c) => c.name, (c) => c.leads])}</tbody></table>
</main></body></html>`;
  });
}
