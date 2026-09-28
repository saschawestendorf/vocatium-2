# Ein Tag Chef sein – Lead-App

Messe-App (Rotary Club Stralsund, Vocatium) zum Einsammeln verifizierter Leads.
Node.js (Fastify) · PostgreSQL · Resend (E-Mail) · Deploy auf Railway.

## Ablauf

| Schritt | Inhalt |
|---|---|
| 1 · Budget | 10.000 € frei auf bis zu 10 Projekte verteilen (Standard: 5). Regler, ±-Buttons, „Rest hierhin“. Ist das Budget aufgebraucht, werden die anderen Projekte beim Hochziehen proportional gekürzt. |
| 2 · Glücksrad | Ergebnis des (manuell gedrehten) Glücksrads wählen (5 Betriebe), Vorname, Name, Telefon, E-Mail, Einwilligung. |
| 3 · Bestätigen | 6-stelliger Code per E-Mail. Daten korrigierbar, Code erneut anforderbar. (SMS-Verifizierung vorbereitet, per `VERIFY_PHONE=true` aktivierbar.) |
| 4 · Fertig | Diplom + Zusammenfassung am Bildschirm, Bestätigungs-E-Mail via Resend. Kiosk-Reset. |

## Konfiguration

**Inhalte** (Projekte, Betriebe, Texte, Budget): `config/event.json`.
Wird beim Start validiert und in die DB synchronisiert. Identität über `slug` – Titel ändern ist gefahrlos,
entfernte Einträge werden deaktiviert (nicht gelöscht). Projektbilder: `imageUrl` (z. B. `/assets/polio.jpg` in `public/assets/`).
Neues Event (z. B. nächste Messe): neuen `slug` vergeben → Leads bleiben getrennt.

**Laufzeit** (Secrets, Provider): Umgebungsvariablen, siehe `.env.example`.

## Lokal starten

```bash
cp .env.example .env        # DATABASE_URL anpassen
npm install
npm run dev                 # http://localhost:3000, Codes erscheinen im Log (console-Provider)
npm test
```

## Deploy auf Railway

1. Projekt anlegen → **PostgreSQL** hinzufügen → Service aus diesem GitHub-Repo.
2. Variablen am App-Service setzen:
   - `NODE_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `APP_SECRET` (≥ 32 Zeichen), `ADMIN_PASSWORD`
   - `RESEND_API_KEY`, `EMAIL_FROM` (Domain in Resend verifiziert, z. B. `chef@pentalink.cloud`) – Resend wird dann automatisch aktiv
   - optional SMS: `VERIFY_PHONE=true` + `SMS_PROVIDER=twilio` + `TWILIO_*` **oder** `SMS_PROVIDER=seven` + `SEVEN_API_KEY`
3. Domain generieren. Migrationen laufen automatisch beim Start (Advisory-Lock, mehrinstanzfähig).
   Healthcheck: `/healthz`.

## Admin

`/admin` (HTTP Basic Auth, `ADMIN_USER`/`ADMIN_PASSWORD`): Live-Auswertung je Projekt und Betrieb.
`/admin/export.csv` (nur abgeschlossene) bzw. `?status=all` – Excel-kompatibel (`;`, UTF-8-BOM, eine Spalte je Projekt).

## Sicherheit & Robustheit

- Codes und Zugriffstokens nur als HMAC in der DB; Vergleich zeitkonstant.
- Code: 10 Min. gültig, max. 5 Versuche, 30 s Cooldown, max. 5 Codes/Stunde je Adresse/Nummer.
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
src/leads.js          Fachlogik: Lead, Codes, Abschluss
src/validation.js     Eingabeprüfung (Budget, Telefon, E-Mail)
src/providers/        E-Mail (Resend/Console), SMS (Twilio/seven.io/Console)
src/routes/           API und Admin
public/               Frontend (Vanilla JS, kein Build), Budget-Logik in public/budget.js
```
