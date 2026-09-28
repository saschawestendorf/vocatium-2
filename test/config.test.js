import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('Defaults für Entwicklung', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x' });
  assert.equal(c.email.provider, 'console');
  assert.deepEqual(c.sms.allowedCountries, ['DE']);
  assert.equal(c.verify.email, true);
  assert.equal(c.verify.phone, false);
});

test('Produktion verlangt Secrets und Provider-Keys', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x', NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', SMS_PROVIDER: 'twilio' }),
    (err) => ['APP_SECRET', 'ADMIN_PASSWORD', 'RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM'].every((k) => err.message.includes(k)),
  );
});

test('Boolesche und Listen-Variablen', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', VERIFY_PHONE: 'true', SMS_ALLOWED_COUNTRIES: 'de, at ,ch' });
  assert.equal(c.verify.phone, true);
  assert.deepEqual(c.sms.allowedCountries, ['DE', 'AT', 'CH']);
});
