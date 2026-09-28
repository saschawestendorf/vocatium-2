-- Grundschema: Events, Projekte, Betriebe, Leads, Budgetverteilung, Verifizierungen.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE events (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  budget_euro INTEGER NOT NULL CHECK (budget_euro > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  image_url   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (event_id, slug)
);

CREATE TABLE companies (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (event_id, slug)
);

CREATE TABLE leads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           INTEGER NOT NULL REFERENCES events(id),
  access_token_hash  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed')),
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone_e164         TEXT NOT NULL,
  company_id         INTEGER NOT NULL REFERENCES companies(id),
  email_verified_at  TIMESTAMPTZ,
  phone_verified_at  TIMESTAMPTZ,
  consent_text       TEXT NOT NULL,
  consent_at         TIMESTAMPTZ NOT NULL,
  confirmation_sent_at TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_event_status_idx ON leads (event_id, status, created_at);
CREATE INDEX leads_email_idx ON leads (lower(email));
CREATE INDEX leads_phone_idx ON leads (phone_e164);

CREATE TABLE lead_allocations (
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  amount_euro INTEGER NOT NULL CHECK (amount_euro >= 0),
  PRIMARY KEY (lead_id, project_id)
);

CREATE TABLE verifications (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  target      TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verifications_lead_channel_idx ON verifications (lead_id, channel, created_at DESC);
CREATE INDEX verifications_target_idx ON verifications (channel, target, created_at DESC);
