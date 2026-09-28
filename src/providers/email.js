// E-Mail-Versand. Provider austauschbar: "resend" (Produktion) oder "console" (Entwicklung).
import { requestJson } from './http.js';

export function createEmailProvider(config, log) {
  const { provider, resendApiKey, from, replyTo } = config.email;

  if (provider === 'resend') {
    return {
      name: 'resend',
      // Startprüfung: Ist die Absender-Domain in Resend verifiziert? Nur Warnung, kein Abbruch.
      async check() {
        const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
        try {
          const res = await requestJson('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendApiKey}` } });
          const list = res?.data ?? [];
          const match = list.find((d) => d.name?.toLowerCase() === domain);
          if (!match) {
            log.error(`[email] Absender-Domain „${domain}“ ist in Resend nicht vorhanden (EMAIL_FROM prüfen). Verfügbar: ${list.map((d) => `${d.name} (${d.status})`).join(', ') || '–'}`);
          } else if (match.status !== 'verified') {
            log.error(`[email] Absender-Domain „${domain}“ ist in Resend nicht verifiziert (Status: ${match.status}).`);
          } else {
            log.info(`[email] Resend bereit, Absender-Domain „${domain}“ verifiziert.`);
          }
        } catch (err) {
          // Sending-only API-Keys dürfen Domains nicht lesen → Prüfung überspringen.
          log.warn(`[email] Domain-Prüfung übersprungen: ${err.message}`);
        }
      },
      async send({ to, subject, html, text, idempotencyKey }) {
        const headers = { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const res = await requestJson('https://api.resend.com/emails', {
          method: 'POST',
          headers,
          body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
        return { id: res?.id };
      },
    };
  }

  return {
    name: 'console',
    async check() {},
    async send({ to, subject, text }) {
      log.info({ to, subject }, `[email:console] ${subject}\n${text}`);
      return { id: 'console' };
    },
  };
}
