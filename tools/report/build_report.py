#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lead-Report (Excel + PDF) für die Messe-App „Ein Tag Chef sein“.

Datenquelle (genau eine):
  --dump-dir DIR                      JSON-Dump je Tabelle (tools/report/dump_db.mjs <ordner>)
  --dump-file FILE                    kombinierter JSON-Dump (tools/report/dump_db.mjs -)
  --leads-csv F --sessions-csv F      Admin-Exporte der App (/admin/export.csv?status=all, /admin/sessions.csv)

Beispiele:
  python3 tools/report/build_report.py --dump-dir dump --out-dir report
  python3 tools/report/build_report.py --leads-csv leads.csv --sessions-csv sitzungen.csv --tester stefan

Test-Markierung: Jeder Lead bekommt einen Score aus mehreren Indizien (Zeitpunkt außerhalb der Messetage,
Dummy-Namen/-E-Mails/-Telefonnummern, bekannte Tester, Mehrfachverwendung, abweichendes Gerät).
Score >= 3 → „Test“, 1–2 → „Prüfen“, 0 → „Lead“. Alles bleibt sichtbar – nichts wird gelöscht.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Berlin')
STEPS = ['start', 'budget', 'spin', 'contact', 'verify', 'done']
STEP_LABELS = {'start': 'Start', 'budget': 'Budget', 'spin': 'Glücksrad', 'contact': 'Kontaktdaten',
               'verify': 'Verifizierung', 'done': 'Fertig'}
STATUS_LABELS = {'open': 'offen', 'aborted': 'abgebrochen', 'completed': 'abgeschlossen', 'pending': 'unvollständig'}
ABORT_LABELS = {'idle': 'Inaktivität', 'reset': 'Kiosk-Reset', 'other': 'sonstiges', '': ''}
KLASS_LEAD, KLASS_CHECK, KLASS_TEST = 'Lead', 'Prüfen', 'Test'
TEST_THRESHOLD, CHECK_THRESHOLD = 3, 1
WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

DUMMY_TOKENS = {
    'test', 'tester', 'testing', 'demo', 'muster', 'mustermann', 'musterfrau', 'asdf', 'qwer', 'qwertz', 'qwerty', 'yxcv',
    'xyz', 'abc', 'aaa', 'bbb', 'ccc', 'foo', 'bar', 'baz', 'dummy', 'probe', 'beispiel', 'example', 'fake', 'bla',
    'blabla', 'lorem', 'ipsum', 'nix', 'egal', 'keine', 'keiner', 'niemand', 'none', 'null', 'hallo', 'hello', 'admin',
    'root', 'user', 'name', 'vorname', 'nachname', 'max', 'erika',
}
# „max“ und „erika“ zählen nur in Kombination mit „mustermann“ (siehe looks_dummy_name).
STANDALONE_SAFE = {'max', 'erika', 'name', 'user'}
KEYBOARD_RUNS = ['asdf', 'qwer', 'qwertz', 'qwerty', 'yxcv', 'sdfg', 'dfgh', 'jklö', 'hjkl', '1234', 'abcd', 'xxx', 'zzz', 'yyy']
DUMMY_DOMAINS = {'example.com', 'example.de', 'example.org', 'example.net', 'test.de', 'test.com', 'test.org', 'test.test',
                 'mail.test', 'localhost', 'invalid', 'asdf.de', 'asdf.com', 'xyz.de', 'abc.de', 'aaa.de', 'muster.de',
                 'mustermann.de', 'demo.de', 'dummy.de', 'fake.de', 'nix.de'}


# ------------------------------------------------------------------------------------------------
# Modell
# ------------------------------------------------------------------------------------------------
@dataclass
class Project:
    id: int | None
    slug: str
    title: str
    label: str = ''
    description: str = ''
    active: bool = True
    sort_order: int = 0


@dataclass
class Company:
    id: int | None
    slug: str
    name: str
    active: bool = True
    sort_order: int = 0


@dataclass
class Lead:
    id: str
    status: str
    first_name: str
    last_name: str
    email: str
    phone: str
    company: str | None
    allocations: dict
    created_at: datetime | None
    completed_at: datetime | None = None
    consent_at: datetime | None = None
    consent_text: str | None = None
    phone_verified_at: datetime | None = None
    email_verified_at: datetime | None = None
    user_agent: str | None = None
    updated_at: datetime | None = None
    klass: str = KLASS_LEAD
    score: int = 0
    reasons: list = field(default_factory=list)

    @property
    def name(self):
        return f'{self.first_name} {self.last_name}'.strip()

    @property
    def total(self):
        return sum(self.allocations.values())


@dataclass
class Session:
    id: str
    status: str
    last_step: str
    abort_reason: str | None
    created_at: datetime | None
    updated_at: datetime | None
    ended_at: datetime | None
    company: str | None
    allocations: dict
    lead_id: str | None
    user_agent: str | None = None
    klass: str = KLASS_LEAD
    score: int = 0
    reasons: list = field(default_factory=list)

    @property
    def total(self):
        return sum(self.allocations.values())

    @property
    def duration_min(self):
        end = self.ended_at or self.updated_at
        if self.created_at and end and end >= self.created_at:
            return round((end - self.created_at).total_seconds() / 60, 1)
        return None


@dataclass
class Data:
    source: str
    event: dict
    projects: list
    companies: list
    leads: list
    sessions: list
    verifications: list
    meta: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)


# ------------------------------------------------------------------------------------------------
# Hilfsfunktionen
# ------------------------------------------------------------------------------------------------
def parse_ts(v):
    """ISO 8601 (mit/ohne Zone) oder deutsch „dd.mm.yyyy HH:MM[:SS]“ → aware datetime (Europe/Berlin)."""
    if v is None or v == '':
        return None
    if isinstance(v, datetime):
        d = v
    else:
        s = str(v).strip().lstrip("'")
        if not s:
            return None
        m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$', s)
        if m:
            dd, mm, yy, hh, mi, ss = m.groups()
            try:
                d = datetime(int(yy), int(mm), int(dd), int(hh or 0), int(mi or 0), int(ss or 0), tzinfo=TZ)
            except ValueError:
                return None
        else:
            try:
                d = datetime.fromisoformat(s.replace('Z', '+00:00'))
            except ValueError:
                return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(TZ)


def parse_date(s):
    s = s.strip()
    for fmt in ('%Y-%m-%d', '%d.%m.%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(f'Ungültiges Datum: {s} (erwartet YYYY-MM-DD oder DD.MM.YYYY)')


def to_int(v, default=0):
    if v is None:
        return default
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().lstrip("'").replace('€', '').replace(' ', '')
    if not s:
        return default
    if re.fullmatch(r'-?\d+', s):
        return int(s)
    try:
        return int(round(float(s.replace('.', '').replace(',', '.'))))
    except ValueError:
        return default


def to_bool(v, default=True):
    if isinstance(v, bool):
        return v
    if v is None or v == '':
        return default
    return str(v).strip().lower() in ('1', 'true', 't', 'ja', 'yes', 'y')


def slugify(s):
    s = (s or '').lower()
    s = s.replace('ä', 'ae').replace('ö', 'oe').replace('ü', 'ue').replace('ß', 'ss')
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s or 'unbekannt'


def fmt_dt(d, seconds=True):
    if not d:
        return ''
    return d.strftime('%d.%m.%Y %H:%M:%S' if seconds else '%d.%m.%Y %H:%M')


def fmt_date(d):
    return d.strftime('%d.%m.%Y') if d else ''


def fmt_eur(n):
    try:
        return f'{int(round(n)):,}'.replace(',', '.') + ' €'
    except (TypeError, ValueError):
        return ''


def fmt_pct(x):
    return '' if x is None else f'{x * 100:.1f} %'.replace('.', ',')


def naive(d):
    """Für Excel: lokale Zeit ohne Zone."""
    return d.astimezone(TZ).replace(tzinfo=None) if d else None


def device_label(ua):
    if not ua:
        return ''
    os_ = ('iPad' if 'iPad' in ua else 'iPhone' if 'iPhone' in ua else 'Android' if 'Android' in ua
           else 'Windows' if 'Windows' in ua else 'Mac' if 'Macintosh' in ua else 'Linux' if 'Linux' in ua else 'unbekannt')
    if 'Edg/' in ua or 'Edge/' in ua:
        browser = 'Edge'
    elif 'OPR/' in ua:
        browser = 'Opera'
    elif 'Firefox/' in ua:
        browser = 'Firefox'
    elif 'Chrome/' in ua or 'CriOS/' in ua:
        browser = 'Chrome'
    elif 'Safari/' in ua:
        browser = 'Safari'
    else:
        browser = 'Browser'
    m = re.search(r'(?:Version|Chrome|CriOS|Firefox|Edg|OPR)/(\d+)', ua)
    return f'{os_} · {browser}{" " + m.group(1) if m else ""}'


def tokens(s):
    return [t for t in re.split(r'[^a-zäöüß]+', (s or '').lower()) if t]


def phone_digits(phone):
    s = re.sub(r'\D', '', phone or '')
    if s.startswith('00'):
        s = s[2:]
    return s


def looks_dummy_name(first, last):
    f, l = (first or '').strip().lower(), (last or '').strip().lower()
    full = f'{f} {l}'.strip()
    if not f or not l:
        return True
    if f == l:
        return True
    if len(f) < 2 or len(l) < 2:
        return True
    if re.search(r'\d', full):
        return True
    for part in (f, l):
        if re.fullmatch(r'(.)\1+', part):
            return True
        if any(k in part for k in KEYBOARD_RUNS):
            return True
    toks = set(tokens(full))
    if toks & (DUMMY_TOKENS - STANDALONE_SAFE):
        return True
    if {'max', 'erika'} & toks and 'mustermann' in toks:
        return True
    return False


def looks_dummy_email(email):
    e = (email or '').strip().lower()
    if not e or '@' not in e:
        return True
    local, _, domain = e.rpartition('@')
    if domain in DUMMY_DOMAINS or domain.endswith('.test') or domain.endswith('.invalid') or domain.endswith('.local'):
        return True
    if '.' not in domain:
        return True
    if len(local) < 2 or re.fullmatch(r'(.)\1+', local):
        return True
    if any(k in local for k in KEYBOARD_RUNS):
        return True
    if set(tokens(local)) & (DUMMY_TOKENS - STANDALONE_SAFE):
        return True
    if set(tokens(domain.split('.')[0])) & (DUMMY_TOKENS - STANDALONE_SAFE):
        return True
    return False


def looks_dummy_phone(phone):
    d = phone_digits(phone)
    if not d:
        return True
    national = d[2:] if d.startswith('49') else d
    if len(d) < 8:
        return True
    if re.search(r'(\d)\1{5,}', national):
        return True
    for run in ('1234567', '7654321', '0123456', '2345678', '3456789', '4567890'):
        if run in national:
            return True
    if national.lstrip('0') == '':
        return True
    return False


# ------------------------------------------------------------------------------------------------
# Laden: JSON-Dump
# ------------------------------------------------------------------------------------------------
def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_dump(dump_dir=None, dump_file=None, event_slug=None):
    if dump_file:
        raw = read_json(dump_file)
        source = f'JSON-Dump {Path(dump_file).name}'
    else:
        raw = {}
        for name in ('events', 'projects', 'companies', 'leads', 'lead_allocations', 'sessions', 'verifications', 'meta'):
            p = Path(dump_dir) / f'{name}.json'
            raw[name] = read_json(p) if p.exists() else ({} if name == 'meta' else [])
        source = f'JSON-Dump {Path(dump_dir).name}/'
    if not isinstance(raw, dict):
        raise SystemExit('Dump hat ein unerwartetes Format (Objekt mit Tabellen erwartet).')
    warnings = []
    events = raw.get('events') or []
    leads_raw = raw.get('leads') or []
    if event_slug:
        event = next((e for e in events if e.get('slug') == event_slug), None)
        if not event:
            raise SystemExit(f'Event „{event_slug}“ nicht im Dump gefunden.')
    elif events:
        per_event = Counter(l.get('event_id') for l in leads_raw)
        event = max(events, key=lambda e: (per_event.get(e.get('id'), 0), e.get('id') or 0))
        if len(events) > 1:
            warnings.append('Mehrere Events im Dump: ' + ', '.join(
                f'{e.get("slug")} ({per_event.get(e.get("id"), 0)} Leads)' for e in events)
                + f' – ausgewertet wird „{event.get("slug")}“ (mit --event-slug änderbar).')
    else:
        event = {}
        warnings.append('Keine Event-Stammdaten im Dump – alle Daten werden ohne Event-Filter ausgewertet.')
    eid = event.get('id')
    in_event = (lambda r: eid is None or r.get('event_id') == eid)

    projects = [Project(p.get('id'), p.get('slug') or slugify(p.get('title')), p.get('title') or p.get('slug') or '?',
                        p.get('label') or '', p.get('description') or '', to_bool(p.get('active')), to_int(p.get('sort_order')))
                for p in (raw.get('projects') or []) if in_event(p)]
    projects.sort(key=lambda p: (p.sort_order, p.id or 0))
    companies = [Company(c.get('id'), c.get('slug') or slugify(c.get('name')), c.get('name') or c.get('slug') or '?',
                         to_bool(c.get('active')), to_int(c.get('sort_order')))
                 for c in (raw.get('companies') or []) if in_event(c)]
    companies.sort(key=lambda c: (c.sort_order, c.id or 0))
    pslug = {p.id: p.slug for p in projects}
    cname = {c.id: c.name for c in companies}

    alloc = defaultdict(dict)
    for a in raw.get('lead_allocations') or []:
        slug = pslug.get(a.get('project_id'))
        if slug is None:
            slug = f'projekt-{a.get("project_id")}'
            if slug not in {p.slug for p in projects}:
                projects.append(Project(a.get('project_id'), slug, f'Projekt #{a.get("project_id")} (nicht mehr in Stammdaten)',
                                        active=False, sort_order=999))
                pslug[a.get('project_id')] = slug
        amount = to_int(a.get('amount_euro'))
        if amount:
            alloc[str(a.get('lead_id'))][slug] = amount

    leads = []
    for l in leads_raw:
        if not in_event(l):
            continue
        cid = l.get('company_id')
        company = cname.get(cid)
        if cid is not None and company is None:
            company = f'Betrieb #{cid}'
        leads.append(Lead(
            id=str(l.get('id')), status=l.get('status') or 'pending',
            first_name=(l.get('first_name') or '').strip(), last_name=(l.get('last_name') or '').strip(),
            email=(l.get('email') or '').strip(), phone=(l.get('phone_e164') or '').strip(), company=company,
            allocations=alloc.get(str(l.get('id')), {}), created_at=parse_ts(l.get('created_at')),
            completed_at=parse_ts(l.get('completed_at')), consent_at=parse_ts(l.get('consent_at')),
            consent_text=l.get('consent_text'), phone_verified_at=parse_ts(l.get('phone_verified_at')),
            email_verified_at=parse_ts(l.get('email_verified_at')), user_agent=l.get('user_agent'),
            updated_at=parse_ts(l.get('updated_at')),
        ))

    sessions = []
    for s in raw.get('sessions') or []:
        if not in_event(s):
            continue
        a_raw = s.get('allocations')
        if isinstance(a_raw, str):
            try:
                a_raw = json.loads(a_raw)
            except ValueError:
                a_raw = {}
        a = {k: to_int(v) for k, v in (a_raw or {}).items() if to_int(v)}
        cid = s.get('company_id')
        sessions.append(Session(
            id=str(s.get('id')), status=s.get('status') or 'open', last_step=s.get('last_step') or 'start',
            abort_reason=s.get('abort_reason'), created_at=parse_ts(s.get('created_at')),
            updated_at=parse_ts(s.get('updated_at')), ended_at=parse_ts(s.get('ended_at')),
            company=cname.get(cid) if cid is not None else None, allocations=a,
            lead_id=str(s['lead_id']) if s.get('lead_id') else None, user_agent=s.get('user_agent'),
        ))
    known_leads = {l.id for l in leads}
    verifications = []
    for v in raw.get('verifications') or []:
        if str(v.get('lead_id')) in known_leads or eid is None:
            verifications.append({
                'id': v.get('id'), 'lead_id': str(v.get('lead_id')), 'channel': v.get('channel'), 'target': v.get('target'),
                'attempts': to_int(v.get('attempts')), 'expires_at': parse_ts(v.get('expires_at')),
                'consumed_at': parse_ts(v.get('consumed_at')), 'created_at': parse_ts(v.get('created_at')),
            })
    meta = dict(raw.get('meta') or {})
    return Data(source, event, projects, companies, leads, sessions, verifications, meta, warnings)


# ------------------------------------------------------------------------------------------------
# Laden: Admin-CSV-Exporte
# ------------------------------------------------------------------------------------------------
def read_csv_rows(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        sample = f.read(8192)
        f.seek(0)
        delim = ';' if sample.count(';') >= sample.count(',') else ','
        reader = csv.DictReader(f, delimiter=delim)
        rows = [{(k or '').strip(): (v or '').strip().lstrip("'") for k, v in r.items() if k is not None} for r in reader]
        return rows, [(h or '').strip() for h in (reader.fieldnames or [])]


def col(row, *names, default=''):
    low = {k.lower(): v for k, v in row.items()}
    for n in names:
        if n.lower() in low:
            return low[n.lower()]
    return default


def load_event_config(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_csv(leads_csv, sessions_csv, event_config_path):
    cfg = load_event_config(event_config_path) if event_config_path else None
    warnings = []
    lead_rows, lead_headers = read_csv_rows(leads_csv) if leads_csv else ([], [])
    sess_rows, sess_headers = read_csv_rows(sessions_csv) if sessions_csv else ([], [])
    if not leads_csv:
        warnings.append('Keine Lead-CSV angegeben – nur Sitzungen ausgewertet.')
    if not sessions_csv:
        warnings.append('Keine Sitzungs-CSV angegeben – nur Leads ausgewertet.')

    proj_titles = []
    for h in lead_headers + sess_headers:
        if h.endswith('(€)'):
            t = h[:-3].strip()
            if t not in proj_titles:
                proj_titles.append(t)
    cfg_projects = {p.get('title'): p for p in (cfg or {}).get('projects', [])}
    projects = []
    for i, t in enumerate(proj_titles):
        cp = cfg_projects.get(t, {})
        projects.append(Project(None, cp.get('slug') or slugify(t), t, cp.get('label', ''), cp.get('description', ''), True, i))
    for i, p in enumerate((cfg or {}).get('projects', [])):
        if p.get('title') not in proj_titles:
            warnings.append(f'Projekt „{p.get("title")}“ aus der Konfiguration kommt in den CSV-Spalten nicht vor.')
    title_to_slug = {p.title: p.slug for p in projects}

    comp_names = []
    for p in (cfg or {}).get('companies', []):
        if p.get('name') and p['name'] not in comp_names:
            comp_names.append(p['name'])
    for r in lead_rows + sess_rows:
        n = col(r, 'Glücksrad-Betrieb', 'Betrieb')
        if n and n not in comp_names:
            comp_names.append(n)
    companies = [Company(None, slugify(n), n, True, i) for i, n in enumerate(comp_names)]

    def allocs(r):
        out = {}
        for t, slug in title_to_slug.items():
            v = to_int(col(r, f'{t} (€)'))
            if v:
                out[slug] = v
        return out

    leads = []
    for r in lead_rows:
        lid = col(r, 'Lead-ID', 'id')
        if not lid:
            continue
        leads.append(Lead(
            id=lid, status=col(r, 'Status') or 'completed', first_name=col(r, 'Vorname'), last_name=col(r, 'Name', 'Nachname'),
            email=col(r, 'E-Mail', 'Email'), phone=col(r, 'Telefon'), company=col(r, 'Glücksrad-Betrieb', 'Betrieb') or None,
            allocations=allocs(r), created_at=parse_ts(col(r, 'Erstellt')), completed_at=parse_ts(col(r, 'Abgeschlossen')),
            consent_at=parse_ts(col(r, 'Einwilligung')), phone_verified_at=parse_ts(col(r, 'Telefon verifiziert')),
            consent_text=(cfg or {}).get('consentText'),
        ))
    sessions = []
    for r in sess_rows:
        sid = col(r, 'Sitzungs-ID', 'id')
        if not sid:
            continue
        sessions.append(Session(
            id=sid, status=col(r, 'Status') or 'open', last_step=col(r, 'Letzter Schritt') or 'start',
            abort_reason=col(r, 'Abbruchgrund') or None, created_at=parse_ts(col(r, 'Gestartet')),
            updated_at=parse_ts(col(r, 'Zuletzt aktiv')), ended_at=parse_ts(col(r, 'Beendet')),
            company=col(r, 'Glücksrad-Betrieb', 'Betrieb') or None, allocations=allocs(r), lead_id=col(r, 'Lead-ID') or None,
        ))
    event = {'slug': (cfg or {}).get('slug', ''), 'title': (cfg or {}).get('title', ''),
             'budget_euro': ((cfg or {}).get('budget') or {}).get('totalEuro'), 'organizer': (cfg or {}).get('organizer', '')}
    src = ', '.join(Path(p).name for p in (leads_csv, sessions_csv) if p)
    return Data(f'Admin-CSV ({src})', event, projects, companies, leads, sessions, [], {}, warnings)


# ------------------------------------------------------------------------------------------------
# Test-Markierung
# ------------------------------------------------------------------------------------------------
def detect_event_days(data):
    counts = Counter(l.created_at.date() for l in data.leads if l.created_at and l.status == 'completed')
    if not counts:
        counts = Counter(s.created_at.date() for s in data.sessions if s.created_at)
    if not counts:
        return []
    mx = max(counts.values())
    days = sorted(d for d, n in counts.items() if n >= max(3, 0.2 * mx))
    return days or [max(counts, key=counts.get)]


def classify(data, opts):
    event_days = set(opts['event_days'])
    h_from, h_to = opts['hours']
    testers = [t.lower() for t in opts['testers']]
    tester_emails = {e.lower() for e in opts['tester_emails']}
    tester_domains = {d.lower().lstrip('@') for d in opts['tester_domains']}

    email_count = Counter(l.email.lower() for l in data.leads if l.email)
    phone_count = Counter(phone_digits(l.phone) for l in data.leads if phone_digits(l.phone))

    def timing_reasons(ts):
        out = []
        if not ts:
            return out
        if event_days and ts.date() not in event_days:
            out.append((3, f'außerhalb der Messetage ({fmt_date(ts.date())})'))
        elif event_days and not (h_from <= ts.hour * 60 + ts.minute < h_to):
            out.append((2, f'außerhalb der Messezeit ({ts.strftime("%H:%M")} Uhr)'))
        return out

    for l in data.leads:
        r = timing_reasons(l.created_at)
        if looks_dummy_name(l.first_name, l.last_name):
            r.append((2, 'Name wirkt wie Testeingabe'))
        if looks_dummy_email(l.email):
            r.append((2, 'E-Mail wirkt wie Testeingabe'))
        if looks_dummy_phone(l.phone):
            r.append((2, 'Telefonnummer wirkt wie Testeingabe'))
        el = l.email.lower()
        dom = el.rpartition('@')[2]
        if el in tester_emails:
            r.append((3, 'E-Mail eines bekannten Testers'))
        elif dom and dom in tester_domains:
            r.append((3, f'E-Mail-Domain eines Testers (@{dom})'))
        hay = f'{l.first_name} {l.last_name} {el}'.lower()
        hit = [t for t in testers if t and t in hay]
        if hit:
            r.append((2, f'Treffer Tester-Liste ({", ".join(hit)})'))
        # Dubletten zählen nicht zum Score (Geschwister, erneuter Durchlauf nach Tippfehler) – nur Hinweis.
        if l.email and email_count[el] > 1:
            r.append((0, f'Hinweis: E-Mail mehrfach verwendet ({email_count[el]}×)'))
        pd = phone_digits(l.phone)
        if pd and phone_count[pd] > 1:
            r.append((0, f'Hinweis: Telefon mehrfach verwendet ({phone_count[pd]}×)'))
        l.reasons = r

    # Gerät: dominantes Gerät unter unauffälligen Leads an Messetagen = Messe-Tablet; Abweichler bekommen +1.
    ua_counter = Counter(l.user_agent for l in data.leads
                         if l.user_agent and sum(w for w, _ in l.reasons) == 0 and l.created_at
                         and (not event_days or l.created_at.date() in event_days))
    majority_ua = ua_counter.most_common(1)[0] if ua_counter else None
    if majority_ua and majority_ua[1] >= 5:
        for l in data.leads:
            if l.user_agent and l.user_agent != majority_ua[0]:
                l.reasons.append((1, f'abweichendes Gerät ({device_label(l.user_agent)})'))

    for l in data.leads:
        l.score = sum(w for w, _ in l.reasons)
        l.klass = KLASS_TEST if l.score >= TEST_THRESHOLD else KLASS_CHECK if l.score >= CHECK_THRESHOLD else KLASS_LEAD

    by_lead = {l.id: l for l in data.leads}
    for s in data.sessions:
        r = []
        lead = by_lead.get(s.lead_id) if s.lead_id else None
        if lead:
            if lead.klass != KLASS_LEAD:
                r.append((lead.score, f'verknüpfter Lead als „{lead.klass}“ markiert'))
        else:
            r = timing_reasons(s.created_at)
            if majority_ua and majority_ua[1] >= 5 and s.user_agent and s.user_agent != majority_ua[0]:
                r.append((1, f'abweichendes Gerät ({device_label(s.user_agent)})'))
        s.reasons = r
        s.score = sum(w for w, _ in r)
        s.klass = KLASS_TEST if s.score >= TEST_THRESHOLD else KLASS_CHECK if s.score >= CHECK_THRESHOLD else KLASS_LEAD
    return {'majority_device': device_label(majority_ua[0]) if majority_ua and majority_ua[1] >= 5 else None}


# ------------------------------------------------------------------------------------------------
# Auswertung
# ------------------------------------------------------------------------------------------------
def compute_stats(data, event_days):
    leads = data.leads
    completed = [l for l in leads if l.status == 'completed']
    clean = [l for l in completed if l.klass != KLASS_TEST]
    tests = [l for l in leads if l.klass == KLASS_TEST]
    checks = [l for l in leads if l.klass == KLASS_CHECK]
    sessions = data.sessions
    clean_sessions = [s for s in sessions if s.klass != KLASS_TEST]

    def sums(items):
        c = Counter()
        for it in items:
            for slug, v in it.allocations.items():
                c[slug] += v
        return c

    sum_clean, sum_all = sums(clean), sums(completed)
    sum_sess_all, sum_sess_clean = sums(sessions), sums(clean_sessions)
    total_clean = sum(sum_clean.values())
    projects = []
    for p in data.projects:
        votes = sum(1 for l in clean if l.allocations.get(p.slug))
        projects.append({
            'slug': p.slug, 'title': p.title, 'label': p.label, 'active': p.active,
            'sum_clean': sum_clean[p.slug], 'votes_clean': votes,
            'avg_clean': (sum_clean[p.slug] / len(clean)) if clean else 0,
            'avg_voter': (sum_clean[p.slug] / votes) if votes else 0,
            'share_clean': (sum_clean[p.slug] / total_clean) if total_clean else None,
            'sum_all': sum_all[p.slug], 'sum_sessions_all': sum_sess_all[p.slug], 'sum_sessions_clean': sum_sess_clean[p.slug],
            'top_count': sum(1 for l in clean if l.allocations and max(l.allocations, key=l.allocations.get) == p.slug
                             and list(l.allocations.values()).count(l.allocations[p.slug]) == 1),
        })
    ranked = sorted(projects, key=lambda x: (-x['sum_clean'], x['title']))
    for i, p in enumerate(ranked, 1):
        p['rank'] = i

    companies = []
    comp_names = [c.name for c in data.companies]
    for l in leads:
        if l.company and l.company not in comp_names:
            comp_names.append(l.company)
    for s in sessions:
        if s.company and s.company not in comp_names:
            comp_names.append(s.company)
    for name in comp_names:
        n_clean = sum(1 for l in clean if l.company == name)
        companies.append({
            'name': name, 'leads_clean': n_clean, 'share_clean': (n_clean / len(clean)) if clean else None,
            'leads_all': sum(1 for l in completed if l.company == name),
            'sessions': sum(1 for s in sessions if s.company == name),
            'sessions_clean': sum(1 for s in clean_sessions if s.company == name),
        })

    status_counts = Counter(s.status for s in sessions)
    klass_counts_sessions = Counter(s.klass for s in sessions)
    step_idx = {s: i for i, s in enumerate(STEPS)}
    funnel = []
    for i, st in enumerate(STEPS):
        reached = sum(1 for s in clean_sessions if step_idx.get(s.last_step, 0) >= i)
        funnel.append({'step': st, 'label': STEP_LABELS[st], 'reached': reached,
                       'share': (reached / len(clean_sessions)) if clean_sessions else None,
                       'aborted_here': sum(1 for s in clean_sessions if s.status == 'aborted' and s.last_step == st),
                       'open_here': sum(1 for s in clean_sessions if s.status == 'open' and s.last_step == st)})
    abort_reasons = Counter((s.abort_reason or '') for s in clean_sessions if s.status == 'aborted')
    dur_completed = [s.duration_min for s in clean_sessions if s.status == 'completed' and s.duration_min is not None]
    dur_aborted = [s.duration_min for s in clean_sessions if s.status == 'aborted' and s.duration_min is not None]

    def dstats(xs):
        return {'n': len(xs), 'median': statistics.median(xs) if xs else None, 'mean': statistics.fmean(xs) if xs else None,
                'max': max(xs) if xs else None}

    days = defaultdict(lambda: Counter())
    for s in sessions:
        if s.created_at:
            d = s.created_at.date()
            days[d]['sessions'] += 1
            days[d][f'sessions_{s.status}'] += 1
            if s.klass == KLASS_TEST:
                days[d]['sessions_test'] += 1
    for l in leads:
        if l.created_at:
            d = l.created_at.date()
            days[d]['leads'] += 1
            if l.status == 'completed' and l.klass != KLASS_TEST:
                days[d]['leads_clean'] += 1
            if l.klass == KLASS_TEST:
                days[d]['leads_test'] += 1
            elif l.klass == KLASS_CHECK:
                days[d]['leads_check'] += 1
    timeline = [{'date': d, 'event_day': d in set(event_days), **c} for d, c in sorted(days.items())]
    hours = defaultdict(lambda: Counter())
    for s in sessions:
        if s.created_at and s.created_at.date() in set(event_days):
            hours[(s.created_at.date(), s.created_at.hour)]['sessions'] += 1
    for l in clean:
        if l.created_at and l.created_at.date() in set(event_days):
            hours[(l.created_at.date(), l.created_at.hour)]['leads_clean'] += 1
    hourly = [{'date': d, 'hour': h, **c} for (d, h), c in sorted(hours.items())]

    all_ts = [x for x in [l.updated_at or l.created_at for l in leads] + [s.updated_at or s.created_at for s in sessions] if x]
    first_ts = min([x for x in [l.created_at for l in leads] + [s.created_at for s in sessions] if x], default=None)
    sess_with_lead = {s.lead_id for s in sessions if s.lead_id}
    return {
        'leads_total': len(leads), 'leads_completed': len(completed), 'leads_pending': len(leads) - len(completed),
        'leads_clean': len(clean), 'leads_test': len(tests), 'leads_check': len(checks),
        'leads_clean_pending': sum(1 for l in leads if l.status != 'completed' and l.klass != KLASS_TEST),
        'budget_total_clean': total_clean, 'budget_total_all': sum(sum_all.values()),
        'sessions_total': len(sessions), 'sessions_clean': len(clean_sessions),
        'sessions_by_status': dict(status_counts), 'sessions_by_klass': dict(klass_counts_sessions),
        'sessions_clean_by_status': dict(Counter(s.status for s in clean_sessions)),
        'conversion': (sum(1 for s in clean_sessions if s.status == 'completed') / len(clean_sessions)) if clean_sessions else None,
        'leads_without_session': sum(1 for l in completed if l.id not in sess_with_lead),
        'projects': projects, 'projects_ranked': ranked, 'companies': companies, 'funnel': funnel,
        'abort_reasons': dict(abort_reasons), 'duration_completed': dstats(dur_completed), 'duration_aborted': dstats(dur_aborted),
        'timeline': timeline, 'hourly': hourly, 'data_from': first_ts, 'data_until': max(all_ts, default=None),
        'verified_phones': sum(1 for l in leads if l.phone_verified_at),
        'consent_texts': sorted({l.consent_text for l in leads if l.consent_text}),
        'devices_leads': Counter(device_label(l.user_agent) for l in leads if l.user_agent),
    }


# ------------------------------------------------------------------------------------------------
# Excel
# ------------------------------------------------------------------------------------------------
def write_xlsx(path, data, stats, ctx):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    HEAD_FILL = PatternFill('solid', fgColor='1C5CAB')
    HEAD_FONT = Font(bold=True, color='FFFFFF')
    FILL = {KLASS_TEST: PatternFill('solid', fgColor='FDE2E1'), KLASS_CHECK: PatternFill('solid', fgColor='FFF3CD')}
    THIN = Side(style='thin', color='E3E3E0')
    EUR = '#,##0 "€"'
    DT = 'DD.MM.YYYY HH:MM:SS'
    wb = Workbook()
    wb.remove(wb.active)
    projects = data.projects

    def autosize(ws, min_w=6, max_w=48):
        widths = {}
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 400)):
            for c in row:
                if c.value is None:
                    continue
                v = c.value.strftime('%d.%m.%Y %H:%M:%S') if isinstance(c.value, datetime) else str(c.value)
                widths[c.column] = max(widths.get(c.column, 0), max(len(x) for x in v.split('\n')))
        for col_idx, w in widths.items():
            ws.column_dimensions[get_column_letter(col_idx)].width = max(min_w, min(max_w, w + 2))

    def table(ws, headers, rows, formats=None, klass_col=None, start_row=None, freeze=True, filt=True):
        r0 = start_row or ws.max_row + (1 if ws.max_row > 1 or ws.cell(1, 1).value else 0)
        if r0 == 0:
            r0 = 1
        for j, h in enumerate(headers, 1):
            c = ws.cell(r0, j, h)
            c.fill, c.font = HEAD_FILL, HEAD_FONT
            c.alignment = Alignment(vertical='center', wrap_text=True)
            c.border = Border(bottom=THIN)
        for i, row in enumerate(rows, 1):
            for j, v in enumerate(row, 1):
                c = ws.cell(r0 + i, j, v)
                if formats and j - 1 in formats and v not in (None, ''):
                    c.number_format = formats[j - 1]
                if isinstance(v, str) and len(v) > 60:
                    c.alignment = Alignment(wrap_text=True, vertical='top')
                else:
                    c.alignment = Alignment(vertical='top')
            if klass_col is not None and row[klass_col] in FILL:
                for j in range(1, len(headers) + 1):
                    ws.cell(r0 + i, j).fill = FILL[row[klass_col]]
        if freeze:
            ws.freeze_panes = ws.cell(r0 + 1, 1)
        if filt and rows:
            ws.auto_filter.ref = f'A{r0}:{get_column_letter(len(headers))}{r0 + len(rows)}'
        return r0 + len(rows)

    def kv_block(ws, title, pairs, row):
        ws.cell(row, 1, title).font = Font(bold=True, size=12)
        row += 1
        for k, v in pairs:
            ws.cell(row, 1, k).font = Font(bold=True)
            c = ws.cell(row, 2, v)
            if isinstance(v, datetime):
                c.number_format = DT
            row += 1
        return row + 1

    # --- Übersicht ---------------------------------------------------------------------------
    ws = wb.create_sheet('Übersicht')
    ev = data.event or {}
    r = 1
    ws.cell(r, 1, ctx['title']).font = Font(bold=True, size=16)
    r += 2
    r = kv_block(ws, 'Report', [
        ('Erstellt am', naive(ctx['generated_at'])), ('Datenquelle', data.source),
        ('Datenstand (letzte Änderung)', naive(stats['data_until'])), ('Erster Datensatz', naive(stats['data_from'])),
        ('Event', f"{ev.get('title') or ''} ({ev.get('slug') or '–'})"), ('Budget je Teilnehmer', fmt_eur(ev.get('budget_euro')) if ev.get('budget_euro') else '–'),
        ('Messetage', ', '.join(fmt_date(d) for d in ctx['event_days']) + (' (automatisch ermittelt)' if ctx['event_days_auto'] else ' (vorgegeben)')),
        ('Messezeit (für Markierung)', ctx['hours_label']),
        ('Tester-Liste', ', '.join(ctx['testers'] + ctx['tester_emails'] + [f'@{d}' for d in ctx['tester_domains']]) or '–'),
        ('Messe-Gerät (erkannt)', ctx.get('majority_device') or '–'),
    ], r)
    sbs = stats['sessions_by_status']
    scs = stats['sessions_clean_by_status']
    r = kv_block(ws, 'Kennzahlen', [
        ('Leads gesamt (alle Datensätze)', stats['leads_total']),
        ('… davon abgeschlossen', stats['leads_completed']), ('… davon unvollständig (pending)', stats['leads_pending']),
        ('… als „Test“ markiert', stats['leads_test']), ('… als „Prüfen“ markiert', stats['leads_check']),
        ('Leads bereinigt (abgeschlossen, ohne Test)', stats['leads_clean']),
        ('Verteiltes Budget bereinigt', fmt_eur(stats['budget_total_clean'])),
        ('Sitzungen gesamt', stats['sessions_total']),
        ('… abgeschlossen / abgebrochen / offen', f"{sbs.get('completed', 0)} / {sbs.get('aborted', 0)} / {sbs.get('open', 0)}"),
        ('Sitzungen bereinigt (ohne Test)', stats['sessions_clean']),
        ('… abgeschlossen / abgebrochen / offen', f"{scs.get('completed', 0)} / {scs.get('aborted', 0)} / {scs.get('open', 0)}"),
        ('Abschlussquote bereinigt (abgeschlossen ÷ Sitzungen)', fmt_pct(stats['conversion'])),
        ('Telefon verifiziert', stats['verified_phones']),
        ('Abgeschlossene Leads ohne Sitzungsdaten (ältere App-Version)', stats['leads_without_session']),
    ], r)
    ws.cell(r, 1, 'Budgetverteilung je Projekt (bereinigte Leads)').font = Font(bold=True, size=12)
    r = table(ws, ['Rang', 'Projekt', 'Summe (€)', 'Anteil', 'Stimmen (Leads mit Betrag > 0)', 'Ø je Lead (€)', 'Ø je Stimme (€)',
                   'Häufigster Favorit', 'Summe alle Leads inkl. Test (€)', 'Summe alle Sitzungen (€)'],
              [[p['rank'], p['title'] + ('' if p['active'] else ' (inaktiv)'), p['sum_clean'], fmt_pct(p['share_clean']), p['votes_clean'],
                round(p['avg_clean']), round(p['avg_voter']), p['top_count'], p['sum_all'], p['sum_sessions_all']]
               for p in stats['projects_ranked']],
              formats={2: EUR, 5: EUR, 6: EUR, 8: EUR, 9: EUR}, start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Glücksrad je Betrieb').font = Font(bold=True, size=12)
    r = table(ws, ['Betrieb', 'Leads bereinigt', 'Anteil', 'Leads alle (inkl. Test)', 'Sitzungen mit Auswahl'],
              [[c['name'], c['leads_clean'], fmt_pct(c['share_clean']), c['leads_all'], c['sessions']] for c in stats['companies']],
              start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Sitzungs-Trichter (bereinigt)').font = Font(bold=True, size=12)
    r = table(ws, ['Schritt', 'Erreicht', 'Anteil', 'Abgebrochen in diesem Schritt', 'Offen in diesem Schritt'],
              [[f['label'], f['reached'], fmt_pct(f['share']), f['aborted_here'], f['open_here']] for f in stats['funnel']],
              start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Abbruchgründe (bereinigt)').font = Font(bold=True, size=12)
    r = table(ws, ['Grund', 'Anzahl'], [[ABORT_LABELS.get(k, k), v] for k, v in sorted(stats['abort_reasons'].items(), key=lambda x: -x[1])],
              start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Dauer je Sitzung in Minuten (bereinigt)').font = Font(bold=True, size=12)
    r = table(ws, ['Sitzungen', 'Anzahl', 'Median', 'Durchschnitt', 'Maximum'],
              [[lbl, d['n'], d['median'], d['mean'], d['max']] for lbl, d in
               (('abgeschlossen', stats['duration_completed']), ('abgebrochen', stats['duration_aborted']))],
              formats={2: '0.0', 3: '0.0', 4: '0.0'}, start_row=r + 1, freeze=False, filt=False) + 2
    if data.warnings:
        ws.cell(r, 1, 'Hinweise').font = Font(bold=True, size=12)
        for w in data.warnings:
            r += 1
            ws.cell(r, 1, w)
    ws.column_dimensions['A'].width = 58
    ws.column_dimensions['B'].width = 34
    for col_letter in 'CDEFGHIJ':
        ws.column_dimensions[col_letter].width = 20

    # --- Leads -------------------------------------------------------------------------------
    multi_consent = len(stats['consent_texts']) > 1
    lead_headers = ['Nr', 'Einstufung', 'Test-Score', 'Gründe', 'Status', 'Erstellt', 'Abgeschlossen', 'Vorname', 'Name', 'E-Mail',
                    'Telefon', 'Telefon verifiziert', 'Glücksrad-Betrieb', *[f'{p.title} (€)' for p in projects], 'Summe (€)',
                    'Favorit (höchster Betrag)', 'Einwilligung am', 'Gerät / Browser', 'Lead-ID'] + (['Einwilligungstext'] if multi_consent else [])
    n_fixed = 13

    def favorite(l):
        if not l.allocations:
            return ''
        mx = max(l.allocations.values())
        tops = [p.title for p in projects if l.allocations.get(p.slug) == mx]
        return ' / '.join(tops) if tops else ''

    def lead_row(i, l):
        return [i, l.klass, l.score, '; '.join(t for _, t in l.reasons), STATUS_LABELS.get(l.status, l.status), naive(l.created_at),
                naive(l.completed_at), l.first_name, l.last_name, l.email, l.phone, naive(l.phone_verified_at), l.company or '',
                *[l.allocations.get(p.slug, 0) for p in projects], l.total, favorite(l), naive(l.consent_at),
                device_label(l.user_agent), l.id] + ([l.consent_text or ''] if multi_consent else [])

    lead_formats = {5: DT, 6: DT, 11: DT, **{n_fixed + k: EUR for k in range(len(projects) + 1)}, n_fixed + len(projects) + 2: DT}
    sorted_leads = sorted(data.leads, key=lambda l: (l.created_at or datetime.min.replace(tzinfo=TZ)))
    for sheet, subset in (('Leads (alle)', sorted_leads),
                          ('Leads (bereinigt)', [l for l in sorted_leads if l.klass != KLASS_TEST and l.status == 'completed']),
                          ('Leads (markiert)', [l for l in sorted_leads if l.klass != KLASS_LEAD or l.status != 'completed' or l.reasons])):
        ws = wb.create_sheet(sheet)
        table(ws, lead_headers, [lead_row(i, l) for i, l in enumerate(subset, 1)], lead_formats, klass_col=1)
        autosize(ws)
        ws.column_dimensions['D'].width = 48

    # --- Sitzungen ---------------------------------------------------------------------------
    by_lead = {l.id: l for l in data.leads}
    sess_headers = ['Nr', 'Einstufung', 'Gründe', 'Status', 'Letzter Schritt', 'Abbruchgrund', 'Gestartet', 'Zuletzt aktiv', 'Beendet',
                    'Dauer (Min)', 'Glücksrad-Betrieb', *[f'{p.title} (€)' for p in projects], 'Summe (€)', 'Lead (Name)', 'Lead-ID',
                    'Gerät / Browser', 'Sitzungs-ID']
    ws = wb.create_sheet('Sitzungen (alle)')
    rows = []
    for i, s in enumerate(sorted(data.sessions, key=lambda s: (s.created_at or datetime.min.replace(tzinfo=TZ))), 1):
        lead = by_lead.get(s.lead_id) if s.lead_id else None
        rows.append([i, s.klass, '; '.join(t for _, t in s.reasons), STATUS_LABELS.get(s.status, s.status),
                     STEP_LABELS.get(s.last_step, s.last_step), ABORT_LABELS.get(s.abort_reason or '', s.abort_reason or ''),
                     naive(s.created_at), naive(s.updated_at), naive(s.ended_at), s.duration_min, s.company or '',
                     *[s.allocations.get(p.slug, 0) for p in projects], s.total, lead.name if lead else '', s.lead_id or '',
                     device_label(s.user_agent), s.id])
    table(ws, sess_headers, rows, {6: DT, 7: DT, 8: DT, 9: '0.0', **{11 + k: EUR for k in range(len(projects) + 1)}}, klass_col=1)
    autosize(ws)

    # --- Projekte / Betriebe / Zeitverlauf -------------------------------------------------------
    ws = wb.create_sheet('Projekte')
    table(ws, ['Rang', 'Projekt', 'Kategorie', 'Aktiv', 'Summe bereinigt (€)', 'Anteil', 'Stimmen', 'Ø je Lead (€)', 'Ø je Stimme (€)',
               'Häufigster Favorit', 'Summe alle Leads inkl. Test (€)', 'Summe alle Sitzungen (€)', 'Summe Sitzungen bereinigt (€)'],
          [[p['rank'], p['title'], p['label'], 'ja' if p['active'] else 'nein', p['sum_clean'], fmt_pct(p['share_clean']), p['votes_clean'],
            round(p['avg_clean']), round(p['avg_voter']), p['top_count'], p['sum_all'], p['sum_sessions_all'], p['sum_sessions_clean']]
           for p in stats['projects_ranked']], {4: EUR, 7: EUR, 8: EUR, 10: EUR, 11: EUR, 12: EUR})
    autosize(ws)
    ws = wb.create_sheet('Betriebe')
    table(ws, ['Betrieb', 'Leads bereinigt', 'Anteil', 'Leads alle (inkl. Test)', 'Sitzungen mit Auswahl', 'Sitzungen bereinigt'],
          [[c['name'], c['leads_clean'], fmt_pct(c['share_clean']), c['leads_all'], c['sessions'], c['sessions_clean']] for c in stats['companies']])
    autosize(ws)
    ws = wb.create_sheet('Zeitverlauf')
    r = table(ws, ['Datum', 'Wochentag', 'Messetag', 'Sitzungen gestartet', 'Sitzungen abgeschlossen', 'Sitzungen abgebrochen', 'Sitzungen offen',
                   'Leads (alle)', 'Leads bereinigt', 'Leads Test', 'Leads Prüfen'],
              [[t['date'], WEEKDAYS[t['date'].weekday()], 'ja' if t['event_day'] else 'nein', t.get('sessions', 0), t.get('sessions_completed', 0),
                t.get('sessions_aborted', 0), t.get('sessions_open', 0), t.get('leads', 0), t.get('leads_clean', 0), t.get('leads_test', 0),
                t.get('leads_check', 0)] for t in stats['timeline']], {0: 'DD.MM.YYYY'}, freeze=True)
    r += 2
    ws.cell(r, 1, 'Stundenverlauf an den Messetagen').font = Font(bold=True, size=12)
    table(ws, ['Datum', 'Stunde', 'Sitzungen gestartet', 'Leads bereinigt'],
          [[h['date'], f"{h['hour']:02d}:00–{h['hour'] + 1:02d}:00", h.get('sessions', 0), h.get('leads_clean', 0)] for h in stats['hourly']],
          {0: 'DD.MM.YYYY'}, start_row=r + 1, freeze=False, filt=False)
    autosize(ws)

    # --- Stammdaten / Verifizierungen / Legende -------------------------------------------------
    ws = wb.create_sheet('Stammdaten')
    r = kv_block(ws, 'Event', [(k, str(v)) for k, v in (data.event or {}).items() if k not in ('id',)], 1)
    ws.cell(r, 1, 'Projekte').font = Font(bold=True, size=12)
    r = table(ws, ['ID', 'Slug', 'Titel', 'Kategorie', 'Beschreibung', 'Aktiv', 'Sortierung'],
              [[p.id, p.slug, p.title, p.label, p.description, 'ja' if p.active else 'nein', p.sort_order] for p in projects],
              start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Betriebe (Glücksrad)').font = Font(bold=True, size=12)
    r = table(ws, ['ID', 'Slug', 'Name', 'Aktiv', 'Sortierung'],
              [[c.id, c.slug, c.name, 'ja' if c.active else 'nein', c.sort_order] for c in data.companies],
              start_row=r + 1, freeze=False, filt=False) + 2
    ws.cell(r, 1, 'Einwilligungstext(e) (je Lead gespeichert)').font = Font(bold=True, size=12)
    for t in stats['consent_texts'] or ['(nicht in der Datenquelle enthalten)']:
        r += 1
        ws.cell(r, 1, t).alignment = Alignment(wrap_text=True, vertical='top')
    ws.column_dimensions['A'].width = 28
    ws.column_dimensions['C'].width = 30
    ws.column_dimensions['E'].width = 60

    ws = wb.create_sheet('Verifizierungen')
    if data.verifications:
        table(ws, ['ID', 'Lead-ID', 'Lead (Name)', 'Kanal', 'Ziel', 'Versuche', 'Erstellt', 'Gültig bis', 'Eingelöst'],
              [[v['id'], v['lead_id'], by_lead[v['lead_id']].name if v['lead_id'] in by_lead else '', v['channel'], v['target'], v['attempts'],
                naive(v['created_at']), naive(v['expires_at']), naive(v['consumed_at'])] for v in data.verifications], {6: DT, 7: DT, 8: DT})
    else:
        ws.cell(1, 1, 'Keine Verifizierungen vorhanden (SMS-Verifizierung war nicht aktiv bzw. in dieser Datenquelle nicht enthalten).')
    autosize(ws)

    ws = wb.create_sheet('Legende')
    rows = [
        ('Einstufung', 'Lead = unauffällig · Prüfen = 1–2 Indizien, bitte ansehen · Test = Score ≥ 3, sehr wahrscheinlich Testlauf. Nichts wird gelöscht.'),
        ('Test-Score', 'Summe der Gewichte aller Indizien (siehe Gründe).'),
        ('Gründe', 'außerhalb der Messetage (+3) · außerhalb der Messezeit (+2) · Name/E-Mail/Telefon wirkt wie Testeingabe (+2 je) · '
                   'E-Mail/Domain eines bekannten Testers (+3) · Treffer Tester-Liste (+2) · abweichendes Gerät (+1) · '
                   'Hinweis „mehrfach verwendet“ (Dublette, zählt nicht zum Score).'),
        ('Leads (markiert)', 'Alle Datensätze mit Einstufung Test/Prüfen, unvollständige Leads und Dubletten-Hinweise.'),
        ('Leads (bereinigt)', 'Nur abgeschlossene Leads ohne „Test“. „Prüfen“ bleibt enthalten und ist farblich markiert.'),
        ('Status Lead', 'abgeschlossen = Kontaktdaten mit Einwilligung gespeichert · unvollständig = Lead angelegt, aber nicht abgeschlossen.'),
        ('Sitzung', 'Jeder Durchlauf am Kiosk ab dem ersten Schritt – auch ohne Kontaktdaten. Enthält Budgetverteilung und Glücksrad-Ergebnis.'),
        ('Status Sitzung', 'abgeschlossen = mit Lead beendet · abgebrochen = Kiosk-Reset/Inaktivität · offen = ohne Abschluss (z. B. Browser geschlossen).'),
        ('Letzter Schritt', 'Start → Budget → Glücksrad → Kontaktdaten → (Verifizierung) → Fertig.'),
        ('Summe alle Sitzungen', 'Budget-Stimmungsbild inkl. Abbrüche (ohne Kontaktdaten) – nicht mit den Lead-Summen addieren.'),
        ('Häufigster Favorit', 'Anzahl bereinigter Leads, bei denen das Projekt den eindeutig höchsten Betrag erhalten hat.'),
        ('Zeiten', 'Alle Zeitangaben in Europe/Berlin.'),
        ('Datenschutz', 'Enthält personenbezogene Daten – nur für den vereinbarten Zweck (Kontakt zum Gewinn) verwenden.'),
    ]
    table(ws, ['Begriff', 'Erläuterung'], rows, freeze=False, filt=False)
    ws.column_dimensions['A'].width = 26
    ws.column_dimensions['B'].width = 120
    for row in ws.iter_rows(min_row=2):
        row[1].alignment = Alignment(wrap_text=True, vertical='top')

    wb.save(path)


# ------------------------------------------------------------------------------------------------
# PDF
# ------------------------------------------------------------------------------------------------
def write_pdf(path, data, stats, ctx):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak, PageTemplate, Paragraph,
                                    Spacer, Table, TableStyle)
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics.charts.barcharts import HorizontalBarChart, VerticalBarChart

    def register_fonts():
        for d in (Path('/usr/share/fonts/truetype/dejavu'), Path('/usr/share/fonts/dejavu'), Path('/Library/Fonts'),
                  Path.home() / '.fonts', Path('C:/Windows/Fonts')):
            reg, bold = d / 'DejaVuSans.ttf', d / 'DejaVuSans-Bold.ttf'
            if reg.exists() and bold.exists():
                pdfmetrics.registerFont(TTFont('Body', str(reg)))
                pdfmetrics.registerFont(TTFont('Body-Bold', str(bold)))
                pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body', boldItalic='Body-Bold')
                return 'Body', 'Body-Bold'
        return 'Helvetica', 'Helvetica-Bold'

    FONT, FONT_B = register_fonts()
    INK, INK2, LINE, SURF = colors.HexColor('#0b0b0b'), colors.HexColor('#52514e'), colors.HexColor('#e3e3e0'), colors.HexColor('#f6f6f4')
    BLUE, HEAD = colors.HexColor('#2a78d6'), colors.HexColor('#1c5cab')
    FILL = {KLASS_TEST: colors.HexColor('#fde2e1'), KLASS_CHECK: colors.HexColor('#fff3cd')}
    st = {
        'h1': ParagraphStyle('h1', fontName=FONT_B, fontSize=20, leading=24, textColor=INK, spaceAfter=4),
        'h2': ParagraphStyle('h2', fontName=FONT_B, fontSize=13, leading=16, textColor=INK, spaceBefore=10, spaceAfter=5),
        'h3': ParagraphStyle('h3', fontName=FONT_B, fontSize=10, leading=13, textColor=INK, spaceBefore=6, spaceAfter=3),
        'body': ParagraphStyle('body', fontName=FONT, fontSize=9, leading=12, textColor=INK),
        'small': ParagraphStyle('small', fontName=FONT, fontSize=7.5, leading=9.5, textColor=INK2),
        'cell': ParagraphStyle('cell', fontName=FONT, fontSize=7, leading=8.5, textColor=INK, alignment=TA_LEFT),
        'cellb': ParagraphStyle('cellb', fontName=FONT_B, fontSize=7, leading=8.5, textColor=colors.white),
        'kpi_v': ParagraphStyle('kpi_v', fontName=FONT_B, fontSize=16, leading=19, textColor=INK),
        'kpi_l': ParagraphStyle('kpi_l', fontName=FONT, fontSize=7.5, leading=9.5, textColor=INK2),
    }
    P = lambda t, s='body': Paragraph(str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), st[s])

    def on_page(canvas, doc):
        canvas.saveState()
        w, h = canvas._pagesize
        canvas.setFont(FONT, 7)
        canvas.setFillColor(INK2)
        canvas.drawString(12 * mm, 8 * mm, f"{ctx['title']} · Datenstand {fmt_dt(stats['data_until'], False) or '–'}")
        canvas.drawRightString(w - 12 * mm, 8 * mm, f'Vertraulich – enthält personenbezogene Daten · Seite {doc.page}')
        canvas.restoreState()

    doc = BaseDocTemplate(path, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=14 * mm, bottomMargin=16 * mm,
                          title=ctx['title'], author='Lead-App „Ein Tag Chef sein“', subject='Lead-Report')
    pw, ph = A4
    lw, lh = landscape(A4)
    doc.addPageTemplates([
        PageTemplate(id='P', frames=[Frame(14 * mm, 16 * mm, pw - 28 * mm, ph - 30 * mm, id='fp')], onPage=on_page, pagesize=A4),
        PageTemplate(id='L', frames=[Frame(12 * mm, 16 * mm, lw - 24 * mm, lh - 30 * mm, id='fl')], onPage=on_page, pagesize=landscape(A4)),
    ])
    avail_p = pw - 28 * mm
    avail_l = lw - 24 * mm

    def grid_table(headers, rows, widths, klass_idx=None, font_size=7, align_right=()):
        head = [P(h, 'cellb') for h in headers]
        body = []
        for row in rows:
            body.append([P(v if v is not None else '', 'cell') if not isinstance(v, Paragraph) else v for v in row])
        t = Table([head] + body, colWidths=widths, repeatRows=1)
        style = [
            ('BACKGROUND', (0, 0), (-1, 0), HEAD), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LINEBELOW', (0, 0), (-1, -1), 0.3, LINE), ('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]
        for c in align_right:
            style.append(('ALIGN', (c, 1), (c, -1), 'RIGHT'))
        if klass_idx is not None:
            for i, row in enumerate(rows, 1):
                k = row[klass_idx]
                k = k.text if isinstance(k, Paragraph) else k
                if k in FILL:
                    style.append(('BACKGROUND', (0, i), (-1, i), FILL[k]))
        t.setStyle(TableStyle(style))
        return t

    def hbar(names, values, width, height, fmt):
        d = Drawing(width, height)
        bc = HorizontalBarChart()
        bc.x, bc.y, bc.width, bc.height = 95, 20, width - 170, height - 30
        vals = [float(v or 0) for v in values]
        bc.data = [vals]
        bc.categoryAxis.categoryNames = [n if len(n) <= 26 else n[:25] + '…' for n in names]
        bc.categoryAxis.reverseDirection = 1
        bc.categoryAxis.labels.boxAnchor, bc.categoryAxis.labels.dx = 'e', -5
        bc.categoryAxis.labels.fontName, bc.categoryAxis.labels.fontSize = FONT, 7.5
        bc.categoryAxis.strokeColor, bc.categoryAxis.tickLeft = LINE, 0
        bc.valueAxis.valueMin = 0
        if max(vals or [0]) <= 0:
            bc.valueAxis.valueMax = 1
        bc.valueAxis.labels.fontName, bc.valueAxis.labels.fontSize = FONT, 6.5
        bc.valueAxis.labelTextFormat = fmt
        bc.valueAxis.visibleGrid, bc.valueAxis.gridStrokeColor, bc.valueAxis.strokeColor = 1, LINE, LINE
        bc.bars[0].fillColor, bc.bars[0].strokeColor = BLUE, None
        bc.barLabelFormat = fmt
        bc.barLabels.nudge, bc.barLabels.fontName, bc.barLabels.fontSize, bc.barLabels.boxAnchor = 5, FONT, 7, 'w'
        d.add(bc)
        return d

    def vbar(names, values, width, height, fmt):
        d = Drawing(width, height)
        bc = VerticalBarChart()
        bc.x, bc.y, bc.width, bc.height = 36, 22, width - 46, height - 34
        vals = [float(v or 0) for v in values]
        bc.data = [vals]
        bc.categoryAxis.categoryNames = names
        bc.categoryAxis.labels.fontName, bc.categoryAxis.labels.fontSize = FONT, 6.5
        bc.categoryAxis.labels.angle, bc.categoryAxis.labels.boxAnchor, bc.categoryAxis.labels.dy = 0, 'n', -3
        bc.categoryAxis.strokeColor = LINE
        bc.valueAxis.valueMin = 0
        if max(vals or [0]) <= 0:
            bc.valueAxis.valueMax = 1
        bc.valueAxis.labels.fontName, bc.valueAxis.labels.fontSize = FONT, 6.5
        bc.valueAxis.visibleGrid, bc.valueAxis.gridStrokeColor, bc.valueAxis.strokeColor = 1, LINE, LINE
        bc.bars[0].fillColor, bc.bars[0].strokeColor = BLUE, None
        bc.barLabelFormat = fmt
        bc.barLabels.nudge, bc.barLabels.fontName, bc.barLabels.fontSize = 4, FONT, 6.5
        d.add(bc)
        return d

    eur_fmt = lambda v: f'{int(round(v)):,}'.replace(',', '.') + ' €'
    int_fmt = lambda v: f'{int(round(v))}'

    story = []
    ev = data.event or {}
    story.append(P(ctx['title'], 'h1'))
    story.append(P(f"{ev.get('organizer') or 'Rotary Club Stralsund'} · Event „{ev.get('title') or ''}“ ({ev.get('slug') or '–'}) · "
                   f"Datenquelle: {data.source} · Datenstand {fmt_dt(stats['data_until'], False) or '–'} · erstellt {fmt_dt(ctx['generated_at'], False)}", 'small'))
    story.append(Spacer(1, 6))

    # KPI-Kacheln
    sbs, scs = stats['sessions_by_status'], stats['sessions_clean_by_status']
    top_p = stats['projects_ranked'][0] if stats['projects_ranked'] else None
    top_c = max(stats['companies'], key=lambda c: c['leads_clean']) if stats['companies'] else None
    kpis = [
        (str(stats['leads_clean']), 'Leads bereinigt (abgeschlossen, ohne Test)'),
        (str(stats['leads_total']), f"Lead-Datensätze gesamt (davon {stats['leads_test']} Test, {stats['leads_check']} Prüfen, {stats['leads_pending']} unvollständig)"),
        (str(stats['sessions_total']), f"Sitzungen gesamt ({sbs.get('completed', 0)} abgeschl. / {sbs.get('aborted', 0)} abgebr. / {sbs.get('open', 0)} offen)"),
        (fmt_pct(stats['conversion']) or '–', 'Abschlussquote bereinigt (abgeschlossene ÷ alle Sitzungen ohne Test)'),
        (fmt_eur(stats['budget_total_clean']), 'verteiltes Budget (bereinigte Leads)'),
        (top_p['title'] if top_p else '–', f"Projekt mit höchster Summe ({fmt_eur(top_p['sum_clean'])}, {fmt_pct(top_p['share_clean'])})" if top_p else ''),
    ]
    cells = [[P(v, 'kpi_v'), P(l, 'kpi_l')] for v, l in kpis]
    kt = Table([[Table([[c] for c in cells[i]], colWidths=[avail_p / 3 - 6]) for i in range(j, min(j + 3, len(cells)))]
                for j in range(0, len(cells), 3)], colWidths=[avail_p / 3] * 3)
    kt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), SURF), ('BOX', (0, 0), (-1, -1), 0.4, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.4, colors.white),
                            ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    story.append(kt)

    story.append(P('1. Zusammenfassung', 'h2'))
    days_txt = ', '.join(f'{WEEKDAYS[d.weekday()]} {fmt_date(d)}' for d in ctx['event_days']) or '–'
    story.append(P(
        f"Grundlage sind alle Datensätze der App-Datenbank: {stats['leads_total']} Lead-Datensätze und {stats['sessions_total']} Sitzungen "
        f"(Durchläufe am Kiosk inkl. Abbrüche). Als Messetage gelten {days_txt}"
        f"{' (automatisch aus der Datendichte ermittelt)' if ctx['event_days_auto'] else ''}. "
        f"{stats['leads_test']} Datensätze wurden als Testläufe markiert, {stats['leads_check']} stehen auf „Prüfen“; "
        f"beide bleiben vollständig im Anhang und in der Excel-Datei sichtbar. Bereinigt ergeben sich {stats['leads_clean']} abgeschlossene Leads "
        f"mit insgesamt {fmt_eur(stats['budget_total_clean'])} verteiltem Budget."
        + (f" Das meistgewählte Glücksrad-Ergebnis ist „{top_c['name']}“ mit {top_c['leads_clean']} Leads." if top_c and top_c['leads_clean'] else '')))
    if data.warnings:
        for w in data.warnings:
            story.append(P('Hinweis: ' + w, 'small'))

    # 2. Projekte
    sec2 = [P('2. Projektauswahl – Budgetverteilung (bereinigte Leads)', 'h2'),
            P('Jeder Teilnehmer verteilt das volle Budget frei auf die Projekte. Summe = verteilte Euro über alle bereinigten Leads; '
              'Stimmen = Leads mit Betrag > 0; Favorit = eindeutig höchster Betrag eines Leads.', 'small')]
    pr = stats['projects_ranked']
    if pr:
        sec2 += [hbar([p['title'] for p in pr], [p['sum_clean'] for p in pr], avail_p, 34 + 22 * len(pr), eur_fmt), Spacer(1, 4)]
    story.append(KeepTogether(sec2))
    story.append(grid_table(
        ['Rang', 'Projekt', 'Summe', 'Anteil', 'Stimmen', 'Ø je Lead', 'Ø je Stimme', 'Favorit', 'Summe inkl. Test', 'Summe alle Sitzungen'],
        [[p['rank'], p['title'], fmt_eur(p['sum_clean']), fmt_pct(p['share_clean']), p['votes_clean'], fmt_eur(p['avg_clean']), fmt_eur(p['avg_voter']),
          p['top_count'], fmt_eur(p['sum_all']), fmt_eur(p['sum_sessions_all'])] for p in pr],
        [11 * mm, 42 * mm, 19 * mm, 14 * mm, 14 * mm, 17 * mm, 17 * mm, 14 * mm, 18 * mm, 16 * mm], align_right=(2, 3, 4, 5, 6, 7, 8, 9)))
    story.append(P('„Summe alle Sitzungen“ ist das Stimmungsbild aller Durchläufe inkl. Abbrüche ohne Kontaktdaten – nicht zu den Lead-Summen addieren.', 'small'))

    # 3. Betriebe
    sec3 = [P('3. Glücksrad – Ergebnis je Betrieb', 'h2')]
    cs = sorted(stats['companies'], key=lambda c: -c['leads_clean'])
    if cs:
        sec3 += [hbar([c['name'] for c in cs], [c['leads_clean'] for c in cs], avail_p, 34 + 22 * len(cs), int_fmt), Spacer(1, 4)]
    story.append(KeepTogether(sec3))
    story.append(grid_table(['Betrieb', 'Leads bereinigt', 'Anteil', 'Leads inkl. Test', 'Sitzungen mit Auswahl'],
                            [[c['name'], c['leads_clean'], fmt_pct(c['share_clean']), c['leads_all'], c['sessions']] for c in cs],
                            [60 * mm, 28 * mm, 22 * mm, 28 * mm, 34 * mm], align_right=(1, 2, 3, 4)))

    # 4. Sitzungen
    story.append(P('4. Sitzungen – Trichter und Abbrüche (bereinigt)', 'h2'))
    f = stats['funnel']
    dc, da = stats['duration_completed'], stats['duration_aborted']
    story.append(P(
        f"{stats['sessions_clean']} Sitzungen ohne Testläufe: {scs.get('completed', 0)} abgeschlossen, {scs.get('aborted', 0)} abgebrochen, "
        f"{scs.get('open', 0)} offen. Abschlussquote {fmt_pct(stats['conversion']) or '–'}. "
        + (f"Median-Dauer abgeschlossener Durchläufe {dc['median']:.1f} Min. (Ø {dc['mean']:.1f}, max. {dc['max']:.1f}); " if dc['n'] else '')
        + (f"abgebrochene Durchläufe im Median {da['median']:.1f} Min." if da['n'] else '')))
    story.append(grid_table(['Schritt', 'Erreicht', 'Anteil', 'Abgebrochen hier', 'Offen hier'],
                            [[x['label'], x['reached'], fmt_pct(x['share']), x['aborted_here'], x['open_here']] for x in f],
                            [50 * mm, 25 * mm, 25 * mm, 35 * mm, 30 * mm], align_right=(1, 2, 3, 4)))
    ar = stats['abort_reasons']
    if ar:
        story.append(P('Abbruchgründe: ' + ', '.join(f'{ABORT_LABELS.get(k, k)} {v}' for k, v in sorted(ar.items(), key=lambda x: -x[1])), 'small'))

    # 5. Zeitverlauf
    story.append(P('5. Zeitverlauf', 'h2'))
    tl = stats['timeline']
    story.append(grid_table(['Datum', 'Messetag', 'Sitzungen', 'abgeschl.', 'abgebr.', 'offen', 'Leads alle', 'Leads bereinigt', 'Test', 'Prüfen'],
                            [[f"{WEEKDAYS[t['date'].weekday()]} {fmt_date(t['date'])}", 'ja' if t['event_day'] else '', t.get('sessions', 0),
                              t.get('sessions_completed', 0), t.get('sessions_aborted', 0), t.get('sessions_open', 0), t.get('leads', 0),
                              t.get('leads_clean', 0), t.get('leads_test', 0), t.get('leads_check', 0)] for t in tl],
                            [28 * mm, 16 * mm, 18 * mm, 18 * mm, 18 * mm, 16 * mm, 18 * mm, 22 * mm, 14 * mm, 14 * mm], align_right=range(2, 10)))
    hourly = stats['hourly']
    for d in ctx['event_days']:
        hs = [h for h in hourly if h['date'] == d]
        if hs:
            story.append(P(f'Bereinigte Leads je Stunde am {WEEKDAYS[d.weekday()]} {fmt_date(d)}', 'h3'))
            story.append(vbar([f"{h['hour']:02d}" for h in hs], [h.get('leads_clean', 0) for h in hs], avail_p, 110, int_fmt))

    # 6. Test-Markierung
    story.append(P('6. Test-Markierung', 'h2'))
    story.append(P(
        'Jeder Datensatz erhält einen Score aus Indizien: außerhalb der Messetage (+3), außerhalb der Messezeit '
        f"{ctx['hours_label']} (+2), Name/E-Mail/Telefon wirkt wie Testeingabe (+2 je), E-Mail oder Domain eines bekannten Testers (+3), "
        'Treffer in der Tester-Liste (+2), abweichendes Gerät gegenüber dem Messe-Tablet (+1). Mehrfach verwendete E-Mails oder '
        'Telefonnummern werden nur als Hinweis (Dublette) ausgewiesen und zählen nicht zum Score. '
        'Score ≥ 3 = „Test“, 1–2 = „Prüfen“. Die Markierung ist ein Vorschlag – die Entscheidung bleibt beim Team; nichts wurde gelöscht. '
        f"Tester-Liste: {', '.join(ctx['testers'] + ctx['tester_emails'] + ['@' + d for d in ctx['tester_domains']]) or '–'}. "
        f"Erkanntes Messe-Gerät: {ctx.get('majority_device') or 'nicht ermittelbar'}."))
    flagged = sorted([l for l in data.leads if l.klass != KLASS_LEAD or l.reasons],
                     key=lambda l: (-l.score, l.created_at or datetime.min.replace(tzinfo=TZ)))
    if flagged:
        story.append(grid_table(['Einstufung', 'Score', 'Erstellt', 'Name', 'E-Mail', 'Gründe'],
                                [[l.klass, l.score, fmt_dt(l.created_at, False), l.name, l.email, '; '.join(t for _, t in l.reasons)] for l in flagged],
                                [18 * mm, 11 * mm, 24 * mm, 32 * mm, 42 * mm, avail_p - 127 * mm], klass_idx=0))
    else:
        story.append(P('Keine Datensätze markiert.', 'body'))

    # Anhang A – Leads
    story.append(NextPageTemplate('L'))
    story.append(PageBreak())
    story.append(P('Anhang A – Alle Leads (chronologisch, mit Markierung)', 'h2'))
    story.append(P('Rot = Test, Gelb = Prüfen. Beträge in Euro je Projekt. Vollständige Spalten (Einwilligung, Gerät, IDs) in der Excel-Datei.', 'small'))
    projects = data.projects
    n_p = len(projects)
    fixed = [8 * mm, 20 * mm, 18 * mm, 20 * mm, 38 * mm, 26 * mm, 24 * mm]
    rest = avail_l - sum(fixed) - 19 * mm - 38 * mm
    pw_each = max(12 * mm, rest / max(n_p, 1)) if n_p else 0
    widths = fixed + [pw_each] * n_p + [19 * mm, 38 * mm]
    rows = []
    for i, l in enumerate(sorted(data.leads, key=lambda l: (l.created_at or datetime.min.replace(tzinfo=TZ))), 1):
        rows.append([i, fmt_dt(l.created_at, False), l.first_name, l.last_name, l.email, l.phone, l.company or '',
                     *[(f'{l.allocations.get(p.slug, 0):,}'.replace(',', '.') if l.allocations.get(p.slug) else '–') for p in projects],
                     l.klass if l.status == 'completed' else f'{l.klass} · unvollst.', '; '.join(t for _, t in l.reasons)])
    story.append(grid_table(['Nr', 'Erstellt', 'Vorname', 'Name', 'E-Mail', 'Telefon', 'Glücksrad', *[p.title for p in projects], 'Einstufung', 'Gründe'],
                            rows, widths, klass_idx=7 + n_p, align_right=range(7, 7 + n_p)))

    # Anhang B – Sitzungen
    story.append(PageBreak())
    story.append(P('Anhang B – Alle Sitzungen (chronologisch, inkl. Abbrüche)', 'h2'))
    story.append(P('Sitzungen sind anonym; „Lead“ nennt den verknüpften Kontakt bei abgeschlossenen Durchläufen. Beträge = letzter gespeicherter Zwischenstand.', 'small'))
    by_lead = {l.id: l for l in data.leads}
    fixed = [8 * mm, 20 * mm, 20 * mm, 22 * mm, 20 * mm, 18 * mm, 10 * mm, 26 * mm]
    rest = avail_l - sum(fixed) - 30 * mm - 17 * mm
    pw_each = max(12 * mm, rest / max(n_p, 1)) if n_p else 0
    widths = fixed + [pw_each] * n_p + [30 * mm, 17 * mm]
    rows = []
    for i, s in enumerate(sorted(data.sessions, key=lambda s: (s.created_at or datetime.min.replace(tzinfo=TZ))), 1):
        lead = by_lead.get(s.lead_id) if s.lead_id else None
        rows.append([i, fmt_dt(s.created_at, False), fmt_dt(s.ended_at, False), STATUS_LABELS.get(s.status, s.status), STEP_LABELS.get(s.last_step, s.last_step),
                     ABORT_LABELS.get(s.abort_reason or '', s.abort_reason or ''), '' if s.duration_min is None else f'{s.duration_min:.1f}'.replace('.', ','),
                     s.company or '', *[(f'{s.allocations.get(p.slug, 0):,}'.replace(',', '.') if s.allocations.get(p.slug) else '–') for p in projects],
                     lead.name if lead else '', s.klass])
    story.append(grid_table(['Nr', 'Gestartet', 'Beendet', 'Status', 'Letzter Schritt', 'Abbruch', 'Min', 'Glücksrad', *[p.title for p in projects], 'Lead', 'Einstufung'],
                            rows, widths, klass_idx=9 + n_p, align_right=range(8, 8 + n_p)))

    doc.build(story)


# ------------------------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------------------------
def parse_hours(s):
    m = re.fullmatch(r'(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})', s.strip())
    if not m:
        raise argparse.ArgumentTypeError('Format HH:MM-HH:MM erwartet, z. B. 07:00-19:00')
    a, b, c, d = map(int, m.groups())
    return a * 60 + b, c * 60 + d


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_argument_group('Datenquelle')
    src.add_argument('--dump-dir', help='Ordner mit JSON-Dateien je Tabelle (dump_db.mjs <ordner>)')
    src.add_argument('--dump-file', help='Kombinierter JSON-Dump (dump_db.mjs -)')
    src.add_argument('--leads-csv', help='Admin-Export /admin/export.csv?status=all')
    src.add_argument('--sessions-csv', help='Admin-Export /admin/sessions.csv')
    src.add_argument('--event-config', default=str(Path(__file__).resolve().parents[2] / 'config' / 'event.json'),
                     help='config/event.json (für CSV-Modus: Slugs, Beschreibungen, Einwilligungstext)')
    src.add_argument('--event-slug', help='Bei mehreren Events im Dump: dieses auswerten')
    out = ap.add_argument_group('Ausgabe')
    out.add_argument('--out-dir', default='report')
    out.add_argument('--basename', help='Dateiname ohne Endung (Standard: Vocatium-Lead-Report-<Datum>)')
    out.add_argument('--title', default='Ein Tag Chef sein – Lead-Report Vocatium')
    out.add_argument('--no-xlsx', action='store_true')
    out.add_argument('--no-pdf', action='store_true')
    mk = ap.add_argument_group('Test-Markierung')
    mk.add_argument('--event-days', help='Messetage, kommagetrennt (YYYY-MM-DD oder DD.MM.YYYY). Standard: automatisch')
    mk.add_argument('--hours', type=parse_hours, default=(7 * 60, 19 * 60), help='Messezeit HH:MM-HH:MM (Standard 07:00-19:00)')
    mk.add_argument('--tester', action='append', default=[], help='Name/E-Mail-Fragment eines Testers (mehrfach möglich), z. B. --tester stefan')
    mk.add_argument('--tester-email', action='append', default=[], help='Exakte E-Mail eines Testers (mehrfach möglich)')
    mk.add_argument('--tester-domain', action='append', default=[], help='E-Mail-Domain von Testern, z. B. pentalink.de (mehrfach möglich)')
    args = ap.parse_args(argv)

    if args.dump_dir or args.dump_file:
        if args.leads_csv or args.sessions_csv:
            ap.error('Entweder JSON-Dump oder CSV-Dateien angeben, nicht beides.')
        data = load_dump(args.dump_dir, args.dump_file, args.event_slug)
    elif args.leads_csv or args.sessions_csv:
        data = load_csv(args.leads_csv, args.sessions_csv, args.event_config)
    else:
        ap.error('Keine Datenquelle angegeben (--dump-dir, --dump-file oder --leads-csv/--sessions-csv).')

    if args.event_days:
        event_days, auto = sorted({parse_date(x) for x in args.event_days.split(',') if x.strip()}), False
    else:
        event_days, auto = detect_event_days(data), True
    opts = {'event_days': event_days, 'hours': args.hours, 'testers': args.tester, 'tester_emails': args.tester_email,
            'tester_domains': args.tester_domain}
    extra = classify(data, opts)
    stats = compute_stats(data, event_days)

    generated_at = datetime.now(TZ)
    h1, h2 = args.hours
    ctx = {
        'title': args.title, 'generated_at': generated_at, 'event_days': event_days, 'event_days_auto': auto,
        'hours_label': f'{h1 // 60:02d}:{h1 % 60:02d}–{h2 // 60:02d}:{h2 % 60:02d} Uhr', 'testers': args.tester,
        'tester_emails': args.tester_email, 'tester_domains': args.tester_domain, **extra,
    }
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = args.basename or f'Vocatium-Lead-Report-{generated_at:%Y-%m-%d}'
    written = []
    if not args.no_xlsx:
        p = out_dir / f'{base}.xlsx'
        write_xlsx(str(p), data, stats, ctx)
        written.append(p)
    if not args.no_pdf:
        p = out_dir / f'{base}.pdf'
        write_pdf(str(p), data, stats, ctx)
        written.append(p)
    meta = {
        'generated_at': generated_at.isoformat(), 'source': data.source, 'event': data.event, 'event_days': [d.isoformat() for d in event_days],
        'event_days_auto': auto, 'testers': args.tester, 'tester_emails': args.tester_email, 'tester_domains': args.tester_domain,
        'counts': {k: stats[k] for k in ('leads_total', 'leads_completed', 'leads_pending', 'leads_clean', 'leads_test', 'leads_check',
                                          'sessions_total', 'sessions_clean', 'budget_total_clean')},
        'projects': [{k: v for k, v in p.items()} for p in stats['projects_ranked']],
        'companies': stats['companies'], 'warnings': data.warnings, 'dump_meta': data.meta,
    }
    (out_dir / f'{base}.meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2, default=str), encoding='utf-8')

    print(f"Quelle: {data.source}")
    print(f"Messetage: {', '.join(fmt_date(d) for d in event_days) or '–'}{' (automatisch)' if auto else ''}")
    print(f"Leads: {stats['leads_total']} gesamt, {stats['leads_clean']} bereinigt, {stats['leads_test']} Test, {stats['leads_check']} Prüfen, "
          f"{stats['leads_pending']} unvollständig")
    print(f"Sitzungen: {stats['sessions_total']} gesamt ({stats['sessions_by_status']})")
    for p in stats['projects_ranked']:
        print(f"  {p['rank']}. {p['title']}: {fmt_eur(p['sum_clean'])} ({fmt_pct(p['share_clean'])}, {p['votes_clean']} Stimmen)")
    for w in data.warnings:
        print(f'Hinweis: {w}')
    for p in written:
        print(f'Geschrieben: {p}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
