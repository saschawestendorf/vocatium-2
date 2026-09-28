import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCode, generateToken, hmac, safeEqualHex } from '../src/crypto.js';
import { maskTarget } from '../src/leads.js';
import { escapeHtml } from '../src/emails.js';

test('generateCode liefert immer 6 Ziffern', () => {
  for (let i = 0; i < 500; i++) assert.match(generateCode(), /^\d{6}$/);
});

test('Tokens sind eindeutig und lang genug', () => {
  const a = generateToken();
  assert.ok(a.length >= 43);
  assert.notEqual(a, generateToken());
});

test('hmac/safeEqualHex', () => {
  const h = hmac('s', 'x');
  assert.ok(safeEqualHex(h, hmac('s', 'x')));
  assert.ok(!safeEqualHex(h, hmac('t', 'x')));
  assert.ok(!safeEqualHex(h, 'abc'));
  assert.ok(!safeEqualHex(undefined, h));
});

test('maskTarget verbirgt Teile von E-Mail und Telefon', () => {
  assert.equal(maskTarget('email', 'franz@example.com'), 'fr•••@example.com');
  assert.equal(maskTarget('sms', '+4915123456789'), '+491•••••••789');
});

test('escapeHtml', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
