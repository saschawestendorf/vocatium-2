// Virtuelles Glücksrad: reine Geometrie- und Markup-Funktionen (ohne DOM-Zugriff, testbar).
// Winkel in Grad, im Uhrzeigersinn ab 12 Uhr. Segment i belegt [i·seg, (i+1)·seg] im Rad-Koordinatensystem;
// der Zeiger steht fest oben (12 Uhr).

const TAU = Math.PI * 2;
const R = 146; // Radius der Segmente (viewBox −170…170)
const PALETTE = [
  { fill: '#e63946', text: '#ffffff' },
  { fill: '#ffb703', text: '#1b2a49' },
  { fill: '#2a9d8f', text: '#ffffff' },
  { fill: '#3a86ff', text: '#ffffff' },
  { fill: '#8338ec', text: '#ffffff' },
  { fill: '#fb5607', text: '#ffffff' },
  { fill: '#06d6a0', text: '#12324a' },
];

const rad = (deg) => (deg * Math.PI) / 180;
const pt = (r, deg) => [+(r * Math.sin(rad(deg))).toFixed(3), +(-r * Math.cos(rad(deg))).toFixed(3)];
const mod360 = (v) => ((v % 360) + 360) % 360;
const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Gesamtdrehung (positiv = im Uhrzeigersinn), nach der Segment `index` unter dem Zeiger liegt.
// `offset` (−0.5…0.5) verschiebt den Stopp innerhalb des Segments; `turns` sind volle Umdrehungen.
export function spinTarget(index, count, { turns = 6, offset = 0 } = {}) {
  const seg = 360 / count;
  const safe = Math.max(-0.25, Math.min(0.25, offset)); // nie knapp an der Segmentgrenze stoppen
  return 360 * Math.max(1, Math.floor(turns)) - (index + 0.5 + safe) * seg;
}

// Umkehrfunktion: Welches Segment liegt bei Drehung `rotation` unter dem Zeiger?
export function winnerAt(rotation, count) {
  return Math.floor(mod360(-rotation) / (360 / count)) % count;
}

export const normalizeRotation = mod360;

function segmentColors(count) {
  const colors = Array.from({ length: count }, (_, i) => PALETTE[i % PALETTE.length]);
  // Erstes und letztes Segment grenzen aneinander: gleiche Farbe vermeiden.
  if (count > 1 && colors[count - 1] === colors[0]) colors[count - 1] = PALETTE[(count + 2) % PALETTE.length];
  return colors;
}

function labelLines(text) {
  const t = String(text).trim();
  const words = t.split(/\s+/);
  if (t.length <= 12 || words.length < 2) return [t];
  let best = [t];
  let bestMax = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const max = Math.max(...lines.map((l) => l.length));
    if (max < bestMax) [best, bestMax] = [lines, max];
  }
  return best;
}

function segmentMarkup(company, i, count, color) {
  const seg = 360 / count;
  const [x0, y0] = pt(R, i * seg);
  const [x1, y1] = pt(R, (i + 1) * seg);
  const path = count === 1
    ? `M0 ${-R} A${R} ${R} 0 1 1 0 ${R} A${R} ${R} 0 1 1 0 ${-R}Z`
    : `M0 0 L${x0} ${y0} A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${x1} ${y1}Z`;
  const lines = labelLines(company.wheelLabel || company.name);
  const maxChars = Math.max(...lines.map((l) => l.length));
  const arc = ((TAU * 100) / count) * 0.42 / lines.length;
  const fs = Math.max(9, Math.min(19, arc, 104 / (maxChars * 0.6)));
  const mid = (i + 0.5) * seg;
  // Linke Radhälfte: Text umdrehen, damit er nicht auf dem Kopf steht (Lesefluss von außen nach innen).
  const flip = mid > 180;
  const tx = flip ? -(R - 16) : R - 16;
  const tspans = lines
    .map((l, k) => `<tspan x="${tx}" dy="${k === 0 ? `${(-(lines.length - 1) * 0.55).toFixed(2)}em` : '1.1em'}">${xml(l)}</tspan>`)
    .join('');
  return `<g><path d="${path}" fill="${color.fill}" stroke="#fff3c4" stroke-width="2" stroke-linejoin="round"/>
    <text transform="rotate(${(flip ? mid + 90 : mid - 90).toFixed(3)})" text-anchor="${flip ? 'start' : 'end'}" dominant-baseline="central" font-size="${fs.toFixed(1)}" font-weight="800" fill="${color.text}" font-family="Inter, system-ui, sans-serif">${tspans}</text></g>`;
}

// Liefert den Bühnen-Inhalt: drehbares Rad (.wheel-rotor) + feststehende Deko (Rand, Lichter, Nabe, Zeiger).
export function wheelMarkup(companies) {
  const n = companies.length;
  const colors = segmentColors(n);
  const segments = companies.map((c, i) => segmentMarkup(c, i, n, colors[i])).join('');
  const pegs = n > 1 ? companies.map((_, i) => { const [x, y] = pt(R, i * (360 / n)); return `<circle cx="${x}" cy="${y}" r="4.5" fill="url(#wh-gold)" stroke="#7a4b00" stroke-width="1"/>`; }).join('') : '';
  const bulbs = Array.from({ length: 24 }, (_, i) => {
    const [x, y] = pt(158, i * 15);
    return `<circle class="bulb b${i % 2}" cx="${x}" cy="${y}" r="5"/>`;
  }).join('');
  return `<div class="wheel-rotor" data-rot><svg viewBox="-170 -170 340 340" role="img" aria-label="Glücksrad mit ${n} Feldern: ${xml(companies.map((c) => c.name).join(', '))}">
      <defs><radialGradient id="wh-shade" r="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/></radialGradient>
      <linearGradient id="wh-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset=".5" stop-color="#e7a93c"/><stop offset="1" stop-color="#a86a05"/></linearGradient></defs>
      ${segments}${pegs}<circle r="${R}" fill="url(#wh-shade)" pointer-events="none"/></svg></div>
    <svg class="wheel-deco" viewBox="-170 -170 340 340" aria-hidden="true">
      <defs><linearGradient id="wh-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset=".45" stop-color="#e7a93c"/><stop offset="1" stop-color="#8a5200"/></linearGradient>
      <radialGradient id="wh-hub" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#fff6c8"/><stop offset=".55" stop-color="#e7a93c"/><stop offset="1" stop-color="#8a5200"/></radialGradient>
      <filter id="wh-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity=".5"/></filter></defs>
      <circle r="160" fill="none" stroke="url(#wh-rim)" stroke-width="16"/><circle r="149" fill="none" stroke="#0b1f40" stroke-width="6"/><circle r="${R + 1}" fill="none" stroke="url(#wh-rim)" stroke-width="3"/>
      ${bulbs}
      <circle r="30" fill="url(#wh-hub)" stroke="#7a4b00" stroke-width="2" filter="url(#wh-shadow)"/><circle r="20" fill="#0e2a52" stroke="#fff3c4" stroke-width="2"/>
      <path d="M0-11l3.2 7.2 7.8.7-5.9 5.2 1.8 7.7L0 5.4l-6.9 4.4 1.8-7.7-5.9-5.2 7.8-.7Z" fill="#ffd54a"/>
      <g filter="url(#wh-shadow)"><path d="M-15-176h30l-15 38Z" fill="#e63946" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><circle cy="-166" r="4" fill="#fff"/></g>
    </svg>`;
}
