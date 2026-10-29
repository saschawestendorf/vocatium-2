import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeSnapshot } from '../src/sessions.js';

const event = {
  budget: { totalEuro: 10000 },
  projects: [{ slug: 'polio' }, { slug: 'wasser' }],
  companies: [{ slug: 'baecker' }],
};

test('sanitizeSnapshot übernimmt gültige Werte', () => {
  const s = sanitizeSnapshot(
    { step: 'contact', allocations: { polio: 6000, wasser: '4000' }, companySlug: 'baecker', leadId: 'BC30C4A0-9DD4-48FA-814C-FE9034A90CDD' },
    event,
  );
  assert.deepEqual(s, { step: 'contact', allocations: { polio: 6000, wasser: 4000 }, companySlug: 'baecker', leadId: 'BC30C4A0-9DD4-48FA-814C-FE9034A90CDD' });
});

test('sanitizeSnapshot verwirft Ungültiges statt abzulehnen', () => {
  const s = sanitizeSnapshot(
    { step: 'hack', allocations: { polio: -5, wasser: 1.5, fremd: 100, __proto__: { x: 1 } }, companySlug: 'unbekannt', leadId: "1' OR 1=1" },
    event,
  );
  assert.deepEqual(s, { step: 'start', allocations: {}, companySlug: null, leadId: null });
  assert.deepEqual(sanitizeSnapshot(null, event), { step: 'start', allocations: {}, companySlug: null, leadId: null });
  assert.deepEqual(sanitizeSnapshot({ allocations: { polio: 20000 } }, event).allocations, {});
});
