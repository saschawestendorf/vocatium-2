// Sitzungen: speichert jeden Durchlauf ab dem ersten Schritt (Schritt, Budget, Glücksrad) – auch bei Abbruch.
// Bewusst ohne personenbezogene Daten: Kontaktdaten werden erst mit Einwilligung als Lead gespeichert.
import { generateToken, hmac, safeEqualHex } from './crypto.js';
import { AppError } from './leads.js';

export const SESSION_STEPS = ['start', 'budget', 'spin', 'contact', 'verify', 'done'];
export const ABORT_REASONS = ['idle', 'reset', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tolerante Bereinigung: Ungültiges wird verworfen statt abgelehnt (Zwischenstände sind nie „falsch“).
export function sanitizeSnapshot(input, event) {
  const src = input && typeof input === 'object' ? input : {};
  const allocIn = src.allocations && typeof src.allocations === 'object' ? src.allocations : {};
  const allocations = {};
  for (const { slug } of event.projects) {
    const n = Number(allocIn[slug]);
    if (Number.isInteger(n) && n > 0 && n <= event.budget.totalEuro) allocations[slug] = n;
  }
  const companySlug = event.companies.some((c) => c.slug === src.companySlug) ? src.companySlug : null;
  return {
    step: SESSION_STEPS.includes(src.step) ? src.step : 'start',
    allocations,
    companySlug,
    leadId: UUID_RE.test(String(src.leadId ?? '')) ? String(src.leadId) : null,
  };
}

export function createSessionService({ pool, config, event, ids }) {
  const hashToken = (t) => hmac(config.appSecret, `session:${t}`);

  async function authorize(sessionId, token) {
    if (!UUID_RE.test(String(sessionId)) || !token) throw new AppError(404, 'not_found', 'Sitzung nicht gefunden.');
    const { rows: [s] } = await pool.query('SELECT id, token_hash, status FROM sessions WHERE id = $1 AND event_id = $2', [
      sessionId,
      ids.eventId,
    ]);
    if (!s || !safeEqualHex(s.token_hash, hashToken(token))) throw new AppError(404, 'not_found', 'Sitzung nicht gefunden.');
    return s;
  }

  // Nur ein tatsächlich abgeschlossener Lead dieses Events schließt die Sitzung ab.
  async function completedLeadId(leadId) {
    if (!leadId) return null;
    const { rows: [l] } = await pool.query("SELECT id FROM leads WHERE id = $1 AND event_id = $2 AND status = 'completed'", [
      leadId,
      ids.eventId,
    ]);
    return l?.id ?? null;
  }

  async function create(input, { userAgent } = {}) {
    const snap = sanitizeSnapshot(input, event);
    // Schneller Durchlauf: Die Sitzung kann erst bei „Fertig“ angelegt werden – dann direkt abschließen.
    const leadId = snap.step === 'done' ? await completedLeadId(snap.leadId) : null;
    const token = generateToken();
    const { rows: [s] } = await pool.query(
      `INSERT INTO sessions (event_id, token_hash, last_step, allocations, company_id, user_agent, lead_id, status, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid,
         CASE WHEN $7::uuid IS NOT NULL THEN 'completed' ELSE 'open' END,
         CASE WHEN $7::uuid IS NOT NULL THEN now() END)
       RETURNING id`,
      [ids.eventId, hashToken(token), snap.step, snap.allocations, ids.companyIds.get(snap.companySlug) ?? null,
        userAgent?.slice(0, 500) ?? null, leadId],
    );
    return { sessionId: s.id, token };
  }

  // Zwischenstand speichern. Beendete Sitzungen werden nicht mehr verändert (idempotent, kein Fehler).
  async function update(sessionId, token, input) {
    const s = await authorize(sessionId, token);
    if (s.status !== 'open') return { status: s.status };
    const snap = sanitizeSnapshot(input, event);
    const leadId = snap.step === 'done' ? await completedLeadId(snap.leadId) : null;
    const { rows: [row] } = await pool.query(
      `UPDATE sessions SET last_step = $2, allocations = $3, company_id = $4, lead_id = COALESCE($5, lead_id),
         status = CASE WHEN $5::uuid IS NOT NULL THEN 'completed' ELSE status END,
         ended_at = CASE WHEN $5::uuid IS NOT NULL THEN now() ELSE ended_at END,
         updated_at = now()
       WHERE id = $1 AND status = 'open' RETURNING status`,
      [s.id, snap.step, snap.allocations, ids.companyIds.get(snap.companySlug) ?? null, leadId],
    );
    return { status: row?.status ?? s.status };
  }

  // Abbruch (Kiosk-Reset, Inaktivität): letzten Stand sichern und Sitzung als abgebrochen markieren.
  async function abort(sessionId, token, input) {
    const s = await authorize(sessionId, token);
    if (s.status !== 'open') return { status: s.status };
    const snap = sanitizeSnapshot(input, event);
    const reason = ABORT_REASONS.includes(input?.reason) ? input.reason : 'other';
    await pool.query(
      `UPDATE sessions SET last_step = $2, allocations = $3, company_id = $4, status = 'aborted', abort_reason = $5,
         ended_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open'`,
      [s.id, snap.step, snap.allocations, ids.companyIds.get(snap.companySlug) ?? null, reason],
    );
    return { status: 'aborted' };
  }

  return { create, update, abort };
}
