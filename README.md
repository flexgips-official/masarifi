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
   Optional `GEMINI_MODEL` (Standard: `gemini-2.5-flash,gemini-flash-latest`).
3. **Hosting**: GitHub → *Settings → Pages* → *Deploy from a branch* → `main` / `/docs` → *Save*.
   Jeder Push auf `main` wird automatisch veröffentlicht (Adresse: `https://flexgips-official.github.io/masarifi/`).
   Alternativ: Vercel (`vercel.json`, Ausgabeordner `docs`) oder Cloudflare Pages / Netlify mit Ausgabeordner `docs`.
4. **Supabase** → *Authentication → URL Configuration* → *Site URL* = Adresse der App (z. B. `https://flexgips-official.github.io/masarifi/`).
5. App auf dem Handy öffnen → „إنشاء الحساب“ → E-Mail bestätigen → anmelden → „تثبيت التطبيق“ / Zum Startbildschirm hinzufügen.

## Entwicklung

```bash
node --test tests/lib.test.mjs     # Unit-Tests (Berechnungen, Zeiträume, CSV, …)
python3 tests/ui_test.py           # End-to-End-Test im Headless-Chrome mit simuliertem Backend
```

Änderungen an der Datenbank: neue Datei in `supabase/migrations/`. Edge Function: `supabase/functions/analyze/index.ts`.
Bei Änderungen an `docs/` die Versionsnummer in `docs/config.js` und `CACHE` in `docs/sw.js` erhöhen.
