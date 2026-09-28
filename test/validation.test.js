import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseEventConfig } from '../src/event.js';
import { cleanText, normalizeEmail, normalizePhone, validateAllocations, validateLead } from '../src/validation.js';

const event = parseEventConfig(JSON.parse(readFileSync(new URL('../config/event.json', import.meta.url))));
const base = {
  allocations: { 'end-polio-now': 6000, 'projekt-2': 4000 },
  companySlug: 'betrieb-1',
  firstName: ' Franz ',
  lastName: 'Beispiel',
  phone: '0151 23456789',
  email: ' Mail@Example.com ',
  consent: true,
};

test('Event-Konfiguration ist gültig', () => {
  assert.equal(event.projects.length, 5);
  assert.equal(event.companies.length, 5);
  assert.equal(event.budget.totalEuro, 10000);
});

test('Event-Konfiguration: doppelte Slugs und krumme Schritte werden abgelehnt', () => {
  const raw = JSON.parse(JSON.stringify(event));
  raw.projects[1].slug = raw.projects[0].slug;
  assert.throws(() => parseEventConfig(raw), /Doppelter Slug/);
  const raw2 = JSON.parse(JSON.stringify(event));
  raw2.budget.stepEuro = 300;
  assert.throws(() => parseEventConfig(raw2), /teilbar/);
});

test('cleanText entfernt Steuerzeichen und normalisiert Leerraum', () => {
  assert.equal(cleanText('  a\u0000b \n c  '), 'ab c');
  assert.equal(cleanText(null), '');
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail(' Mail@Example.COM '), 'mail@example.com');
  // Leerzeichen (z. B. durch Tablet-Autokorrektur) werden entfernt; Tippfehler fängt die Code-Verifizierung ab.
  assert.equal(normalizeEmail('name @gmail.com'), 'name@gmail.com');
  for (const bad of ['', 'x@', '@x.de', 'a@b', 'a@@b.de', null]) assert.equal(normalizeEmail(bad), null, String(bad));
});

test('normalizePhone: deutsche Mobilnummern in verschiedenen Schreibweisen', () => {
  for (const input of ['0151 23456789', '+49 151 23456789', '0049151/23456789', '(0151) 234-56789']) {
    assert.equal(normalizePhone(input).e164, '+4915123456789', input);
  }
});

test('normalizePhone: Festnetz, Unsinn und nicht freigegebene Länder', () => {
  assert.match(normalizePhone('03831 123456').error, /Handynummer an/);
  assert.match(normalizePhone('12').error, /ungültig/);
  assert.match(normalizePhone('').error, /Handynummer/);
  assert.match(normalizePhone('+43 664 1234567').error, /nicht unterstützt/);
  assert.equal(normalizePhone('+43 664 1234567', { allowedCountries: ['DE', 'AT'] }).e164, '+436641234567');
});

test('validateAllocations: exakte Vollverteilung', () => {
  const ok = validateAllocations({ 'end-polio-now': 10000 }, event);
  assert.equal(ok.sum, 10000);
  assert.equal(ok.allocations['projekt-5'], 0);
  assert.equal(validateAllocations({ 'end-polio-now': '6.000', 'projekt-2': 4000 }, event).sum, 10000);
});

test('validateAllocations: Fehlerfälle', () => {
  const cases = [
    [{ 'end-polio-now': 9000 }, /noch 1000 € übrig/],
    [{ 'end-polio-now': 10000, 'projekt-2': 100 }, /zu viel/],
    [{ 'end-polio-now': 9950, 'projekt-2': 50 }, /Schritten/],
    [{ 'end-polio-now': -100, 'projekt-2': 10100 }, /Ungültiger Betrag/],
    [{ 'end-polio-now': 1.5 }, /Ungültiger Betrag/],
    [{ unbekannt: 10000 }, /Unbekanntes Projekt/],
    [{}, /Bitte verteile/],
    [null, /fehlt/],
    [[1, 2], /fehlt/],
  ];
  for (const [input, re] of cases) assert.match(validateAllocations(input, event).errors.join(' '), re, JSON.stringify(input));
});

test('validateAllocations: Teilverteilung erlaubt, wenn konfiguriert', () => {
  const partial = { ...event, budget: { ...event.budget, requireFullAllocation: false } };
  assert.equal(validateAllocations({ 'end-polio-now': 500 }, partial).sum, 500);
});

test('validateLead: gültige Eingabe wird normalisiert', () => {
  const { data, fieldErrors } = validateLead(base, event, { allowedCountries: ['DE'] });
  assert.equal(fieldErrors, undefined);
  assert.equal(data.firstName, 'Franz');
  assert.equal(data.email, 'mail@example.com');
  assert.equal(data.phoneE164, '+4915123456789');
});

test('validateLead: sammelt Feldfehler', () => {
  const { fieldErrors } = validateLead({ ...base, companySlug: 'x', consent: false, firstName: '' }, event, { allowedCountries: ['DE'] });
  assert.deepEqual(Object.keys(fieldErrors).sort(), ['companySlug', 'consent', 'firstName']);
  assert.ok(validateLead(null, event, { allowedCountries: ['DE'] }).fieldErrors.allocations);
});
