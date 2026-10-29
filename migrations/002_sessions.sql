-- Sitzungen: anonymer Verlauf jedes Durchlaufs (auch abgebrochene). Keine personenbezogenen Daten –
-- Kontaktdaten werden erst mit Einwilligung als Lead gespeichert.
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     INTEGER NOT NULL REFERENCES events(id),
  token_hash   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'aborted', 'completed')),
  last_step    TEXT NOT NULL DEFAULT 'start',
  allocations  JSONB NOT NULL DEFAULT '{}'::jsonb, -- { projekt-slug: betrag_euro }
  company_id   INTEGER REFERENCES companies(id),
  lead_id      UUID REFERENCES leads(id) ON DELETE SET NULL,
  abort_reason TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);
CREATE INDEX sessions_event_status_idx ON sessions (event_id, status, created_at);
