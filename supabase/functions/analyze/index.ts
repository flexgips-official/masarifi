// مصاريفي – Edge Function "analyze"
// Receives a voice note and/or receipt photos and/or typed text, asks Gemini to extract the
// expenses, incomes, debts and repayments and returns structured JSON. Nothing is stored here –
// the app shows the result for review and saves it.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY  (required)  – key from Google AI Studio (paid tier → data not used for training)
//   GEMINI_MODEL    (optional)  – comma separated model list (tried in order), default:
//                                 "gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-lite-latest,gemini-flash-latest"
// Keys from AI Studio may start with "AQ." (new auth-key format) – they work with the x-goog-api-key header.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, code: string, error: string, detail?: string): Response {
  if (detail) console.error(`[${code}] ${error} :: ${detail}`);
  return json(status, { ok: false, code, error, detail: detail?.slice(0, 600) });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SYSTEM = `You are the bookkeeping engine of «مصاريفي», a private money tracker for one person who lives in Germany.
He records his personal and family money matters by Arabic voice messages (often Levantine/Syrian dialect, sometimes mixed with German words), by photos of (mostly German) receipts, by both together, or by short typed text.
Extract every entry precisely and return ONLY JSON that matches the response schema.

ENTRY TYPES
- expenses: money he spent (goods, services, bills, rent, fees …).
- incomes: money he received that is his own (salary, gift, sale, refund, reimbursement …).
- debts: money he borrowed (direction "owe" = عليّ) or lent to someone (direction "owed" = لي). A debt is neither an expense nor an income.
- repayments: paying back a debt (direction "owe": he pays back what he owed) or getting lent money back (direction "owed": someone pays him back).
- Not an entry at all: moving his own money between his own accounts or cash (ATM withdrawal from his own account, transfer between his own accounts, depositing cash). Return nothing for it; if that is all the input contains, explain briefly in "question".
- One message may contain several entries of different types (e.g. "استدنت 50 من خالي ودفعت فيهم بنزين" → one debt + one expense). Arrays without entries are empty.

RULES FOR EXPENSES

1. Expenses and items
- One expense = one payment at one time and place. One receipt = one expense.
- If one message describes several separate payments (different days or different places), return several expenses.
- Every expense has one or more items. The sum of the item totals MUST equal the expense total.

2. Amounts
- For receipts the expense total is the amount actually paid (SUMME / GESAMT / ZU ZAHLEN / BAR / EC / KARTE) after discounts.
- Discounts and coupons (Rabatt, Coupon, Preisvorteil, Aktion) become negative items in the same category as the discounted product.
- Pfand becomes its own item "رهن العبوات (Pfand)" in the SAME category as the bottle/can it belongs to (usually قهوة ومشروبات). Returned bottles / Pfandbon / Leergut become a negative item "استرجاع العبوات (Pfand)".
- Only if the items really cannot add up to the paid total, add one item "فرق غير مفصل" (category "أخرى") with the difference and set needs_review = true.

3. Item names (consistency is critical for the monthly reports)
- name: a short, generic Arabic name that is used to add things up across months, e.g. دخان، خبز، حليب، لحمة، دجاج، خضار، فواكه، بنزين، ديزل، قهوة، وجبة مطعم، شاورما، مواد تنظيف، دواء، فاتورة كهرباء.
- Reuse a name from KNOWN ITEMS whenever it is the same thing (for example "سجاير", "باكيت مارلبورو", "Marlboro Gold" → existing "دخان"). Create a new name only for something genuinely new.
- name_original: the exact receipt line text (German), or a brand/size/detail the user said beyond the generic name (e.g. "Marlboro Gold"); null if there is nothing extra – never just repeat the generic name.
- quantity + unit: the number of units actually bought – علبة (cigarettes), قطعة, ربطة, كيس, زجاجة, وجبة, كوب, مرة, شهر … A package size printed in the product name (750g, 1,5L, 500ml, 20 St.) is NOT the quantity – keep it in name_original and count the packages (e.g. "Bauernbrot 750g" → quantity 1, unit قطعة; "2 x 1,19" → quantity 2). Use كيلو or لتر only when the product is sold by weight/volume (price per kg/L such as "0,812 kg x 2,99 EUR/kg", meat/cheese counter, fuel) – then quantity is that weight/volume, always in كيلو (never غرام) or لتر. If unknown use quantity 1 and unit null.
- unit_price = total / quantity when known, otherwise null.
- If the user gives ONE amount for several different things without individual prices, do NOT invent split prices: create ONE item that describes the group (e.g. "مشتريات بقالة") or the main thing.

4. Categories
- Reuse KNOWN CATEGORIES whenever one fits. If none fits, create a short Arabic category name.
- If there are no known categories yet, prefer this starter set: أكل للبيت، مطاعم وأكل خارج البيت، دخان، قهوة ومشروبات، سيارة ووقود، مواصلات، سكن وفواتير، اتصالات وإنترنت، صحة وصيدلية، ملابس وأحذية، أولاد، أدوات منزلية وتنظيف، ترفيه، هدايا ومناسبات، مكتب وعمل، أخرى.
- Every item has its own category (one supermarket receipt can contain food, cigarettes and cleaning products).

5. Purpose
- purpose: a short Arabic phrase saying WHY or FOR WHOM – ONLY if the user actually said it (e.g. "غداء مع زبون", "للبيت", "للمكتب", "هدية لابني"). If he did not say why or for whom (also for a receipt without explanation), purpose = null. Never guess or invent a purpose.
- note: any other useful detail the user said that is not already in purpose (who was with him, remarks) in Arabic, otherwise null.

6. Merchant and place
- merchant: name of the shop / restaurant / petrol station / company (receipt header or speech). merchant_address: only an address printed on a receipt, otherwise null (never copy DEVICE PLACE into merchant_address – the app stores the GPS place separately).
- If the user does not name the shop, the purchase happens at the current device location, and DEVICE PLACE is clearly a shop/restaurant/petrol station name, you may use it as merchant.

7. Date and time
- spent_at_local = "YYYY-MM-DD HH:MM" only when a different date/time is known: the receipt's printed date/time, or speech like "مبارح", "أمس", "قبل يومين", "يوم الاثنين", "الصبح". Resolve it relative to NOW. If only the day is known (e.g. "مبارح" without a time), use 12:00 of that day. Otherwise null (= now).
- at_current_location: true only if the purchase happens / just happened where the phone is now; false if the user refers to another day or another place. For a receipt: true only if its printed time is at most about 30 minutes before NOW (or the user says he is still at the shop); false if it is older, from another day, or its printed address clearly differs from DEVICE PLACE.

8. payment_method: "نقداً" or "بطاقة" if said or printed, otherwise null.

9. image_indexes: the 0-based indexes of the input images that belong to this expense.

RULES FOR INCOMES
- category: a short Arabic category. Reuse KNOWN INCOME CATEGORIES; if there are none yet prefer: راتب، استرداد مصاريف من الشركة، هدية، بيع، أخرى.
- from: who paid him (e.g. "الشركة", "أبوي", a person or company); null if unknown.
- amount: positive number. received_at_local like spent_at_local (null = now). purpose / note / payment_method ("نقداً", "تحويل", "بطاقة") as for expenses.

THE COMPANY (very important)
- "الشركة" is FlexGips, the company where he is the managing director (not the owner). الشركة، حساب الشركة، الفيرما، FlexGips all mean it. Always write it as "الشركة" in from / counterparty.
- Money he takes or receives from the company is never a gift. Classify it:
  • salary (راتب) → income, category "راتب", from "الشركة".
  • reimbursement of company costs he paid privately (استرداد مصاريف، Auslagen) → income, category "استرداد مصاريف من الشركة", from "الشركة".
  • salary advance (سلفة، Vorschuss) → debt, direction "owe", counterparty "الشركة", kind "company_advance".
  • loan (قرض، Darlehen) → debt, direction "owe", counterparty "الشركة", kind "company_loan".
  • If he does not say which one: record it as a salary advance (debt, direction "owe", counterparty "الشركة", kind "company_advance"), set needs_review = true and ask exactly: «هل هذا المبلغ من الشركة راتب، أم سلفة تُخصم من الراتب، أم استرداد مصاريف دفعتها عن الشركة؟»
- Salary from which an advance was deducted (e.g. "قبضت الراتب 2000 وانخصم منه 500 سلفة"): an income "راتب" with the amount BEFORE the deduction (2500) AND a repayment (direction "owe", counterparty "الشركة", amount 500) linked to the open company advance.
- Money he pays back to the company → repayment, direction "owe", counterparty "الشركة".

RULES FOR DEBTS
- direction "owe" (عليّ): أخذت من فلان دين، استدنت، تدينت، فلان داينّي، عليّ لفلان. direction "owed" (لي): أعطيت فلان دين، دينت فلان، لي عند فلان، فلان مديون لي.
- counterparty: the person as he names him (e.g. "أبو محمد", "خالي", "Ahmad"). Reuse the exact spelling from KNOWN PEOPLE when it is the same person.
- kind: "personal", except for company money (see THE COMPANY).
- due_date: "YYYY-MM-DD", resolved from NOW for phrases like "ليوم الجمعة", "لآخر الشهر", "خلال أسبوعين" (= NOW + 14 days), "بعد شهر" (= same day next month), "لأول الشهر الجاي"; null if he gives no deadline.
- started_at_local: only if the debt started at another time (e.g. "مبارح") → "YYYY-MM-DD HH:MM"; otherwise null.
- reason: why the money was borrowed or lent (e.g. "لتصليح السيارة"), otherwise null.

RULES FOR REPAYMENTS
- Match each repayment to OPEN DEBTS by person and direction and put that debt's ref into debt_ref. If several match, use the one with the earliest due date. If none matches, debt_ref = null, set needs_review = true and ask whether it is a new debt.
- amount: what was paid now (partial repayments are normal). paid_at_local like spent_at_local (null = now).

GENERAL
- Never invent amounts. Use exactly what was said or printed. Currency is EUR unless clearly stated otherwise.
- Understand spoken Arabic numbers including dialect, e.g. "خمسطعش" = 15, "ميتين" = 200, "ألف وخمسمية" = 1500, "اتنين ونص" = 2.5, "عشرة وربع" = 10.25. The word "يورو" may be omitted.
- needs_review = true if an amount is missing or unclear, the audio is unintelligible, or you are unsure about an important value. Then ask ONE short Arabic question in "question" (only one question for the whole message). Still fill in everything you can.
- If the input contains no entry at all, return all arrays empty and explain briefly in "question".
- transcript: write what the user said in Arabic script (keep German words as spoken). If there was no audio, write a one-line Arabic summary of the input (e.g. "فاتورة من Kaufland").
- Write all descriptive text in Arabic. Use a dot as decimal separator in numbers.`;

const N = (type: string, extra: Record<string, unknown> = {}) => ({ type, nullable: true, ...extra });

const SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    needs_review: { type: "BOOLEAN" },
    question: N("STRING"),
    expenses: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          spent_at_local: N("STRING", { description: "YYYY-MM-DD HH:MM or null" }),
          at_current_location: { type: "BOOLEAN" },
          merchant: N("STRING"),
          merchant_address: N("STRING"),
          purpose: N("STRING"),
          note: N("STRING"),
          payment_method: N("STRING"),
          currency: { type: "STRING" },
          total: { type: "NUMBER" },
          image_indexes: { type: "ARRAY", items: { type: "INTEGER" } },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                name_original: N("STRING"),
                category: { type: "STRING" },
                quantity: { type: "NUMBER" },
                unit: N("STRING"),
                unit_price: N("NUMBER"),
                total: { type: "NUMBER" },
              },
              required: ["name", "category", "quantity", "total"],
            },
          },
        },
        required: ["at_current_location", "currency", "total", "items"],
      },
    },
    incomes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          received_at_local: N("STRING", { description: "YYYY-MM-DD HH:MM or null" }),
          from: N("STRING"),
          category: { type: "STRING" },
          amount: { type: "NUMBER" },
          currency: { type: "STRING" },
          purpose: N("STRING"),
          note: N("STRING"),
          payment_method: N("STRING"),
        },
        required: ["category", "amount", "currency"],
      },
    },
    debts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          direction: { type: "STRING", format: "enum", enum: ["owe", "owed"] },
          counterparty: { type: "STRING" },
          amount: { type: "NUMBER" },
          currency: { type: "STRING" },
          kind: { type: "STRING", format: "enum", enum: ["personal", "company_advance", "company_loan"] },
          started_at_local: N("STRING", { description: "YYYY-MM-DD HH:MM or null" }),
          due_date: N("STRING", { description: "YYYY-MM-DD or null" }),
          reason: N("STRING"),
          note: N("STRING"),
        },
        required: ["direction", "counterparty", "amount", "currency", "kind"],
      },
    },
    repayments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          direction: { type: "STRING", format: "enum", enum: ["owe", "owed"] },
          counterparty: { type: "STRING" },
          amount: { type: "NUMBER" },
          paid_at_local: N("STRING", { description: "YYYY-MM-DD HH:MM or null" }),
          debt_ref: N("STRING"),
          note: N("STRING"),
        },
        required: ["direction", "counterparty", "amount"],
      },
    },
  },
  required: ["transcript", "needs_review", "expenses", "incomes", "debts", "repayments"],
};

type Meta = {
  now_local?: string;
  weekday?: string;
  device_place?: string | null;
  text?: string | null;
  audio_seconds?: number;
  categories?: string[];
  items?: { name: string; category?: string | null; unit?: string | null }[];
  income_categories?: string[];
  counterparties?: string[];
  open_debts?: { ref: string; direction: string; counterparty: string; remaining: number; due_date?: string | null; kind?: string | null }[];
};

function buildContext(meta: Meta, hasAudio: boolean, imageCount: number): string {
  const cats = (meta.categories ?? []).filter(Boolean).slice(0, 80);
  const items = (meta.items ?? []).filter((i) => i && i.name).slice(0, 300);
  const incomeCats = (meta.income_categories ?? []).filter(Boolean).slice(0, 40);
  const people = (meta.counterparties ?? []).filter(Boolean).slice(0, 80);
  const debts = (meta.open_debts ?? []).filter((d) => d && d.ref && d.counterparty).slice(0, 40);
  const input: string[] = [];
  if (hasAudio) input.push(`تسجيل صوتي${meta.audio_seconds ? ` (${Math.round(meta.audio_seconds)} ثانية)` : ""}`);
  if (imageCount) input.push(`${imageCount} صورة`);
  if (meta.text) input.push("نص مكتوب");
  return [
    `NOW: ${meta.now_local ?? "unknown"}${meta.weekday ? ` (${meta.weekday})` : ""} – Europe/Berlin`,
    `DEVICE PLACE: ${meta.device_place || "غير معروف"}`,
    `INPUT: ${input.join(" + ") || "—"}`,
    meta.text ? `TYPED TEXT: ${String(meta.text).slice(0, 2000)}` : "",
    `KNOWN CATEGORIES: ${cats.length ? cats.join(" | ") : "(none yet)"}`,
    `KNOWN ITEMS (name — category — unit): ${
      items.length
        ? items.map((i) => `${i.name} — ${i.category ?? "?"} — ${i.unit ?? "-"}`).join("; ")
        : "(none yet)"
    }`,
    `KNOWN INCOME CATEGORIES: ${incomeCats.length ? incomeCats.join(" | ") : "(none yet)"}`,
    `KNOWN PEOPLE: ${people.length ? people.join(" | ") : "(none yet)"}`,
    `OPEN DEBTS (ref — direction — person — remaining € — due — kind): ${
      debts.length
        ? debts.map((d) => `${d.ref} — ${d.direction} — ${d.counterparty} — ${d.remaining} — ${d.due_date || "-"} — ${d.kind || "personal"}`).join("; ")
        : "(none)"
    }`,
  ].filter(Boolean).join("\n");
}

function thinkingFor(model: string): Record<string, unknown> | undefined {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 512 };
  if (/^gemini-([3-9]|flash-latest|flash-lite-latest)/.test(model)) return { thinkingLevel: "low" };
  return undefined;
}

function classifyGeminiError(status: number, text: string): { code: string; error: string } {
  const t = text.toLowerCase();
  if (t.includes("location is not supported") || (status !== 429 && t.includes("billing"))) {
    return { code: "gemini_billing", error: "Gemini: يجب ربط حساب دفع (Billing) بمفتاح Gemini – الطبقة المجانية غير متاحة في ألمانيا" };
  }
  if (status === 400 && (t.includes("api key not valid") || t.includes("api_key_invalid"))) {
    return { code: "gemini_key", error: "Gemini: مفتاح API غير صالح" };
  }
  if (status === 403) {
    return { code: "gemini_key", error: "Gemini: المفتاح لا يملك صلاحية (403)" };
  }
  if (status === 429) {
    return { code: "gemini_quota", error: "Gemini: تم تجاوز الحد المسموح مؤقتاً – حاول بعد دقيقة" };
  }
  if (status === 400 && (t.includes("mime") || t.includes("audio") || t.includes("unsupported"))) {
    return { code: "audio_format", error: "Gemini: صيغة الملف غير مدعومة" };
  }
  return { code: "gemini", error: `Gemini: خطأ ${status}` };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method", "Method not allowed");

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return fail(503, "no_key", "مفتاح Gemini غير موجود بعد في إعدادات Supabase (GEMINI_API_KEY)");

  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!auth.startsWith("Bearer ") || !apikey) return fail(401, "auth", "غير مسجل الدخول");

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 18 * 1024 * 1024) return fail(413, "too_large", "الملفات كبيرة جداً (الحد 18 ميغابايت)");

  // Verify the caller (must be the account owner) and count the call against the monthly cap.
  const sbUrl = Deno.env.get("SUPABASE_URL");
  let usage = 0;
  try {
    const tick = await fetch(`${sbUrl}/rest/v1/rpc/ai_tick`, {
      method: "POST",
      headers: { apikey, Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
    });
    const tickText = await tick.text();
    if (!tick.ok) {
      if (tickText.includes("monthly limit")) {
        return fail(429, "limit", "تم الوصول إلى الحد الشهري لتحليلات الذكاء الاصطناعي (500)", tickText);
      }
      return fail(401, "auth", "الجلسة غير صالحة – سجّل الدخول من جديد", tickText);
    }
    usage = Number(tickText) || 0;
  } catch (e) {
    return fail(502, "db", "تعذر الاتصال بقاعدة البيانات", String(e));
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return fail(400, "bad_request", "طلب غير صالح", String(e));
  }

  let meta: Meta = {};
  try {
    meta = JSON.parse(String(form.get("meta") ?? "{}"));
  } catch {
    meta = {};
  }

  const audio = form.get("audio");
  const images = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const hasAudio = audio instanceof File && audio.size > 0;
  if (!hasAudio && images.length === 0 && !meta.text) {
    return fail(400, "bad_request", "لا يوجد صوت أو صورة أو نص");
  }

  const parts: Record<string, unknown>[] = [{ text: buildContext(meta, hasAudio, images.length) }];
  if (hasAudio) {
    const a = audio as File;
    const mime = (a.type || "audio/webm").split(";")[0].trim().toLowerCase();
    parts.push({ text: "التسجيل الصوتي:" });
    parts.push({ inline_data: { mime_type: mime, data: toBase64(new Uint8Array(await a.arrayBuffer())) } });
  }
  for (let i = 0; i < images.length && i < 5; i++) {
    const img = images[i];
    parts.push({ text: `صورة ${i}:` });
    parts.push({
      inline_data: {
        mime_type: (img.type || "image/jpeg").toLowerCase(),
        data: toBase64(new Uint8Array(await img.arrayBuffer())),
      },
    });
  }

  const models = (Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-lite-latest,gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean);

  let last = { status: 0, code: "gemini", error: "Gemini: لا يوجد رد", detail: "" };

  for (const model of models) {
    let thinking = thinkingFor(model);
    for (let attempt = 0; attempt < 3; attempt++) {
      const generationConfig: Record<string, unknown> = {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 8192,
      };
      if (thinking) generationConfig.thinkingConfig = thinking;

      let r: Response;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts }],
            generationConfig,
          }),
        });
      } catch (e) {
        last = { status: 0, code: "gemini", error: "تعذر الاتصال بـ Gemini", detail: String(e) };
        await sleep(1200);
        continue;
      }

      const text = await r.text();
      if (r.ok) {
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          last = { status: 200, code: "gemini", error: "Gemini: رد غير مفهوم", detail: text.slice(0, 300) };
          break;
        }
        const cand = data?.candidates?.[0];
        const out = (cand?.content?.parts ?? [])
          .filter((p: any) => typeof p?.text === "string" && !p.thought)
          .map((p: any) => p.text)
          .join("");
        if (!out) {
          last = {
            status: 200,
            code: "gemini_empty",
            error: "Gemini لم يرجع نتيجة",
            detail: JSON.stringify({ finish: cand?.finishReason, feedback: data?.promptFeedback }),
          };
          break; // try next model
        }
        let result: unknown;
        try {
          result = JSON.parse(out);
        } catch {
          last = { status: 200, code: "gemini", error: "Gemini: JSON غير صالح", detail: out.slice(0, 300) };
          break;
        }
        return json(200, { ok: true, model, usage, result });
      }

      const lower = text.toLowerCase();
      console.error(`gemini ${model} HTTP ${r.status}: ${text.slice(0, 800)}`);

      if (r.status === 402 || lower.includes("prepayment") || lower.includes("credits are depleted")) {
        return fail(402, "gemini_credits", "رصيد Gemini المدفوع مسبقاً انتهى – اشحن الرصيد في Google AI Studio ← Abrechnung", text);
      }
      if (lower.includes("location is not supported") || (r.status !== 429 && lower.includes("billing"))) {
        const c = classifyGeminiError(r.status, text);
        return fail(402, c.code, c.error, text);
      }
      if (r.status === 400 && (lower.includes("api key not valid") || lower.includes("api_key_invalid"))) {
        return fail(502, "gemini_key", "Gemini: مفتاح API غير صالح", text);
      }
      if (r.status === 400 && thinking && lower.includes("think")) {
        thinking = undefined; // model does not accept this thinking parameter → retry without
        continue;
      }
      const modelUnavailable = r.status === 404 || r.status === 401 || r.status === 403 ||
        (r.status === 400 && /not found|no longer available|not supported for|unsupported model|is not available|not have access/.test(lower));
      if (modelUnavailable) {
        const c = classifyGeminiError(r.status, text);
        last = { status: r.status, code: r.status === 404 ? "gemini_model" : c.code, error: r.status === 404 ? `Gemini: النموذج ${model} غير متاح` : c.error, detail: text };
        break; // try the next model
      }
      if (r.status === 429 || r.status >= 500) {
        const c = classifyGeminiError(r.status, text);
        last = { status: r.status, ...c, detail: text };
        if (c.code === "gemini_billing") return fail(402, c.code, c.error, text);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const c = classifyGeminiError(r.status, text);
      const status = c.code === "audio_format" ? 415 : c.code === "gemini_billing" ? 402 : 502;
      return fail(status, c.code, c.error, text);
    }
  }

  return fail(502, last.code, last.error, last.detail);
});
