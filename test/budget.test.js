import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebalance } from '../public/budget.js';

const opts = { total: 10000, step: 100 };
const sum = (a) => Object.values(a).reduce((s, v) => s + v, 0);

test('Ohne Überschreitung bleiben andere Projekte unverändert', () => {
  const r = rebalance({ a: 2000, b: 3000, c: 0 }, 'c', 4000, opts);
  assert.deepEqual(r, { a: 2000, b: 3000, c: 4000 });
});

test('Überschreitung kürzt andere proportional', () => {
  const r = rebalance({ a: 6000, b: 4000, c: 0 }, 'c', 5000, opts);
  assert.deepEqual(r, { a: 3000, b: 2000, c: 5000 });
  assert.equal(sum(r), 10000);
});

test('Rundung auf Schritte, Summe bleibt exakt', () => {
  const r = rebalance({ a: 3300, b: 3300, c: 3400, d: 0 }, 'd', 700, opts);
  assert.equal(sum(r), 10000);
  for (const v of Object.values(r)) assert.equal(v % 100, 0);
  assert.equal(r.d, 700);
});

test('Volles Budget auf ein Projekt setzt alle anderen auf 0', () => {
  const r = rebalance({ a: 5000, b: 5000, c: 0 }, 'c', 10000, opts);
  assert.deepEqual(r, { a: 0, b: 0, c: 10000 });
});

test('Zurückziehen mit Ausgangsstand stellt Verhältnisse wieder her', () => {
  const base = { a: 6000, b: 4000, c: 0 };
  rebalance(base, 'c', 8000, opts);
  assert.deepEqual(rebalance(base, 'c', 0, opts), base);
});

test('Ungültige Eingaben werden begrenzt', () => {
  assert.equal(rebalance({ a: 0 }, 'a', 99999, opts).a, 10000);
  assert.equal(rebalance({ a: 500 }, 'a', -5, opts).a, 0);
  assert.equal(rebalance({ a: 500 }, 'a', 'abc', opts).a, 0);
});

test('Zufallstest: Summe nie über Budget, keine negativen Werte', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  let state = Object.fromEntries(keys.map((k) => [k, 0]));
  for (let i = 0; i < 2000; i++) {
    const k = keys[i % 5];
    state = rebalance(state, k, Math.floor(Math.random() * 101) * 100, opts);
    assert.ok(sum(state) <= 10000);
    for (const v of Object.values(state)) assert.ok(v >= 0 && v % 100 === 0);
  }
});
