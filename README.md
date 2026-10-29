# Ein Tag Chef sein – Lead-App

Messe-App (Rotary Club Stralsund, Vocatium) zum Einsammeln von Leads.
Node.js (Fastify) · PostgreSQL · Deploy auf Railway. Es werden keine E-Mails versendet.

## Ablauf

| Schritt | Inhalt |
|---|---|
| 1 · Budget | 10.000 € frei auf bis zu 10 Projekte verteilen (Standard: 5). Regler, ±-Buttons, „Rest hierhin“. Ist das Budget aufgebraucht, werden die anderen Projekte beim Hochziehen proportional gekürzt. |
| 2 · Glücksrad | Ergebnis des (manuell gedrehten) Glücksrads wählen (5 Betriebe), Vorname, Name, Telefon, E-Mail, Einwilligung. Mit `VIRTUAL_WHEEL=true` kommt davor eine Extra-Seite mit virtuellem Glücksrad (gewinnt immer, Ergebnis wird automatisch übernommen, Auswahlfeld entfällt). |
| 3 · Fertig | Lead wird direkt nach den Kontaktdaten abgeschlossen. Diplom + Zusammenfassung am Bildschirm. Kiosk-Reset. |

Optional: SMS-Verifizierung (6-stelliger Code) per `VERIFY_PHONE=true` als Zwischenschritt vor „Fertig“ aktivierbar.

**Sitzungen:** Jeder Durchlauf wird ab dem ersten Schritt laufend in der DB gespeichert (Tabelle `sessions`: letzter Schritt, Budgetverteilung, Glücksrad-Ergebnis) – auch wenn abgebrochen wird. Kiosk-Reset/Inaktivität markiert die Sitzung als `aborted`, ein abgeschlossener Lead als `completed`; Sitzungen ohne Abschluss (z. B. Browser geschlossen) bleiben `open`. Bewusst **ohne personenbezogene Daten** – Kontaktdaten werden erst mit Einwilligung als Lead gespeichert.

## Konfiguration

**Inhalte** (Projekte, Betriebe, Texte, Budget): `config/event.json`.
Wird beim Start validiert und in die DB synchronisiert. Identität über `slug` – Titel ändern ist gefahrlos,
entfernte Einträge werden deaktiviert (nicht gelöscht). Projektplakate: `imageUrl` (z. B. `/assets/projects/end-polio-now.webp`), `imageAlt`, `label` (Kategorie-Chip) und `aiGenerated` (blendet „KI-generierte Inhalte“ unter dem Plakat ein). Tipp auf das Plakat öffnet die Großansicht.
Neues Event (z. B. nächste Messe): neuen `slug` vergeben → Leads bleiben getrennt.

**Laufzeit** (Secrets, Provider): Umgebungsvariablen, siehe `.env.example`.

## Lokal starten

```bash
cp .env.example .env        # DATABASE_URL anpassen
npm install
npm run dev                 # http://localhost:3000
npm test
```

## Deploy auf Railway

1. Projekt anlegen → **PostgreSQL** hinzufügen → Service aus diesem GitHub-Repo.
2. Variablen am App-Service setzen:
   - `NODE_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `APP_SECRET` (≥ 32 Zeichen), `ADMIN_PASSWORD`
   - optional SMS: `VERIFY_PHONE=true` + `SMS_PROVIDER=twilio` + `TWILIO_*` **oder** `SMS_PROVIDER=seven` + `SEVEN_API_KEY`
3. Domain generieren. Migrationen laufen automatisch beim Start (Advisory-Lock, mehrinstanzfähig).
   Healthcheck: `/healthz`.

## Admin

`/admin` (HTTP Basic Auth, `ADMIN_USER`/`ADMIN_PASSWORD`): Live-Auswertung je Projekt und Betrieb.
`/admin/export.csv` (nur abgeschlossene) bzw. `?status=all` – Excel-kompatibel (`;`, UTF-8-BOM, eine Spalte je Projekt).
`/admin/sessions.csv`: alle Sitzungen inkl. Abbrüche (Status, letzter Schritt, Abbruchgrund, Budget, Glücksrad, ggf. Lead-ID).

## Sicherheit & Robustheit

- Zugriffstokens (und SMS-Codes) nur als HMAC in der DB; Vergleich zeitkonstant.
- SMS-Code (falls aktiv): 10 Min. gültig, max. 5 Versuche, 30 s Cooldown, max. 5 Codes/Stunde je Nummer.
- Bei aktivierter SMS-Verifizierung: nur Mobilnummern aus `SMS_ALLOWED_COUNTRIES` (Schutz vor SMS-Pumping). Ohne SMS: jede gültige Telefonnummer.
- Rate-Limits pro IP großzügig gewählt (Messe-WLAN = eine IP für viele Geräte).
- Strikte CSP, keine externen Ressourcen (Schriften lokal → DSGVO-konform, kein Google-Fonts-CDN).
- CSV-Export gegen Formel-Injection geschützt.
- Einwilligungstext und Zeitpunkt werden je Lead gespeichert.

## Struktur

```
config/event.json     Inhalte des Events
migrations/*.sql      DB-Schema (automatisch angewendet)
src/server.js         Bootstrap, Security-Header, Fehlerbehandlung
src/leads.js          Fachlogik: Lead, optionale SMS-Codes, Abschluss
src/sessions.js       Sitzungen: anonyme Zwischenstände inkl. Abbrüche
src/validation.js     Eingabeprüfung (Budget, Telefon, E-Mail)
src/providers/        SMS (Twilio/seven.io/Console)
src/routes/           API und Admin
public/               Frontend (Vanilla JS, kein Build), Budget-Logik in public/budget.js
```
