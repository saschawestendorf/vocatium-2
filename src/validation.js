// Validierung & Normalisierung der Nutzereingaben. Reine Funktionen, ohne DB-Zugriff.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

// Entfernt Steuerzeichen und normalisiert Leerraum.
export function cleanText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(value) {
  const email = cleanText(value).replace(/\s/g, '').toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// Liefert { e164, country } oder { error }.
// Mit SMS-Verifizierung: requireMobile + allowedCountries (Kostenschutz). Ohne: jede gültige Nummer.
export function normalizePhone(value, { defaultCountry = 'DE', allowedCountries = [], requireMobile = false } = {}) {
  const noun = requireMobile ? 'Handynummer' : 'Telefonnummer';
  const raw = cleanText(value);
  if (!raw) return { error: `Bitte gib deine ${noun} an.` };
  // "0049..." -> "+49..."
  const input = raw.replace(/^00/, '+');
  const phone = parsePhoneNumberFromString(input, defaultCountry);
  if (!phone || !phone.isValid()) return { error: `Die ${noun} ist ungültig.` };
  if (allowedCountries.length && !allowedCountries.includes(phone.country)) {
    return { error: `${noun}n aus diesem Land werden leider nicht unterstützt.` };
  }
  const type = phone.getType();
  if (requireMobile && type && !['MOBILE', 'FIXED_LINE_OR_MOBILE'].includes(type)) {
    return { error: 'Bitte gib eine Handynummer an (wir senden dir einen SMS-Code).' };
  }
  return { e164: phone.number, country: phone.country };
}

// Prüft die Budgetverteilung gegen die Event-Regeln.
// allocations: { [projectSlug]: amountEuro }
export function validateAllocations(allocations, event) {
  const { totalEuro, stepEuro, requireFullAllocation } = event.budget;
  const known = new Set(event.projects.map((p) => p.slug));
  const errors = [];
  const result = {};

  if (!allocations || typeof allocations !== 'object' || Array.isArray(allocations)) {
    return { errors: ['Budgetverteilung fehlt.'] };
  }
  for (const key of Object.keys(allocations)) {
    if (!known.has(key)) errors.push(`Unbekanntes Projekt: ${key}`);
  }
  let sum = 0;
  for (const slug of known) {
    const raw = allocations[slug] ?? 0;
    const amount = typeof raw === 'string' ? Number(raw.replace(/\./g, '')) : raw;
    if (!Number.isInteger(amount) || amount < 0 || amount > totalEuro) {
      errors.push(`Ungültiger Betrag für ${slug}.`);
      continue;
    }
    if (amount % stepEuro !== 0) errors.push(`Beträge nur in ${stepEuro}-€-Schritten.`);
    result[slug] = amount;
    sum += amount;
  }
  if (sum > totalEuro) errors.push(`Du hast ${sum - totalEuro} € zu viel verteilt.`);
  if (requireFullAllocation && sum < totalEuro) errors.push(`Es sind noch ${totalEuro - sum} € übrig.`);
  if (sum === 0) errors.push('Bitte verteile dein Budget.');
  return errors.length ? { errors: [...new Set(errors)] } : { allocations: result, sum };
}

const name = z
  .string({ required_error: 'Pflichtfeld' })
  .transform(cleanText)
  .pipe(z.string().min(1, 'Pflichtfeld').max(100, 'Zu lang'));

// Schema der Lead-Einreichung; Telefon/E-Mail/Budget werden separat fachlich geprüft.
export const leadInputSchema = z.object({
  allocations: z.record(z.union([z.number(), z.string()])),
  companySlug: z.string().min(1, 'Bitte wähle den Betrieb vom Glücksrad.'),
  firstName: name,
  lastName: name,
  phone: z.string().max(40),
  email: z.string().max(300),
  consent: z.literal(true, { errorMap: () => ({ message: 'Bitte bestätige die Einwilligung.' }) }),
});

// Vollständige fachliche Validierung. Liefert { data } oder { fieldErrors }.
// phoneOptions: siehe normalizePhone.
export function validateLead(input, event, phoneOptions = {}) {
  const fieldErrors = {};
  const parsed = leadInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
  }
  const body = input && typeof input === 'object' ? input : {};

  const alloc = validateAllocations(body.allocations, event);
  if (alloc.errors) fieldErrors.allocations = alloc.errors.join(' ');

  if (body.companySlug && !event.companies.some((c) => c.slug === body.companySlug)) {
    fieldErrors.companySlug = 'Bitte wähle den Betrieb vom Glücksrad.';
  }

  const email = normalizeEmail(body.email);
  if (!email) fieldErrors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';

  const phone = normalizePhone(body.phone, phoneOptions);
  if (phone.error) fieldErrors.phone = phone.error;

  if (Object.keys(fieldErrors).length) return { fieldErrors };
  return {
    data: {
      allocations: alloc.allocations,
      companySlug: body.companySlug,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email,
      phoneE164: phone.e164,
    },
  };
}
