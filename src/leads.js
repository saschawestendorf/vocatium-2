// Fachlogik: Leads anlegen/ändern, optionale SMS-Codes versenden/prüfen, Abschluss.
import { withTransaction } from './db.js';
import { generateCode, generateToken, hmac, safeEqualHex } from './crypto.js';
import { validateLead } from './validation.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// Einziger Verifizierungskanal (optional, per VERIFY_PHONE). E-Mail wird nicht verifiziert.
const CHANNELS = ['sms'];

export function createLeadService({ pool, config, event, ids, smsProvider, log }) {
  const secret = config.appSecret;
  const v = config.verify;
  const required = { sms: v.phone };
  // Ohne SMS-Verifizierung genügt jede gültige Telefonnummer (auch Festnetz/Ausland).
  const phoneOptions = v.phone ? { allowedCountries: config.sms.allowedCountries, requireMobile: true } : {};
  const hashToken = (t) => hmac(secret, `token:${t}`);
  const hashCode = (leadId, channel, code) => hmac(secret, `code:${leadId}:${channel}:${code}`);

  function stateOf(lead) {
    return {
      leadId: lead.id,
      status: lead.status,
      email: lead.email,
      phone: lead.phone_e164,
      verification: {
        sms: { required: required.sms, verified: Boolean(lead.phone_verified_at) },
      },
    };
  }

  const isFullyVerified = (lead) => !required.sms || lead.phone_verified_at;

  // Lädt Lead und prüft das Zugriffstoken. Optional mit Zeilensperre innerhalb einer Transaktion.
  async function authorize(db, leadId, token, { lock = false } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(String(leadId)) || !token) throw new AppError(404, 'not_found', 'Eintrag nicht gefunden.');
    const { rows: [lead] } = await db.query(
      `SELECT * FROM leads WHERE id = $1 AND event_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [leadId, ids.eventId],
    );
    if (!lead || !safeEqualHex(lead.access_token_hash, hashToken(token))) {
      throw new AppError(404, 'not_found', 'Eintrag nicht gefunden.');
    }
    return lead;
  }

  async function writeAllocations(db, leadId, allocations) {
    await db.query('DELETE FROM lead_allocations WHERE lead_id = $1', [leadId]);
    const slugs = Object.keys(allocations);
    await db.query(
      `INSERT INTO lead_allocations (lead_id, project_id, amount_euro)
       SELECT $1, unnest($2::int[]), unnest($3::int[])`,
      [leadId, slugs.map((s) => ids.projectIds.get(s)), slugs.map((s) => allocations[s])],
    );
  }

  // Anlegen oder – solange noch nicht abgeschlossen – Ändern eines Leads (z. B. Tippfehler in der Nummer).
  async function submit(input, { leadId, token, userAgent } = {}) {
    const { data, fieldErrors } = validateLead(input, event, phoneOptions);
    if (fieldErrors) throw new AppError(422, 'validation', 'Bitte prüfe deine Eingaben.', { fieldErrors });
    const companyId = ids.companyIds.get(data.companySlug);

    const result = await withTransaction(pool, async (db) => {
      if (leadId && token) {
        const lead = await authorize(db, leadId, token, { lock: true });
        if (lead.status === 'completed') throw new AppError(409, 'completed', 'Dieser Eintrag ist bereits abgeschlossen.');
        const phoneChanged = lead.phone_e164 !== data.phoneE164;
        const { rows: [updated] } = await db.query(
          `UPDATE leads SET first_name = $2, last_name = $3, email = $4, phone_e164 = $5, company_id = $6,
             phone_verified_at = CASE WHEN $7 THEN NULL ELSE phone_verified_at END,
             consent_text = $8, consent_at = now(), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [lead.id, data.firstName, data.lastName, data.email, data.phoneE164, companyId, phoneChanged, event.consentText],
        );
        // Alte Codes bei geänderter Nummer entwerten.
        if (phoneChanged) {
          await db.query(
            "UPDATE verifications SET consumed_at = now() WHERE lead_id = $1 AND channel = 'sms' AND consumed_at IS NULL",
            [lead.id],
          );
        }
        await writeAllocations(db, lead.id, data.allocations);
        return { lead: updated, token };
      }

      const newToken = generateToken();
      const { rows: [lead] } = await db.query(
        `INSERT INTO leads (event_id, access_token_hash, first_name, last_name, email, phone_e164, company_id,
           consent_text, consent_at, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) RETURNING *`,
        [ids.eventId, hashToken(newToken), data.firstName, data.lastName, data.email, data.phoneE164, companyId,
          event.consentText, userAgent?.slice(0, 500) ?? null],
      );
      await writeAllocations(db, lead.id, data.allocations);
      return { lead, token: newToken };
    });

    // Ohne Pflicht-Verifizierung sofort abschließen.
    const lead = isFullyVerified(result.lead) ? await complete(result.lead.id) : result.lead;
    return { token: result.token, ...stateOf(lead) };
  }

  async function status(leadId, token) {
    return stateOf(await authorize(pool, leadId, token));
  }

  async function sendCode(leadId, token, channel) {
    if (!CHANNELS.includes(channel)) throw new AppError(400, 'bad_channel', 'Unbekannter Kanal.');
    if (!required[channel]) throw new AppError(400, 'not_required', 'Diese Verifizierung ist nicht aktiv.');

    const prepared = await withTransaction(pool, async (db) => {
      const lead = await authorize(db, leadId, token, { lock: true });
      if (lead.status === 'completed') throw new AppError(409, 'completed', 'Bereits abgeschlossen.');
      if (lead.phone_verified_at) throw new AppError(409, 'already_verified', 'Bereits bestätigt.');
      const target = lead.phone_e164;

      const { rows: [last] } = await db.query(
        `SELECT EXTRACT(EPOCH FROM (now() - created_at))::int AS age FROM verifications
         WHERE lead_id = $1 AND channel = $2 ORDER BY created_at DESC LIMIT 1`,
        [lead.id, channel],
      );
      if (last && last.age < v.resendCooldownSeconds) {
        const retryAfter = v.resendCooldownSeconds - last.age;
        throw new AppError(429, 'cooldown', `Bitte warte noch ${retryAfter} Sekunden.`, { retryAfter });
      }
      // Schutz vor Kostenmissbrauch (SMS-Pumping) und Spam: Limit pro Zieladresse.
      const { rows: [{ count }] } = await db.query(
        `SELECT count(*)::int AS count FROM verifications
         WHERE channel = $1 AND target = $2 AND created_at > now() - interval '1 hour'`,
        [channel, target],
      );
      if (count >= v.maxSendsPerTargetPerHour) {
        throw new AppError(429, 'target_limit', 'Zu viele Codes angefordert. Bitte versuche es später erneut.');
      }

      const code = generateCode();
      await db.query('UPDATE verifications SET consumed_at = now() WHERE lead_id = $1 AND channel = $2 AND consumed_at IS NULL', [
        lead.id,
        channel,
      ]);
      const { rows: [row] } = await db.query(
        `INSERT INTO verifications (lead_id, channel, target, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id`,
        [lead.id, channel, target, hashCode(lead.id, channel, code), v.ttlMinutes],
      );
      return { lead, target, code, verificationId: row.id };
    });

    // Versand außerhalb der Transaktion (kein DB-Lock während externer Aufrufe).
    try {
      await smsProvider.send({
        to: prepared.target,
        text: `${prepared.code} ist dein Code für „${event.title.replace(/\.$/, '')}“. Gültig ${v.ttlMinutes} Min.`,
      });
    } catch (err) {
      log.error({ err: err.message, channel, leadId }, 'Code-Versand fehlgeschlagen');
      // Fehlgeschlagenen Versand nicht auf Cooldown/Limit anrechnen.
      await pool.query('DELETE FROM verifications WHERE id = $1', [prepared.verificationId]).catch(() => {});
      throw new AppError(502, 'send_failed', sendFailureMessage(err));
    }
    return { sent: true, target: maskTarget(prepared.target), cooldownSeconds: v.resendCooldownSeconds };
  }

  async function verifyCode(leadId, token, channel, rawCode) {
    if (!CHANNELS.includes(channel)) throw new AppError(400, 'bad_channel', 'Unbekannter Kanal.');
    const code = String(rawCode ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw new AppError(422, 'invalid_code', 'Bitte gib den 6-stelligen Code ein.');

    const lead = await withTransaction(pool, async (db) => {
      const lead = await authorize(db, leadId, token, { lock: true });
      if (lead.phone_verified_at) return lead; // idempotent
      const target = lead.phone_e164;

      const { rows: [ver] } = await db.query(
        `SELECT * FROM verifications WHERE lead_id = $1 AND channel = $2 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [lead.id, channel],
      );
      if (!ver || ver.target !== target) throw new AppError(422, 'no_code', 'Bitte fordere zuerst einen Code an.');
      if (new Date(ver.expires_at) < new Date()) throw new AppError(422, 'expired', 'Der Code ist abgelaufen. Bitte fordere einen neuen an.');
      if (ver.attempts >= v.maxAttempts) {
        throw new AppError(429, 'too_many_attempts', 'Zu viele Fehlversuche. Bitte fordere einen neuen Code an.');
      }
      if (!safeEqualHex(ver.code_hash, hashCode(lead.id, channel, code))) {
        await db.query('UPDATE verifications SET attempts = attempts + 1 WHERE id = $1', [ver.id]);
        const left = v.maxAttempts - ver.attempts - 1;
        // Kein Throw, damit der Zähler nicht per Rollback verloren geht.
        return { wrongCode: true, left };
      }
      await db.query('UPDATE verifications SET consumed_at = now() WHERE id = $1', [ver.id]);
      const { rows: [updated] } = await db.query(
        'UPDATE leads SET phone_verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
        [lead.id],
      );
      return updated;
    });

    if (lead.wrongCode) {
      throw new AppError(422, 'wrong_code', lead.left > 0 ? `Code falsch. Noch ${lead.left} Versuch(e).` : 'Code falsch. Bitte fordere einen neuen Code an.');
    }
    const final = isFullyVerified(lead) && lead.status !== 'completed' ? await complete(lead.id) : lead;
    return stateOf(final);
  }

  // Abschluss: Status setzen (idempotent). Es wird keine E-Mail versendet.
  async function complete(leadId) {
    const { rows: [lead] } = await pool.query(
      `UPDATE leads SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [leadId],
    );
    return lead;
  }

  return { submit, status, sendCode, verifyCode };
}

// Nutzerfreundliche Meldung: Nur bei vom Anbieter abgelehnter Nummer (422/400)
// liegt der Fehler beim Nutzer; Konfigurationsfehler (401/403) oder Ausfälle nicht.
export function sendFailureMessage(err) {
  if (err?.status === 400 || err?.status === 422) return 'Die Nummer wurde abgelehnt. Bitte prüfe die Nummer.';
  if (err?.status === 429) return 'Gerade werden sehr viele SMS verschickt. Bitte versuche es in einer Minute erneut.';
  return 'Der SMS-Versand ist gerade nicht möglich. Bitte sprich das Standteam an.';
}

export function maskTarget(target) {
  return `${target.slice(0, 4)}${'•'.repeat(Math.max(1, target.length - 7))}${target.slice(-3)}`;
}
