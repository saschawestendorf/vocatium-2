// Budget-Logik (reine Funktionen, im Browser und in Tests nutzbar).

// Setzt `slug` auf `value`. Überschreitet die Summe das Budget, werden die übrigen Projekte
// proportional zu ihren Beträgen in `base` gekürzt (Rundung auf `step`, Summe bleibt exakt = total).
// `base` ist der Stand zu Beginn der Interaktion – so bleiben die Verhältnisse beim Ziehen stabil
// und die anderen Regler gleiten wieder hoch, wenn zurückgezogen wird.
export function rebalance(base, slug, value, { total, step }) {
  let v = Math.round(Number(value) / step) * step;
  v = Math.max(0, Math.min(Number.isFinite(v) ? v : 0, total));
  const result = { ...base, [slug]: v };
  const others = Object.keys(base).filter((k) => k !== slug && (base[k] || 0) > 0);
  const othersSum = others.reduce((s, k) => s + base[k], 0);
  const available = total - v;
  if (othersSum <= available) return result;

  const units = available / step;
  const parts = others.map((k) => {
    const exact = (base[k] * available) / othersSum / step;
    return { k, units: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = units - parts.reduce((s, p) => s + p.units, 0);
  // Restliche Schritte nach größtem Rundungsrest vergeben (bei Gleichstand: größerer Ausgangsbetrag).
  [...parts].sort((a, b) => b.frac - a.frac || base[b.k] - base[a.k]).forEach((p) => {
    if (leftover > 0) { p.units += 1; leftover -= 1; }
  });
  for (const p of parts) result[p.k] = p.units * step;
  return result;
}
