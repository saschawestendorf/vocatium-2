// E-Mail-Versand. Provider austauschbar: "resend" (Produktion) oder "console" (Entwicklung).
import { requestJson } from './http.js';

export function createEmailProvider(config, log) {
  const { provider, resendApiKey, from, replyTo } = config.email;

  if (provider === 'resend') {
    return {
      name: 'resend',
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
    async send({ to, subject, text }) {
      log.info({ to, subject }, `[email:console] ${subject}\n${text}`);
      return { id: 'console' };
    },
  };
}
