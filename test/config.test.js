import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('Defaults für Entwicklung', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x' });
  assert.deepEqual(c.sms.allowedCountries, ['DE']);
  assert.equal(c.verify.phone, false);
});

test('Produktion verlangt Secrets und Provider-Keys', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x', NODE_ENV: 'production', SMS_PROVIDER: 'twilio' }),
    (err) => ['APP_SECRET', 'ADMIN_PASSWORD', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM'].every((k) => err.message.includes(k)),
  );
});

test('Boolesche und Listen-Variablen', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', VERIFY_PHONE: 'true', SMS_ALLOWED_COUNTRIES: 'de, at ,ch' });
  assert.equal(c.verify.phone, true);
  assert.deepEqual(c.sms.allowedCountries, ['DE', 'AT', 'CH']);
});

test('Alte E-Mail-Variablen (Resend) werden ignoriert und brechen den Start nicht ab', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', VERIFY_EMAIL: 'true' });
  assert.equal(c.email, undefined);
  assert.equal(c.verify.email, undefined);
});

test('Virtuelles Glücksrad ist standardmäßig aus und per VIRTUAL_WHEEL schaltbar', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x' }).virtualWheel, false);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x', VIRTUAL_WHEEL: 'TRUE' }).virtualWheel, true);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x', VIRTUAL_WHEEL: 'false' }).virtualWheel, false);
});
