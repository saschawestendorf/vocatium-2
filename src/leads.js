// Fachlogik: Leads anlegen/ändern, Codes versenden/prüfen, Abschluss inkl. Bestätigungs-E-Mail.
import { withTransaction } from './db.js';
import { generateCode, generateToken, hmac, safeEqualHex } from './crypto.js';
import { confirmationEmail, verificationEmail } from './emails.js';
import { validateLead } from './validation.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const CHANNELS = ['email', 'sms'];

export function createLeadService({ pool, config, event, ids, emailProvider, smsProvider, log }) {
  const secret = config.appSecret;
  const v = config.verify;
  const required = { email: v.email, sms: v.phone };
  const hashToken = (t) => hmac(secret, `token:${t}`);
  const hashCode = (leadId, channel, code) => hmac(secret, `code:${leadId}:${channel}:${code}`);

  function stateOf(lead) {
    return {
      leadId: lead.id,
      status: lead.status,
      email: lead.email,
      phone: lead.phone_e164,
      verification: {
        email: { required: required.email, verified: Boolean(lead.email_verified_at) },
        sms: { required: required.sms, verified: Boolean(lead.phone_verified_at) },
      },
    };
  }

  const isFullyVerified = (lead) =>
    (!required.email || lead.email_verified_at) && (!required.sms || lead.phone_verified_at);

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

  // Anlegen oder – solange noch nicht abgeschlossen – Ändern eines Leads (z. B. Tippfehler in der E-Mail).
  async function submit(input, { leadId, token, userAgent } = {}) {
    const { data, fieldErrors } = validateLead(input, event, { allowedCountries: config.sms.allowedCountries });
    if (fieldErrors) throw new AppError(422, 'validation', 'Bitte prüfe deine Eingaben.', { fieldErrors });
    const companyId = ids.companyIds.get(data.companySlug);

    const result = await withTransaction(pool, async (db) => {
      if (leadId && token) {
        const lead = await authorize(db, leadId, token, { lock: true });
        if (lead.status === 'completed') throw new AppError(409, 'completed', 'Dieser Eintrag ist bereits abgeschlossen.');
        const emailChanged = lead.email !== data.email;
        const phoneChanged = lead.phone_e164 !== data.phoneE164;
        const { rows: [updated] } = await db.query(
          `UPDATE leads SET first_name = $2, last_name = $3, email = $4, phone_e164 = $5, company_id = $6,
             email_verified_at = CASE WHEN $7 THEN NULL ELSE email_verified_at END,
             phone_verified_at = CASE WHEN $8 THEN NULL ELSE phone_verified_at END,
             consent_text = $9, consent_at = now(), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [lead.id, data.firstName, data.lastName, data.email, data.phoneE164, companyId, emailChanged, phoneChanged, event.consentText],
        );
        // Alte Codes für geänderte Kanäle entwerten.
        const invalidate = [emailChanged && 'email', phoneChanged && 'sms'].filter(Boolean);
        if (invalidate.length) {
          await db.query(
            'UPDATE verifications SET consumed_at = now() WHERE lead_id = $1 AND channel = ANY($2) AND consumed_at IS NULL',
            [lead.id, invalidate],
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
      if (channel === 'email' ? lead.email_verified_at : lead.phone_verified_at) {
        throw new AppError(409, 'already_verified', 'Bereits bestätigt.');
      }
      const target = channel === 'email' ? lead.email : lead.phone_e164;

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
      if (channel === 'email') {
        const mail = verificationEmail(event, { firstName: prepared.lead.first_name, code: prepared.code, ttlMinutes: v.ttlMinutes });
        await emailProvider.send({ to: prepared.target, ...mail });
      } else {
        await smsProvider.send({
          to: prepared.target,
          text: `${prepared.code} ist dein Code für „${event.title.replace(/\.$/, '')}“. Gültig ${v.ttlMinutes} Min.`,
        });
      }
    } catch (err) {
      log.error({ err: err.message, channel, leadId }, 'Code-Versand fehlgeschlagen');
      // Fehlgeschlagenen Versand nicht auf Cooldown/Limit anrechnen.
      await pool.query('DELETE FROM verifications WHERE id = $1', [prepared.verificationId]).catch(() => {});
      throw new AppError(
        502,
        'send_failed',
        channel === 'email'
          ? 'Die E-Mail konnte nicht versendet werden. Bitte prüfe die Adresse.'
          : 'Die SMS konnte nicht versendet werden. Bitte prüfe die Nummer.',
      );
    }
    return { sent: true, target: maskTarget(channel, prepared.target), cooldownSeconds: v.resendCooldownSeconds };
  }

  async function verifyCode(leadId, token, channel, rawCode) {
    if (!CHANNELS.includes(channel)) throw new AppError(400, 'bad_channel', 'Unbekannter Kanal.');
    const code = String(rawCode ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw new AppError(422, 'invalid_code', 'Bitte gib den 6-stelligen Code ein.');

    const lead = await withTransaction(pool, async (db) => {
      const lead = await authorize(db, leadId, token, { lock: true });
      const verifiedCol = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
      if (lead[verifiedCol]) return lead; // idempotent
      const target = channel === 'email' ? lead.email : lead.phone_e164;

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
        `UPDATE leads SET ${verifiedCol} = now(), updated_at = now() WHERE id = $1 RETURNING *`,
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

  // Abschluss: Status setzen und Bestätigungs-E-Mail senden (idempotent).
  async function complete(leadId) {
    const { rows: [lead] } = await pool.query(
      `UPDATE leads SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [leadId],
    );
    if (!lead.confirmation_sent_at) await sendConfirmation(lead);
    return lead;
  }

  async function sendConfirmation(lead) {
    try {
      const { rows } = await pool.query(
        `SELECT p.title, a.amount_euro AS amount FROM lead_allocations a JOIN projects p ON p.id = a.project_id
         WHERE a.lead_id = $1 ORDER BY p.sort_order`,
        [lead.id],
      );
      const { rows: [company] } = await pool.query('SELECT name FROM companies WHERE id = $1', [lead.company_id]);
      const mail = confirmationEmail(event, {
        firstName: lead.first_name,
        lastName: lead.last_name,
        companyName: company?.name ?? '',
        allocations: rows,
      });
      await emailProvider.send({ to: lead.email, ...mail, idempotencyKey: `confirmation-${lead.id}` });
      await pool.query('UPDATE leads SET confirmation_sent_at = now() WHERE id = $1', [lead.id]);
    } catch (err) {
      // Lead bleibt gültig; fehlender Versand ist im Export sichtbar (confirmation_sent_at leer).
      log.error({ err: err.message, leadId: lead.id }, 'Bestätigungs-E-Mail fehlgeschlagen');
    }
  }

  return { submit, status, sendCode, verifyCode };
}

export function maskTarget(channel, target) {
  if (channel === 'email') {
    const [user, domain] = target.split('@');
    return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  return `${target.slice(0, 4)}${'•'.repeat(Math.max(1, target.length - 7))}${target.slice(-3)}`;
}
