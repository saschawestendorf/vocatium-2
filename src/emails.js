// E-Mail-Vorlagen (HTML + Text). Inline-Styles für maximale Client-Kompatibilität.
const NAVY = '#0e2a52';
const CARD = '#16335f';
const GOLD = '#e7a93c';
const CREAM = '#f8f6ee';

export const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const formatEuro = (n) => `${new Intl.NumberFormat('de-DE').format(n)} €`;

function layout(event, inner) {
  const footer = [event.organizer, event.website].filter(Boolean).map(escapeHtml).join(' · ');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:${NAVY};font-family:Helvetica,Arial,sans-serif;color:${CREAM}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY}">
<tr><td style="height:6px;background:${GOLD}"></td></tr>
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:${GOLD};font-weight:bold;padding-bottom:12px">${escapeHtml(event.organizer)}</td></tr>
${inner}
<tr><td style="padding-top:32px;font-size:12px;color:#9fb0c8">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function verificationEmail(event, { firstName, code, ttlMinutes }) {
  const subject = `Dein Bestätigungscode: ${code}`;
  const html = layout(
    event,
    `<tr><td style="font-family:Georgia,serif;font-size:32px;font-weight:bold;padding-bottom:16px">Hallo ${escapeHtml(firstName)}!</td></tr>
<tr><td style="font-size:16px;line-height:1.5;padding-bottom:20px">Gib diesen Code am Stand ein, um deine E-Mail-Adresse zu bestätigen:</td></tr>
<tr><td style="background:${CARD};border-radius:12px;padding:20px;text-align:center;font-size:36px;letter-spacing:10px;font-weight:bold;color:${GOLD}">${escapeHtml(code)}</td></tr>
<tr><td style="font-size:13px;color:#9fb0c8;padding-top:16px">Der Code ist ${ttlMinutes} Minuten gültig. Falls du das nicht warst, ignoriere diese E-Mail.</td></tr>`,
  );
  const text = `Hallo ${firstName}!\n\nDein Bestätigungscode: ${code}\nGültig für ${ttlMinutes} Minuten.\n\n${event.organizer}`;
  return { subject, html, text };
}

export function confirmationEmail(event, { firstName, lastName, companyName, allocations }) {
  const subject = `${event.title} – deine Teilnahme ist bestätigt`;
  const rows = allocations
    .map(
      (a) => `<tr><td style="padding:8px 0;border-bottom:1px solid #2a4570">${escapeHtml(a.title)}</td>
<td style="padding:8px 0;border-bottom:1px solid #2a4570;text-align:right;white-space:nowrap;font-weight:bold">${formatEuro(a.amount)}</td></tr>`,
    )
    .join('');
  const html = layout(
    event,
    `<tr><td style="font-family:Georgia,serif;font-size:32px;font-weight:bold;padding-bottom:16px">Danke, ${escapeHtml(firstName)}!</td></tr>
<tr><td style="font-size:16px;line-height:1.5;padding-bottom:24px">Du hast heute die Führung übernommen. Hier ist deine Entscheidung im Überblick:</td></tr>
<tr><td style="background:${CARD};border-radius:12px;padding:20px">
<div style="font-size:14px;color:${GOLD};font-weight:bold;padding-bottom:8px">Deine Budgetverteilung</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;color:${CREAM}">${rows}</table>
</td></tr>
<tr><td style="height:16px"></td></tr>
<tr><td style="background:${CARD};border-radius:12px;padding:20px;font-size:15px;line-height:1.5">
<div style="font-size:14px;color:${GOLD};font-weight:bold;padding-bottom:8px">Dein Glücksrad-Ergebnis</div>
${escapeHtml(companyName)} – wir melden uns bei dir zu deinem Tag als Chefin oder Chef.</td></tr>
<tr><td style="height:24px"></td></tr>
<tr><td style="border:2px solid ${GOLD};border-radius:12px;padding:24px;text-align:center">
<div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:${GOLD}">Diplom</div>
<div style="font-family:Georgia,serif;font-size:26px;font-weight:bold;padding:8px 0">${escapeHtml(`${firstName} ${lastName}`)}</div>
<div style="font-size:15px">„Ich war Chefin/Chef bei Rotary.“</div></td></tr>`,
  );
  const text = [
    `Danke, ${firstName}!`,
    '',
    'Deine Budgetverteilung:',
    ...allocations.map((a) => `- ${a.title}: ${formatEuro(a.amount)}`),
    '',
    `Dein Glücksrad-Ergebnis: ${companyName}`,
    '',
    `Diplom: ${firstName} ${lastName} – „Ich war Chefin/Chef bei Rotary.“`,
    '',
    event.organizer,
  ].join('\n');
  return { subject, html, text };
}
