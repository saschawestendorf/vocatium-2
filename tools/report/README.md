# Lead-Report (Excel + PDF)

Erzeugt aus der App-Datenbank einen vollständigen Bericht für die Lead-Sammler:
Übersicht/Kennzahlen, alle Leads (einmal komplett, einmal bereinigt, einmal nur markierte),
alle Sitzungen inkl. Abbrüche, Budget je Projekt, Glücksrad je Betrieb, Zeitverlauf,
Stammdaten, Verifizierungen und eine Legende. Testläufe werden **markiert, nicht gelöscht**.

## 1. Daten holen

Es gibt zwei Wege – der Generator versteht beide.

**A) JSON-Dump direkt aus der Datenbank (vollständig, empfohlen)**

```bash
# lokal mit Verbindungs-URL (z. B. DATABASE_PUBLIC_URL, wenn auf Railway ein TCP-Proxy aktiv ist)
DATABASE_URL='postgresql://…' DATABASE_SSL=true node tools/report/dump_db.mjs dump

# oder im Railway-Container (nutzt dessen DATABASE_URL, nichts wird öffentlich):
railway ssh --service vocatium-2 -- node tools/report/dump_db.mjs - > dump.json
```

Der Dump enthält keine Token-/Code-Hashes.

**B) Admin-Exporte der laufenden App (ohne DB-Zugriff)**

Im Browser unter `/admin` (HTTP Basic Auth) herunterladen – oder:

```bash
curl -u admin:$ADMIN_PASSWORD -o leads.csv     'https://<domain>/admin/export.csv?status=all'
curl -u admin:$ADMIN_PASSWORD -o sitzungen.csv 'https://<domain>/admin/sessions.csv'
```

Weg B enthält keine Geräteinformation (User-Agent), keine Verifizierungen und keinen Einwilligungstext je Lead.

## 2. Report bauen

```bash
pip install -r tools/report/requirements.txt      # openpyxl, reportlab

python3 tools/report/build_report.py --dump-dir dump --out-dir report
python3 tools/report/build_report.py --dump-file dump.json --out-dir report
python3 tools/report/build_report.py --leads-csv leads.csv --sessions-csv sitzungen.csv --out-dir report
```

Ergebnis: `report/Vocatium-Lead-Report-<Datum>.xlsx`, `.pdf` und `.meta.json` (Parameter + Kennzahlen).

### Optionen für die Test-Markierung

| Option | Wirkung |
|---|---|
| `--event-days 2026-10-27,2026-10-28` | Messetage vorgeben (Standard: automatisch aus der Datendichte) |
| `--hours 08:00-17:00` | Messezeit; Einträge außerhalb bekommen +2 (Standard 07:00–19:00) |
| `--tester stefan` | Name-/E-Mail-Fragment eines Testers, +2 (mehrfach möglich) |
| `--tester-email stefan@firma.de` | exakte Tester-E-Mail, +3 |
| `--tester-domain pentalink.de` | Tester-Domain, +3 |
| `--event-slug vocatium-2026` | bei mehreren Events im Dump |
| `--no-pdf` / `--no-xlsx` | nur eine Ausgabe |

Score: außerhalb der Messetage +3 · außerhalb der Messezeit +2 · Name/E-Mail/Telefon wirkt wie Testeingabe +2 je ·
abweichendes Gerät gegenüber dem Messe-Tablet +1. Mehrfach verwendete E-Mail/Telefon wird nur als Hinweis ausgewiesen.
**≥ 3 = Test, 1–2 = Prüfen, 0 = Lead.** „Bereinigt“ = abgeschlossene Leads ohne „Test“.

Zeitangaben in Europe/Berlin. Die Ausgaben enthalten personenbezogene Daten – nicht ins Repository committen
(`report/`, `dump/` und `dump*.json` stehen in `.gitignore`).
