// Frontend „Ein Tag Chef sein.“ – Vanilla JS, ohne Build-Schritt.
import { rebalance } from './budget.js';
// Ablauf: start → budget → contact → verify → done. Kiosk-tauglich (Auto-Reset bei Inaktivität).

const $app = document.getElementById('app');
const STORAGE_KEY = 'chef-lead-state-v1';
const STEPS = ['start', 'budget', 'contact', 'verify', 'done'];

const ICONS = {
  briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4M12 12H3"/></svg>',
  award: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="5"/><path d="M8.5 13 7 21l5-3 5 3-1.5-8"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

let event = null;
let state = freshState();
let lastActivity = Date.now();

function freshState() {
  return {
    step: 'start',
    allocations: {},
    form: { companySlug: '', firstName: '', lastName: '', phone: '', email: '', consent: false },
    fieldErrors: {},
    error: '',
    lead: null, // { leadId, token, status, email, phone, verification }
    channels: {}, // { email|sms: { target, cooldownUntil, error, info } }
    busy: false,
  };
}

// ---------- Hilfsfunktionen ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const euro = (n) => `${new Intl.NumberFormat('de-DE').format(n)} €`;
const total = () => event.budget.totalEuro;
const allocated = () => event.projects.reduce((s, p) => s + (state.allocations[p.slug] || 0), 0);
const remaining = () => total() - allocated();
const budgetValid = () => {
  const sum = allocated();
  return sum > 0 && sum <= total() && (!event.budget.requireFullAllocation || sum === total());
};
const buttonStep = () => event.budget.stepEuro * (total() / event.budget.stepEuro >= 50 ? 5 : 1);
const requiredChannels = () => ['email', 'sms'].filter((c) => state.lead?.verification?.[c]?.required);

function save() {
  try {
    const { busy, ...rest } = state;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ eventSlug: event.slug, state: rest }));
  } catch { /* Speicher nicht verfügbar – App funktioniert trotzdem */ }
}
function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.eventSlug === event.slug && STEPS.includes(saved.state?.step)) {
      state = { ...freshState(), ...saved.state, busy: false };
    }
  } catch { /* ignorieren */ }
}

async function api(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.lead?.token) headers.Authorization = `Bearer ${state.lead.token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Keine Verbindung. Bitte versuche es erneut.'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || 'Da ist etwas schiefgelaufen.'), { status: res.status, ...data });
  }
  return data;
}

function go(step) {
  state.step = step;
  state.error = '';
  render();
  window.scrollTo({ top: 0 });
}

function reset() {
  state = freshState();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignorieren */ }
  render();
  window.scrollTo({ top: 0 });
}

// ---------- Views ----------
function header() {
  return `<div class="head"><p class="kicker">${esc(event.organizer)}</p><img class="logo" src="/assets/logo.png" alt=""></div>`;
}
function progress() {
  const idx = ['budget', 'contact', 'verify', 'done'].indexOf(state.step);
  return `<div class="progress" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<span class="${i <= idx ? 'on' : ''}"></span>`).join('')}</div>`;
}
function footer() {
  const site = event.website ? `<a href="${esc(event.website)}" target="_blank" rel="noopener">${esc(event.website.replace(/^https?:\/\//, ''))}</a>` : '';
  const privacy = event.privacyUrl ? `<a href="${esc(event.privacyUrl)}" target="_blank" rel="noopener">Datenschutz</a>` : '';
  return `<footer class="site"><span>${site}</span><span>${privacy}</span></footer>`;
}
const alert = () => (state.error ? `<div class="alert" role="alert">${esc(state.error)}</div>` : '');

function viewStart() {
  const features = [
    ['briefcase', `${euro(total())} verteilen`, 'Entscheide, welche echten Hilfsprojekte dein Budget bekommen – und welche nicht.'],
    ['clock', event.wheel.title, 'Knifflige Entscheidungen in Sekunden – wie im echten Führungsalltag.'],
    ['wheel', 'Am Glücksrad drehen', event.wheel.intro],
    ['award', 'Dein Diplom mitnehmen', 'Nachweis zum Mitnehmen: „Ich war Chefin/Chef bei Rotary.“'],
  ];
  return `${header()}
  <h1 class="display">${esc(event.title)}</h1>
  <p class="lead">${esc(event.intro)}</p>
  <p class="claim">${esc(event.claim)}</p>
  <div class="features">${features
    .map(([icon, title, text]) => `<div class="card feature"><span class="icon">${ICONS[icon]}</span><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div>`)
    .join('')}</div>
  <button class="btn btn-primary btn-cta" data-action="start">
    <span class="cta-text">Jetzt Chefin oder Chef sein</span>
    <span class="cta-meta">${event.booth ? esc(event.booth) : ICONS.arrow}</span>
  </button>
  ${footer()}`;
}

function budgetBar() {
  const rest = remaining();
  const pct = Math.min(100, (allocated() / total()) * 100);
  const cls = rest === 0 ? 'done' : rest < 0 ? 'over' : '';
  const label = rest === 0 ? 'Alles verteilt' : rest > 0 ? 'Noch zu verteilen' : 'Zu viel verteilt';
  return `<div class="row"><span>${label}</span><strong class="${cls}" data-ref="rest">${euro(Math.abs(rest))}</strong></div>
    <div class="meter"><i data-pct="${pct}"></i></div>`;
}

const AI_NOTICE = 'KI-generierte Inhalte';

// Plakat-Ansicht (Lightbox) auf Basis von <dialog>; liegt außerhalb von #app und überlebt render().
let $poster = null;
function showPoster(slug) {
  const p = event.projects.find((x) => x.slug === slug);
  if (!p?.imageUrl) return;
  if (!$poster) {
    $poster = document.createElement('dialog');
    $poster.className = 'poster-dialog';
    $poster.addEventListener('click', (e) => { if (e.target === $poster || e.target.closest('[data-close]')) $poster.close(); });
    document.body.append($poster);
  }
  $poster.setAttribute('aria-label', `Plakat ${p.title}`);
  $poster.innerHTML = `<button type="button" class="poster-close" data-close aria-label="Schließen">×</button>
    <figure><img src="${esc(p.imageUrl)}" alt="${esc(p.imageAlt || `Plakat ${p.title}`)}">
    ${p.aiGenerated ? `<figcaption>${AI_NOTICE}</figcaption>` : ''}</figure>`;
  $poster.showModal();
}

function viewBudget() {
  const step = buttonStep();
  const rest = remaining();
  return `${progress()}
  <p class="kicker">Schritt 1 · Budget</p>
  <h2>${esc(event.claim)}</h2>
  <p class="lead">${esc(event.budget.hint)}</p>
  <p class="claim">${esc(event.budget.question)}</p>
  <div class="budget-bar" data-ref="bar">${budgetBar()}</div>
  <div class="projects">${event.projects
    .map((p) => {
      const amount = state.allocations[p.slug] || 0;
      const poster = p.imageUrl
        ? `<figure class="poster"><button type="button" class="poster-btn" data-action="poster" data-slug="${esc(p.slug)}" aria-label="Plakat „${esc(p.title)}“ groß anzeigen">
            <img src="${esc(p.imageUrl)}" alt="${esc(p.imageAlt || `Plakat ${p.title}`)}" loading="lazy"></button>
            ${p.aiGenerated ? `<figcaption>${AI_NOTICE}</figcaption>` : ''}</figure>`
        : `<div class="poster poster-empty" aria-hidden="true">${ICONS.heart}</div>`;
      return `<div class="card project">
        <div class="project-head">${poster}<div class="project-info">
          ${p.label ? `<span class="tag">${esc(p.label)}</span>` : ''}
          <h3>${esc(p.title)}</h3>${p.description ? `<p>${esc(p.description)}</p>` : ''}
        </div></div>
        <div class="amount-row">
          <button class="step" data-action="dec" data-slug="${esc(p.slug)}" aria-label="${step} € weniger" ${amount <= 0 ? 'disabled' : ''}>−</button>
          <input type="range" min="0" max="${total()}" step="${event.budget.stepEuro}" value="${amount}" data-slug="${esc(p.slug)}" aria-label="Betrag für ${esc(p.title)}">
          <button class="step" data-action="inc" data-slug="${esc(p.slug)}" aria-label="${step} € mehr" ${amount >= total() ? 'disabled' : ''}>+</button>
          <span class="amount" data-amount="${esc(p.slug)}">${euro(amount)}</span>
        </div>
        ${rest > 0 ? `<button class="btn-link small" data-action="rest" data-slug="${esc(p.slug)}">Rest (${euro(rest)}) hierhin</button>` : ''}
      </div>`;
    })
    .join('')}</div>
  ${alert()}
  <div class="actions">
    <button class="btn btn-ghost" data-action="reset-budget">Zurücksetzen</button>
    <button class="btn btn-primary" data-action="budget-next" data-ref="next" ${budgetValid() ? '' : 'disabled'}>Weiter ${ICONS.arrow}</button>
  </div>`;
}

function field(name, label, input, { required = true, hint = '' } = {}) {
  const err = state.fieldErrors[name];
  return `<div class="field ${err ? 'invalid' : ''}">
    <label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>
    ${input}
    ${hint && !err ? `<span class="muted small">${esc(hint)}</span>` : ''}
    ${err ? `<p class="error" id="e-${name}">${esc(err)}</p>` : ''}
  </div>`;
}
const textInput = (name, type, attrs = '') =>
  `<input id="f-${name}" name="${name}" type="${type}" value="${esc(state.form[name])}" ${attrs} ${state.fieldErrors[name] ? `aria-invalid="true" aria-describedby="e-${name}"` : ''}>`;

function viewContact() {
  const f = state.form;
  const options = event.companies
    .map((c) => `<option value="${esc(c.slug)}" ${f.companySlug === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  const privacy = event.privacyUrl ? ` <a href="${esc(event.privacyUrl)}" target="_blank" rel="noopener">Datenschutzhinweise</a>` : '';
  return `${progress()}
  <p class="kicker">Schritt 2 · Glücksrad</p>
  <h2>${esc(event.wheel.title)}</h2>
  <p class="lead">${esc(event.wheel.intro)}</p>
  <form data-form="contact" novalidate>
    ${field('companySlug', event.wheel.question, `<select id="f-companySlug" name="companySlug" required><option value="">Bitte wählen …</option>${options}</select>`)}
    <div class="grid-2">
      ${field('firstName', 'Vorname', textInput('firstName', 'text', 'autocomplete="given-name" maxlength="100" required'))}
      ${field('lastName', 'Name', textInput('lastName', 'text', 'autocomplete="family-name" maxlength="100" required'))}
    </div>
    ${field('phone', event.verify.phone ? 'Handynummer' : 'Telefonnummer', textInput('phone', 'tel', 'autocomplete="tel" inputmode="tel" placeholder="0151 23456789" maxlength="40" required'), { hint: event.verify.phone ? 'Du bekommst einen Bestätigungscode per SMS.' : '' })}
    ${field('email', 'E-Mail', textInput('email', 'email', 'autocomplete="email" inputmode="email" placeholder="name@beispiel.de" maxlength="254" required'), { hint: 'Du bekommst einen Bestätigungscode per E-Mail.' })}
    <div class="field ${state.fieldErrors.consent ? 'invalid' : ''}">
      <label class="check"><input type="checkbox" name="consent" ${f.consent ? 'checked' : ''}><span>${esc(event.consentText)}${privacy}</span></label>
      ${state.fieldErrors.consent ? `<p class="error">${esc(state.fieldErrors.consent)}</p>` : ''}
    </div>
    ${state.fieldErrors.allocations ? `<div class="alert">${esc(state.fieldErrors.allocations)}</div>` : ''}
    ${alert()}
    <div class="actions">
      <button type="button" class="btn btn-ghost" data-action="back-budget">Zurück</button>
      <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Wird gesendet …' : `Weiter ${ICONS.arrow}`}</button>
    </div>
  </form>`;
}

function channelCard(channel) {
  const v = state.lead.verification[channel];
  const c = state.channels[channel] || {};
  const label = channel === 'email' ? 'E-Mail' : 'SMS';
  const target = c.target || (channel === 'email' ? state.lead.email : state.lead.phone);
  if (v.verified) {
    return `<div class="card"><h3>${label}</h3><span class="ok">${ICONS.check} ${esc(target)} bestätigt</span></div>`;
  }
  const wait = Math.max(0, Math.ceil(((c.cooldownUntil || 0) - Date.now()) / 1000));
  return `<div class="card" data-channel="${channel}">
    <h3>${label}-Code</h3>
    <span class="muted small">${c.sent ? 'Gesendet an' : 'Wird gesendet an'} <span class="target">${esc(target)}</span></span>
    <form class="code-row" data-form="code" data-channel="${channel}" novalidate>
      <input class="code-input ${c.error ? 'invalid' : ''}" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
        autocomplete="one-time-code" placeholder="••••••" aria-label="${label}-Code" value="${esc(c.code || '')}">
      <button class="btn btn-primary" type="submit" ${c.busy ? 'disabled' : ''}>Prüfen</button>
    </form>
    ${c.error ? `<p class="error" role="alert">${esc(c.error)}</p>` : ''}
    <div><button class="btn-link small" data-action="resend" data-channel="${channel}" data-cooldown="${channel}" ${wait > 0 || c.sending ? 'disabled' : ''}>
      ${c.sending ? 'Wird gesendet …' : wait > 0 ? `Code erneut senden (${wait} s)` : 'Code erneut senden'}</button></div>
  </div>`;
}

function viewVerify() {
  return `${progress()}
  <p class="kicker">Schritt 3 · Bestätigen</p>
  <h2>Fast geschafft, ${esc(state.form.firstName)}!</h2>
  <p class="lead">${requiredChannels().length > 1
    ? 'Wir haben dir Codes geschickt. Gib sie hier ein, um deine Kontaktdaten zu bestätigen.'
    : `Wir haben dir einen Code geschickt. Gib ihn hier ein, um deine ${requiredChannels()[0] === 'sms' ? 'Handynummer' : 'E-Mail-Adresse'} zu bestätigen.`}</p>
  <div class="verify">${requiredChannels().map(channelCard).join('')}</div>
  ${alert()}
  <div class="actions"><button class="btn btn-ghost" data-action="back-contact">Daten korrigieren</button></div>`;
}

function viewDone() {
  const company = event.companies.find((c) => c.slug === state.form.companySlug);
  const rows = event.projects
    .filter((p) => (state.allocations[p.slug] || 0) > 0)
    .map((p) => `<tr><td>${esc(p.title)}</td><td>${euro(state.allocations[p.slug])}</td></tr>`)
    .join('');
  return `${progress()}
  <p class="kicker">Geschafft</p>
  <h1 class="display">Danke, ${esc(state.form.firstName)}!</h1>
  <p class="lead">Du hast heute die Führung übernommen. Eine Bestätigung ist unterwegs an ${esc(state.lead?.email || state.form.email)}.</p>
  <div class="diploma">
    <p class="kicker">Diplom</p>
    <div class="name">${esc(`${state.form.firstName} ${state.form.lastName}`)}</div>
    <p>„Ich war Chefin/Chef bei Rotary.“</p>
  </div>
  <div class="card"><h3>Deine Budgetverteilung</h3><table class="summary">${rows}</table></div>
  ${company ? `<div class="card spaced"><h3>Dein Glücksrad-Ergebnis</h3><p class="muted">${esc(company.name)} – wir melden uns bei dir.</p></div>` : ''}
  <div class="actions"><button class="btn btn-primary" data-action="reset">Nächste Person ${ICONS.arrow}</button></div>`;
}

// CSP erlaubt keine Inline-Styles im Markup; dynamische Breiten werden per CSSOM gesetzt.
function applyDynamicStyles(root = $app) {
  for (const el of root.querySelectorAll('[data-pct]')) el.style.width = `${el.dataset.pct}%`;
}

function focusKey(el) {
  if (!el || !$app.contains(el) || !el.name) return null;
  const channel = el.closest('[data-channel]')?.dataset.channel;
  return channel ? `[data-channel="${channel}"] [name="${el.name}"]` : `[name="${el.name}"]`;
}

function render() {
  const views = { start: viewStart, budget: viewBudget, contact: viewContact, verify: viewVerify, done: viewDone };
  const key = focusKey(document.activeElement);
  $app.innerHTML = (views[state.step] || viewStart)();
  applyDynamicStyles();
  // Fokus nach Neuaufbau wiederherstellen (z. B. Codefeld während Countdown/Versand).
  const el = key && $app.querySelector(key);
  if (el && !el.disabled) {
    el.focus({ preventScroll: true });
    try { el.setSelectionRange?.(el.value.length, el.value.length); } catch { /* nicht jeder Input-Typ unterstützt Cursor */ }
  }
  save();
}

// ---------- Budget-Logik ----------
let dragBase = null; // Ausgangsstand während eines Regler-Zugs

function setAmount(slug, value, { partial = false } = {}) {
  if (partial) dragBase ||= { ...state.allocations };
  const base = partial ? dragBase : state.allocations;
  const complete = Object.fromEntries(event.projects.map((p) => [p.slug, base[p.slug] || 0]));
  state.allocations = rebalance(complete, slug, value, { total: total(), step: event.budget.stepEuro });
  state.error = '';
  if (!partial) return render();
  // Teil-Update beim Ziehen (kein Neuaufbau → Drag bleibt erhalten); alle Regler folgen live.
  for (const p of event.projects) {
    const amount = state.allocations[p.slug] || 0;
    const sel = CSS.escape(p.slug);
    const range = $app.querySelector(`input[type=range][data-slug="${sel}"]`);
    if (range && Number(range.value) !== amount) range.value = amount;
    $app.querySelector(`[data-amount="${sel}"]`).textContent = euro(amount);
    const dec = $app.querySelector(`[data-action="dec"][data-slug="${sel}"]`);
    if (dec) dec.disabled = amount <= 0;
  }
  const bar = $app.querySelector('[data-ref="bar"]');
  bar.innerHTML = budgetBar();
  applyDynamicStyles(bar);
  $app.querySelector('[data-ref="next"]').disabled = !budgetValid();
  save();
}

// ---------- Kontakt & Verifizierung ----------
function readContactForm(form) {
  const fd = new FormData(form);
  state.form = {
    companySlug: String(fd.get('companySlug') || ''),
    firstName: String(fd.get('firstName') || '').trim(),
    lastName: String(fd.get('lastName') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    consent: fd.get('consent') === 'on',
  };
}

function clientValidate() {
  const e = {};
  const f = state.form;
  if (!f.companySlug) e.companySlug = 'Bitte wähle den Betrieb vom Glücksrad.';
  if (!f.firstName) e.firstName = 'Pflichtfeld';
  if (!f.lastName) e.lastName = 'Pflichtfeld';
  if (!f.phone) e.phone = 'Bitte gib deine Telefonnummer an.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) e.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  if (!f.consent) e.consent = 'Bitte bestätige die Einwilligung.';
  return e;
}

async function submitContact(form) {
  readContactForm(form);
  state.fieldErrors = clientValidate();
  state.error = '';
  if (Object.keys(state.fieldErrors).length) return render();

  state.busy = true;
  render();
  const payload = { ...state.form, allocations: state.allocations };
  try {
    const pending = state.lead && state.lead.status === 'pending';
    const data = pending
      ? await api('PUT', `/api/leads/${encodeURIComponent(state.lead.leadId)}`, payload)
      : await api('POST', '/api/leads', payload);
    const prev = state.lead;
    state.lead = { ...data, token: data.token || prev?.token };
    // Bei geänderter Adresse Kanalstatus zurücksetzen.
    if (prev?.email !== data.email) delete state.channels.email;
    if (prev?.phone !== data.phone) delete state.channels.sms;
    state.busy = false;
    if (data.status === 'completed') return go('done');
    go('verify');
    for (const ch of requiredChannels()) {
      if (!state.lead.verification[ch].verified && !state.channels[ch]?.sent) sendCode(ch);
    }
  } catch (err) {
    state.busy = false;
    if (err.status === 404 || err.error === 'completed') state.lead = null; // Token ungültig → neu anlegen
    state.fieldErrors = err.fieldErrors || {};
    state.error = err.fieldErrors ? '' : err.message;
    render();
  }
}

async function sendCode(channel) {
  const c = (state.channels[channel] ||= {});
  c.sending = true;
  c.error = '';
  render();
  try {
    const data = await api('POST', `/api/leads/${encodeURIComponent(state.lead.leadId)}/verifications/${channel}/send`);
    Object.assign(c, { sent: true, target: data.target, cooldownUntil: Date.now() + data.cooldownSeconds * 1000 });
  } catch (err) {
    if (err.retryAfter) c.cooldownUntil = Date.now() + err.retryAfter * 1000;
    if (err.error === 'cooldown') c.sent = true;
    else c.error = err.message;
    if (err.error === 'already_verified') return refreshStatus();
  } finally {
    c.sending = false;
    if (state.step === 'verify') render();
  }
}

async function checkCode(channel, code) {
  const c = (state.channels[channel] ||= {});
  c.code = code;
  if (!/^\d{6}$/.test(code)) {
    c.error = 'Bitte gib den 6-stelligen Code ein.';
    return render();
  }
  c.busy = true;
  c.error = '';
  render();
  try {
    const data = await api('POST', `/api/leads/${encodeURIComponent(state.lead.leadId)}/verifications/${channel}/check`, { code });
    state.lead = { ...state.lead, ...data };
    c.code = '';
    if (data.status === 'completed') return go('done');
  } catch (err) {
    c.error = err.message;
    if (err.error === 'too_many_attempts' || err.error === 'expired') c.code = '';
  } finally {
    c.busy = false;
  }
  if (state.step === 'verify') {
    render();
    // Fokus auf das nächste offene Codefeld setzen.
    $app.querySelector('.code-input')?.focus();
  }
}

async function refreshStatus() {
  try {
    const data = await api('GET', `/api/leads/${encodeURIComponent(state.lead.leadId)}`);
    state.lead = { ...state.lead, ...data };
    if (data.status === 'completed') return go('done');
  } catch { /* ignorieren */ }
  render();
}

// ---------- Events ----------
$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, slug, channel } = el.dataset;
  const step = buttonStep();
  switch (action) {
    case 'start': return go('budget');
    case 'poster': return showPoster(slug);
    case 'inc': return setAmount(slug, (state.allocations[slug] || 0) + step);
    case 'dec': return setAmount(slug, (state.allocations[slug] || 0) - step);
    case 'rest': return setAmount(slug, (state.allocations[slug] || 0) + remaining());
    case 'reset-budget': state.allocations = {}; return render();
    case 'budget-next':
      if (!budgetValid()) { state.error = 'Bitte verteile das komplette Budget.'; return render(); }
      return go('contact');
    case 'back-budget': readContactForm($app.querySelector('form')); return go('budget');
    case 'back-contact': return go('contact');
    case 'resend': return sendCode(channel);
    case 'reset': return reset();
  }
});

$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('input[type=range]')) setAmount(t.dataset.slug, t.value, { partial: true });
  if (t.matches('.code-input')) {
    t.value = t.value.replace(/\D/g, '').slice(0, 6);
    const channel = t.closest('[data-channel]').dataset.channel;
    (state.channels[channel] ||= {}).code = t.value;
    if (t.value.length === 6) checkCode(channel, t.value); // Auto-Submit
  }
});

$app.addEventListener('change', (e) => {
  if (e.target.matches('input[type=range]')) {
    dragBase = null;
    render(); // Buttons/Rest-Links aktualisieren
  }
});

$app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.form === 'contact') submitContact(form);
  if (form.dataset.form === 'code') checkCode(form.dataset.channel, form.code.value.replace(/\D/g, ''));
});

// Countdown-Anzeige & Kiosk-Reset
['pointerdown', 'keydown', 'input', 'scroll'].forEach((t) => window.addEventListener(t, () => (lastActivity = Date.now()), { passive: true }));
setInterval(() => {
  if (!event) return;
  if (state.step === 'verify') {
    for (const btn of $app.querySelectorAll('[data-cooldown]')) {
      const c = state.channels[btn.dataset.cooldown] || {};
      const wait = Math.max(0, Math.ceil(((c.cooldownUntil || 0) - Date.now()) / 1000));
      if (!c.sending) {
        btn.disabled = wait > 0;
        btn.textContent = wait > 0 ? `Code erneut senden (${wait} s)` : 'Code erneut senden';
      }
    }
  }
  const limit = state.step === 'done' ? event.kiosk.doneResetSeconds : event.kiosk.idleResetSeconds;
  if (state.step !== 'start' && limit > 0 && Date.now() - lastActivity > limit * 1000) {
    lastActivity = Date.now();
    reset();
  }
}, 1000);

// ---------- Start ----------
(async function init() {
  try {
    event = await api('GET', '/api/event');
    document.title = event.title.replace(/\.$/, '');
    restore();
    if (state.step === 'verify' && !state.lead) state.step = 'contact';
    render();
  } catch (err) {
    $app.innerHTML = `<div class="alert">Die App konnte nicht geladen werden. ${esc(err.message)}</div>
      <button class="btn btn-primary" data-reload>Neu laden</button>`;
    $app.querySelector('[data-reload]').addEventListener('click', () => location.reload());
  }
})();
