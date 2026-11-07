# مصاريفي (Masarifi)

تطبيق خاص لتسجيل المصاريف الشخصية والعائلية بالصوت وبصور الفواتير. الذكاء الاصطناعي يفرز كل شيء،
ويحسب الكميات (مثلاً: دخان 30 علبة = 300 €)، ويعرض تقارير أسبوعية وشهرية وسنوية.

> Private expense tracker (Arabic, RTL, installable PWA). Voice notes + receipt photos → Gemini → structured
> expenses in Supabase. Separate from all FlexGips company systems.

## البنية / Architecture

| Teil | Technik | Ort |
|---|---|---|
| App (Frontend) | statische Web-App (HTML/CSS/JS, PWA), kein Build-Schritt | `docs/` → GitHub Pages (Branch `main`, Ordner `/docs`) |
| Datenbank, Login, Belegfotos | Supabase (Projekt `masarifi`, Frankfurt, Free Plan) | `supabase/migrations/` |
| KI-Analyse | Supabase Edge Function `analyze` → Google Gemini (paid tier) | `supabase/functions/analyze/` |
| Ortsname aus GPS | OpenStreetMap Nominatim (im Browser) | – |

- Supabase-Projekt: `gnupewfpiboaodsiwmnt` (`https://gnupewfpiboaodsiwmnt.supabase.co`)
- Nur **ein** Konto kann sich registrieren (Trigger `only_one_user`), alle Tabellen mit Row Level Security.
- Kostenbremse: max. 500 KI-Analysen pro Monat (`ai_tick()` in der Datenbank).
- Offline: Aufnahmen werden im Handy (IndexedDB) gespeichert und automatisch analysiert, sobald wieder Internet da ist.

## Einrichtung (einmalig)

1. **Gemini-Schlüssel**: <https://aistudio.google.com/apikey> → API-Schlüssel erstellen → Abrechnung (Billing) aktivieren
   (in der EU ist der kostenlose Tarif nicht nutzbar; mit Billing werden die Daten nicht zum Training verwendet).
2. **Supabase** → Projekt `masarifi` → *Edge Functions → Secrets* → `GEMINI_API_KEY` = Schlüssel.
   Optional `GEMINI_MODEL` (Standard: `gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-lite-latest,gemini-flash-latest`).
   Neue Schlüssel aus AI Studio beginnen mit `AQ.` – das ist normal.
3. **Hosting**: GitHub → *Settings → Pages* → *Deploy from a branch* → `main` / `/docs` → *Save*.
   Jeder Push auf `main` wird automatisch veröffentlicht (Adresse: `https://flexgips-official.github.io/masarifi/`).
   Alternativ möglich: Netlify / Cloudflare Pages / Vercel mit Ausgabeordner `docs` (kein Build-Schritt).
4. **Supabase** → *Authentication → URL Configuration* → *Site URL* = Adresse der App (`https://flexgips-official.github.io/masarifi/`).
5. **Supabase** → *Authentication → Sign In / Providers* → *User Signups*: **Confirm email = aus**, *Allow new users to sign up* = an.
   Grund: Der eingebaute Mail-Dienst von Supabase sendet nur an E-Mail-Adressen des Organisations-Teams
   (sonst Fehler `email_address_not_authorized`). Da ohnehin nur ein einziges Konto möglich ist (Trigger `only_one_user`),
   bringt die Bestätigung hier keinen Sicherheitsgewinn.
6. App auf dem Handy öffnen → „أول مرة؟ إنشاء الحساب“ → E-Mail + Passwort → man ist sofort angemeldet →
   Chrome-Menü ⋮ → „App installieren“ / „Zum Startbildschirm hinzufügen“.

## Betrieb & Wartung

**Status:** live seit 07.11.2026 – Konto angelegt, App auf dem Handy installiert, erster Sprachtest erfolgreich.

### Weitere Geräte (PC, Tablet)
Dieselbe Adresse im Browser öffnen und mit demselben Konto über „دخول“ anmelden. Die Daten liegen in Supabase
und sind auf allen Geräten gleich. Nicht „إنشاء الحساب“ wählen – die Registrierung ist nach dem ersten Konto geschlossen.

### Daten sichern
- Supabase Free Plan bietet **keine herunterladbaren Datenbank-Backups**. Eigene Sicherung (z. B. monatlich):
  App → „التقارير“ → Zeitraum („هذه السنة“ oder benutzerdefiniert) → „تصدير إلى Excel (CSV)“.
  Die CSV enthält jeden Posten mit Datum, Uhrzeit, Geschäft, Ort, Zweck, Kategorie, Menge, Einheit, Preis.
- Belegfotos liegen im privaten Storage-Bucket `receipts` (Supabase → Storage).
- Code, Datenbank-Schema (`supabase/migrations/`) und KI-Funktion (`supabase/functions/analyze/`) liegen in diesem Repo.

### Automatische Pausierung (Free Plan)
- Supabase pausiert Free-Projekte, wenn 7 Tage lang zu wenig Datenbank-Aktivität da ist (Warn-Mail ca. eine Woche vorher).
  Normale, tägliche Nutzung der App reicht aus.
- Wenn die App plötzlich keine Verbindung bekommt: <https://supabase.com/dashboard> → Projekt `masarifi` → **Resume project**.
  Möglich bis 90 Tage nach der Pause; Daten und Einstellungen bleiben erhalten.

### KI: Kosten, Guthaben, Schlüssel
- Gemessen am 07.11.2026 mit Gemini 3.5 Flash-Lite: Text/Sprache ca. 1.900 Tokens ≈ 0,002 €, Belegfoto ca. 3.500 Tokens
  ≈ 0,003 € pro Analyse, Antwortzeit 1,5–3 s.
- Abrechnung über Prepaid-Guthaben in Google AI Studio (*Abrechnung*), automatisches Aufladen aus. Ist das Guthaben leer,
  meldet die App „رصيد Gemini المدفوع مسبقاً انتهى“ → in AI Studio aufladen. Guthaben verfällt 12 Monate nach dem Kauf.
- Schlüssel austauschen: AI Studio → neuen Schlüssel erstellen → Supabase *Edge Functions → Secrets* → `GEMINI_API_KEY`
  überschreiben → alten Schlüssel löschen. Kein neues Deployment nötig.
- Monatslimit 500 Analysen: `ai_tick()` in `supabase/migrations/001_init.sql` und `AI_MONTHLY_LIMIT` in `docs/config.js`.

### KI-Qualität prüfen
- Die Regeln für die KI stehen in `SYSTEM` in `supabase/functions/analyze/index.ts`. Nach Änderungen die Funktion neu
  deployen (`supabase functions deploy analyze --no-verify-jwt` oder über das Dashboard). Die Funktion prüft das Konto selbst
  über `ai_tick()`, deshalb ist die JWT-Prüfung des Gateways aus.
- `tests/fixtures/receipt_muster.jpg` ist ein synthetischer Testbeleg (fiktives Geschäft). Erwartet: 9 Posten, Summe 26,62 €,
  Pfand bei den Getränken, Rabatt als negativer Posten, Zahlung „بطاقة“, Datum 07.11.2026 08:15.
- Die Edge Function `selftest` ist nur noch ein leerer 404-Platzhalter und kann im Dashboard gelöscht werden.

| Fehlercode | Bedeutung | Abhilfe |
|---|---|---|
| `no_key` | `GEMINI_API_KEY` fehlt | Secret in Supabase setzen |
| `gemini_credits` | Prepaid-Guthaben aufgebraucht | in AI Studio aufladen |
| `gemini_billing` | kein Billing am Schlüssel | Billing in AI Studio aktivieren |
| `gemini_key` | Schlüssel ungültig/gesperrt | neuen Schlüssel als Secret setzen |
| `gemini_quota` | kurzzeitig zu viele Anfragen | eine Minute warten |
| `limit` | 500 Analysen im Monat erreicht | nächster Monat oder Limit erhöhen |
| `auth` | nicht angemeldet / fremdes Konto | in der App neu anmelden |

## Entwicklung

```bash
node --test tests/lib.test.mjs     # Unit-Tests (Berechnungen, Zeiträume, CSV, …)
python3 tests/ui_test.py           # End-to-End-Test im Headless-Chrome mit simuliertem Backend
```

Änderungen an der Datenbank: neue Datei in `supabase/migrations/`. Edge Function: `supabase/functions/analyze/index.ts`.
Bei Änderungen an `docs/` die Versionsnummer in `docs/config.js` und `CACHE` in `docs/sw.js` erhöhen.
