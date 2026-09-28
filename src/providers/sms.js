// SMS-Versand. Provider austauschbar: "twilio", "seven" (seven.io, DE) oder "console" (Entwicklung).
import { requestJson } from './http.js';

export function createSmsProvider(config, log) {
  const { provider, sender, twilio, seven } = config.sms;

  if (provider === 'twilio') {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
    return {
      name: 'twilio',
      async send({ to, text }) {
        const form = new URLSearchParams({ To: to, Body: text });
        if (twilio.messagingServiceSid) form.set('MessagingServiceSid', twilio.messagingServiceSid);
        else form.set('From', twilio.from);
        const res = await requestJson(url, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        return { id: res?.sid };
      },
    };
  }

  if (provider === 'seven') {
    return {
      name: 'seven',
      async send({ to, text }) {
        const res = await requestJson('https://gateway.seven.io/api/sms', {
          method: 'POST',
          headers: { 'X-Api-Key': seven.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ to, text, from: sender }),
        });
        // seven.io liefert HTTP 200 auch bei Fehlern; success "100" = OK.
        if (res && typeof res === 'object' && res.success !== undefined && String(res.success) !== '100') {
          throw new Error(`seven.io Fehlercode ${res.success}`);
        }
        return { id: res?.messages?.[0]?.id ?? null };
      },
    };
  }

  return {
    name: 'console',
    async send({ to, text }) {
      log.info({ to }, `[sms:console] ${text}`);
      return { id: 'console' };
    },
  };
}
