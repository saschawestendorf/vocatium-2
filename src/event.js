// Event-Konfiguration (config/event.json): Validierung und Synchronisation in die DB.
// Die JSON-Datei ist die Quelle der Wahrheit; entfernte Projekte/Betriebe werden
// deaktiviert (nicht gelöscht), damit bestehende Leads referenziell intakt bleiben.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withTransaction } from './db.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Slug: nur a-z, 0-9 und Bindestrich');
const text = z.string().trim().min(1);
const optionalUrl = z.string().trim().min(1).nullable().optional().transform((v) => v || null);

const eventSchema = z
  .object({
    slug,
    organizer: text,
    title: text,
    intro: z.string().default(''),
    claim: z.string().default(''),
    booth: z.string().default(''),
    website: optionalUrl,
    privacyUrl: optionalUrl,
    budget: z.object({
      totalEuro: z.number().int().positive().max(10_000_000),
      stepEuro: z.number().int().positive().default(100),
      requireFullAllocation: z.boolean().default(true),
      question: text,
      hint: z.string().default(''),
    }),
    projects: z
      .array(
        z.object({
          slug,
          title: text,
          label: z.string().trim().default(''), // kleines Kategorie-Label in der Übersicht
          description: z.string().default(''),
          imageUrl: optionalUrl, // Plakat
          imageAlt: z.string().default(''),
          aiGenerated: z.boolean().default(false), // blendet „KI-generierte Inhalte“ unter dem Bild ein
        }),
      )
      .min(1)
      .max(10),
    wheel: z.object({ title: text, intro: z.string().default(''), question: text }),
    companies: z.array(z.object({ slug, name: text })).min(1).max(20),
    consentText: text,
    kiosk: z
      .object({
        idleResetSeconds: z.number().int().min(0).default(180),
        doneResetSeconds: z.number().int().min(0).default(90),
      })
      .default({}),
  })
  .superRefine((ev, ctx) => {
    const dupes = (list, key) => {
      const seen = new Set();
      for (const item of list) {
        if (seen.has(item.slug)) ctx.addIssue({ code: 'custom', path: [key], message: `Doppelter Slug: ${item.slug}` });
        seen.add(item.slug);
      }
    };
    dupes(ev.projects, 'projects');
    dupes(ev.companies, 'companies');
    if (ev.budget.totalEuro % ev.budget.stepEuro !== 0) {
      ctx.addIssue({ code: 'custom', path: ['budget', 'stepEuro'], message: 'totalEuro muss durch stepEuro teilbar sein' });
    }
  });

export function parseEventConfig(raw) {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ungültige Event-Konfiguration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export async function loadEventConfig(filePath) {
  const abs = path.resolve(filePath);
  let raw;
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Event-Konfiguration ${abs} nicht lesbar: ${err.message}`);
  }
  return parseEventConfig(raw);
}

// Upsert von Event, Projekten und Betrieben. Liefert die DB-IDs zurück.
export async function syncEvent(pool, ev) {
  return withTransaction(pool, async (db) => {
    const { rows: [event] } = await db.query(
      `INSERT INTO events (slug, title, budget_euro) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, budget_euro = EXCLUDED.budget_euro, updated_at = now()
       RETURNING id`,
      [ev.slug, ev.title, ev.budget.totalEuro],
    );

    const projectIds = new Map();
    for (const [i, p] of ev.projects.entries()) {
      const { rows: [row] } = await db.query(
        `INSERT INTO projects (event_id, slug, title, description, image_url, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (event_id, slug) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
           image_url = EXCLUDED.image_url, sort_order = EXCLUDED.sort_order, active = TRUE
         RETURNING id`,
        [event.id, p.slug, p.title, p.description, p.imageUrl, i],
      );
      projectIds.set(p.slug, row.id);
    }
    await db.query('UPDATE projects SET active = FALSE WHERE event_id = $1 AND NOT (slug = ANY($2))', [
      event.id,
      ev.projects.map((p) => p.slug),
    ]);

    const companyIds = new Map();
    for (const [i, c] of ev.companies.entries()) {
      const { rows: [row] } = await db.query(
        `INSERT INTO companies (event_id, slug, name, sort_order, active) VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (event_id, slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, active = TRUE
         RETURNING id`,
        [event.id, c.slug, c.name, i],
      );
      companyIds.set(c.slug, row.id);
    }
    await db.query('UPDATE companies SET active = FALSE WHERE event_id = $1 AND NOT (slug = ANY($2))', [
      event.id,
      ev.companies.map((c) => c.slug),
    ]);

    return { eventId: event.id, projectIds, companyIds };
  });
}

// Öffentliche Sicht auf das Event für das Frontend (keine internen IDs).
export function publicEvent(ev, { verify }) {
  return {
    slug: ev.slug,
    organizer: ev.organizer,
    title: ev.title,
    intro: ev.intro,
    claim: ev.claim,
    booth: ev.booth,
    website: ev.website,
    privacyUrl: ev.privacyUrl,
    budget: ev.budget,
    projects: ev.projects,
    wheel: ev.wheel,
    companies: ev.companies,
    consentText: ev.consentText,
    kiosk: ev.kiosk,
    verify: { email: verify.email, phone: verify.phone },
  };
}
