import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spinTarget, winnerAt, wheelMarkup } from '../public/wheel.js';

test('spinTarget landet für jedes Segment, jede Verschiebung und jede Feldzahl unter dem Zeiger', () => {
  for (const n of [1, 2, 3, 5, 7, 8, 20]) {
    for (let i = 0; i < n; i++) {
      for (const offset of [-0.5, -0.3, 0, 0.3, 0.5, 9]) {
        for (const turns of [1, 6, 8]) {
          assert.equal(winnerAt(spinTarget(i, n, { turns, offset }), n), i, `n=${n} i=${i} offset=${offset}`);
        }
      }
    }
  }
});

test('spinTarget dreht mindestens eine volle Runde im Uhrzeigersinn', () => {
  assert.ok(spinTarget(0, 5, { turns: 0 }) > 0);
  assert.ok(spinTarget(4, 5, { turns: 6 }) > 360 * 5);
});

test('wheelMarkup maskiert Namen und enthält alle Felder', () => {
  const html = wheelMarkup([
    { slug: 'a', name: 'Chef <b>A</b>', wheelLabel: '' },
    { slug: 'b', name: 'Apotheker', wheelLabel: 'Apo & Co' },
    { slug: 'c', name: 'Chef des Tierparks', wheelLabel: '' },
  ]);
  assert.ok(!html.includes('<b>A</b>'));
  assert.ok(html.includes('Apo &amp; Co'));
  assert.equal((html.match(/<text /g) || []).length, 3);
});
