// مصاريفي – pure helper functions (no DOM, no network) – unit-tested in tests/lib.test.mjs

// ───────────── text & numbers ─────────────
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Parses numbers typed in German/English/Arabic style: "12,5" "1.234,56" "1,234.56" "١٢٫٥" → number | null */
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v)
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '')
    .replace(/[\s€]/g, '')
    .replace(/eur(o)?/i, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(/,/g, '.');
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const moneyFmt = new Map();
export function fmtMoney(n, cur = 'EUR') {
  const c = /^[A-Z]{3}$/.test(cur || '') ? cur : 'EUR';
  if (!moneyFmt.has(c)) moneyFmt.set(c, new Intl.NumberFormat('de-DE', { style: 'currency', currency: c }));
  return moneyFmt.get(c).format(Number(n) || 0);
}

export function fmtNum(n, maxFrac = 2) {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: maxFrac }).format(Number(n) || 0);
}

/** value for an <input> (German decimal comma, no thousands separator) */
export function numInput(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1000) / 1000).replace('.', ',');
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined && String(x).trim() !== ''))];

// ───────────── dates (device local time = Germany) ─────────────
export const pad = (n) => String(n).padStart(2, '0');

export function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** "2026-11-05 14:30" | "2026-11-05T14:30" | "2026-11-05" → Date (local) | null */
export function parseLocalStamp(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : 12, hasTime ? +m[5] : 0, 0, 0);
  if (Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1) return null;
  return d;
}

export function toInputDateTime(d) {
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputDateTime(v) {
  return parseLocalStamp(String(v || '').replace('T', ' '));
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/** Monday 00:00 */
export function startOfWeek(d) {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Monday = 0
  return addDays(s, -dow);
}

export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function startOfYear(d) {
  return new Date(d.getFullYear(), 0, 1);
}

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const weekdayAr = (d) => WEEKDAYS[d.getDay()];

const dtFmt = {
  dayLong: new Intl.DateTimeFormat('ar-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' }),
  dayYear: new Intl.DateTimeFormat('ar-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }),
  month: new Intl.DateTimeFormat('ar-u-nu-latn', { month: 'long', year: 'numeric' }),
  monthShort: new Intl.DateTimeFormat('ar-u-nu-latn', { month: 'short' }),
  time: new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }),
};
export const fmtDay = (d) => dtFmt.dayLong.format(d);
export const fmtDayYear = (d) => dtFmt.dayYear.format(d);
export const fmtMonth = (d) => dtFmt.month.format(d);
export const fmtMonthShort = (d) => dtFmt.monthShort.format(d);
export const fmtTime = (d) => dtFmt.time.format(d);
export function fmtDateTime(d, now = new Date()) {
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${sameYear ? fmtDay(d) : fmtDayYear(d)} · ${fmtTime(d)}`;
}

/**
 * Report periods. For running periods the comparison uses the same elapsed span of the
 * previous period (e.g. 1–6 Nov vs 1–6 Oct).
 */
export function periodRange(key, now = new Date(), custom = {}) {
  let from, to, prevFrom, label, bucket = 'day';
  switch (key) {
    case 'week':
      from = startOfWeek(now); to = addDays(from, 7); prevFrom = addDays(from, -7); label = 'هذا الأسبوع'; break;
    case 'lastweek':
      to = startOfWeek(now); from = addDays(to, -7); prevFrom = addDays(from, -7); label = 'الأسبوع الماضي'; break;
    case 'lastmonth':
      from = addMonths(now, -1); to = startOfMonth(now); prevFrom = addMonths(now, -2); label = fmtMonth(from); break;
    case 'year':
      from = startOfYear(now); to = new Date(now.getFullYear() + 1, 0, 1); prevFrom = new Date(now.getFullYear() - 1, 0, 1);
      label = `سنة ${now.getFullYear()}`; bucket = 'month'; break;
    case 'custom': {
      const a = custom.from ? startOfDay(custom.from) : startOfMonth(now);
      const b = custom.to ? startOfDay(custom.to) : startOfDay(now);
      from = a <= b ? a : b;
      to = addDays(a <= b ? b : a, 1);
      const len = to - from;
      prevFrom = new Date(from.getTime() - len);
      label = `${fmtDayYear(from)} – ${fmtDayYear(addDays(to, -1))}`;
      if (len > 92 * 86400000) bucket = 'month';
      break;
    }
    case 'month':
    default:
      from = startOfMonth(now); to = addMonths(now, 1); prevFrom = addMonths(now, -1); label = fmtMonth(from); key = 'month';
  }
  const running = now >= from && now < to;
  const elapsed = (running ? now : to) - from;
  // previous period end: same elapsed span (running) or full previous period (finished)
  let prevTo;
  if (key === 'lastmonth' || key === 'month') {
    prevTo = running ? new Date(prevFrom.getTime() + elapsed) : from;
    if (prevTo > from) prevTo = from;
  } else if (key === 'year') {
    prevTo = running ? new Date(prevFrom.getTime() + elapsed) : from;
  } else {
    prevTo = running ? new Date(prevFrom.getTime() + elapsed) : from;
  }
  const days = Math.max(1, Math.ceil(elapsed / 86400000));
  return { key, from, to, prevFrom, prevTo, label, bucket, running, days };
}

// ───────────── categories ─────────────
const EMOJI = [
  [/دخان|سجا|تبغ/, '🚬'],
  [/مطاعم|مطعم|خارج البيت|وجب/, '🍽️'],
  [/قهوة|مشروب|كافي/, '☕'],
  [/أكل|بقال|طعام|خضار|سوبر|لحم/, '🛒'],
  [/سيار|وقود|بنزين|ديزل|محط/, '⛽'],
  [/مواصلات|قطار|باص|تذكر|تاكسي/, '🚆'],
  [/سكن|إيجار|ايجار|فواتير|كهرباء|غاز|ماء/, '🏠'],
  [/اتصال|إنترنت|انترنت|هاتف|موبايل/, '📱'],
  [/صح|صيدل|دواء|طبيب/, '💊'],
  [/ملابس|أحذية|احذية/, '👕'],
  [/أولاد|اولاد|أطفال|اطفال|مدرس/, '🧒'],
  [/منزل|تنظيف|أدوات|ادوات/, '🧽'],
  [/ترفيه|سينما|رحل|سفر/, '🎉'],
  [/هدايا|هدية|مناسب/, '🎁'],
  [/مكتب|عمل/, '💼'],
];
export function catEmoji(name) {
  const hit = EMOJI.find(([re]) => re.test(name || ''));
  return hit ? hit[1] : '🏷️';
}

export function catColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 58% 46%)`;
}

export const DEFAULT_CATEGORIES = [
  'أكل للبيت', 'مطاعم وأكل خارج البيت', 'دخان', 'قهوة ومشروبات', 'سيارة ووقود', 'مواصلات',
  'سكن وفواتير', 'اتصالات وإنترنت', 'صحة وصيدلية', 'ملابس وأحذية', 'أولاد',
  'أدوات منزلية وتنظيف', 'ترفيه', 'هدايا ومناسبات', 'مكتب وعمل', 'أخرى',
];
export const DEFAULT_UNITS = ['علبة', 'قطعة', 'كيلو', 'غرام', 'لتر', 'وجبة', 'كوب', 'مرة', 'شهر'];

// ───────────── AI result normalisation ─────────────
function cleanStr(v, max = 300) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  return s.slice(0, max);
}

export function normalizeItem(raw) {
  const r = raw || {};
  let quantity = parseNum(r.quantity);
  if (quantity === null || quantity === 0) quantity = 1;
  let total = parseNum(r.total);
  let unit_price = parseNum(r.unit_price);
  if (total === null && unit_price !== null) total = quantity * unit_price;
  if (total === null) total = 0;
  total = round2(total);
  if (unit_price === null && quantity) unit_price = round2(total / quantity);
  else if (unit_price !== null) unit_price = round2(unit_price);
  return {
    name: cleanStr(r.name, 120) || 'غير محدد',
    name_original: cleanStr(r.name_original, 200),
    category: cleanStr(r.category, 80) || 'أخرى',
    quantity: Math.round(quantity * 1000) / 1000,
    unit: cleanStr(r.unit, 30),
    unit_price,
    total,
  };
}

export const sumItems = (items) => round2((items || []).reduce((a, i) => a + (Number(i.total) || 0), 0));

/**
 * @param result  raw JSON from the AI
 * @param ctx     { createdAt: Date, imageCount: number }
 */
export function normalizeAnalysis(result, ctx) {
  const r = result && typeof result === 'object' ? result : {};
  const createdAt = ctx?.createdAt instanceof Date ? ctx.createdAt : new Date();
  const imageCount = ctx?.imageCount || 0;
  const list = Array.isArray(r.expenses) ? r.expenses : [];
  const expenses = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    let items = (Array.isArray(e.items) ? e.items : []).map(normalizeItem);
    const aiTotal = parseNum(e.total);
    if (!items.length && aiTotal) {
      items = [normalizeItem({ name: cleanStr(e.purpose) || cleanStr(e.merchant) || 'مصروف', category: 'أخرى', quantity: 1, total: aiTotal })];
    }
    if (!items.length) continue;
    const total = sumItems(items);
    const mismatch = aiTotal !== null && Math.abs(aiTotal - total) > 0.05;

    let when = parseLocalStamp(e.spent_at_local);
    if (when) {
      const diff = when - createdAt;
      if (diff > 36 * 3600000 || diff < -2 * 365 * 86400000) when = null; // implausible → ignore
    }
    const spent = when || createdAt;
    // A purchase clearly earlier than the recording (old receipt, "yesterday") did not happen where the phone is now.
    const earlier = !!when && createdAt - when > 45 * 60000;
    const cur = (cleanStr(e.currency, 3) || 'EUR').toUpperCase();
    let imgs = (Array.isArray(e.image_indexes) ? e.image_indexes : [])
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isInteger(x) && x >= 0 && x < imageCount);
    imgs = [...new Set(imgs)];
    expenses.push({
      spent_at: spent.toISOString(),
      at_current_location: e.at_current_location !== false && !earlier,
      merchant: cleanStr(e.merchant, 120),
      merchant_address: cleanStr(e.merchant_address, 200),
      purpose: cleanStr(e.purpose, 200),
      note: cleanStr(e.note, 500),
      payment_method: cleanStr(e.payment_method, 30),
      currency: /^[A-Z]{3}$/.test(cur) ? cur : 'EUR',
      items,
      total,
      ai_total: aiTotal,
      mismatch,
      image_indexes: imgs,
    });
  }
  if (imageCount && expenses.length && !expenses.some((x) => x.image_indexes.length)) {
    expenses[0].image_indexes = [...Array(imageCount).keys()];
  }

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const amountOf = (v) => { const n = parseNum(v); return n !== null && n > 0 ? round2(n) : null; };
  const when = (v) => stampNear(v, createdAt).toISOString();

  const incomes = [];
  for (const x of arr(r.incomes)) {
    const amount = amountOf(x.amount);
    if (amount === null) continue;
    const from = cleanStr(x.from, 120);
    incomes.push({
      received_at: when(x.received_at_local),
      from: from && isCompany(from) ? COMPANY : from,
      category: cleanStr(x.category, 80) || 'أخرى',
      amount,
      currency: curOf(x.currency),
      purpose: cleanStr(x.purpose, 200),
      note: cleanStr(x.note, 500),
      payment_method: cleanStr(x.payment_method, 30),
    });
  }

  const debts = [];
  for (const x of arr(r.debts)) {
    const amount = amountOf(x.amount);
    if (amount === null) continue;
    let counterparty = cleanStr(x.counterparty, 120) || 'غير معروف';
    const kind = DEBT_KIND_KEYS.includes(x.kind) && x.kind !== 'personal' ? x.kind : 'personal';
    if (kind !== 'personal' || isCompany(counterparty)) counterparty = COMPANY;
    debts.push({
      direction: x.direction === 'owed' ? 'owed' : 'owe',
      counterparty,
      amount,
      currency: curOf(x.currency),
      kind,
      started_at: when(x.started_at_local),
      due_date: dueDateOf(x.due_date, createdAt),
      reason: cleanStr(x.reason, 300),
      note: cleanStr(x.note, 500),
    });
  }

  const open = Array.isArray(ctx?.openDebts) ? ctx.openDebts : [];
  const repayments = [];
  for (const x of arr(r.repayments)) {
    const amount = amountOf(x.amount);
    if (amount === null) continue;
    const direction = x.direction === 'owed' ? 'owed' : 'owe';
    let counterparty = cleanStr(x.counterparty, 120) || 'غير معروف';
    if (isCompany(counterparty)) counterparty = COMPANY;
    repayments.push({
      direction,
      counterparty,
      amount,
      paid_at: when(x.paid_at_local),
      debt_id: matchDebt(open, { ref: cleanStr(x.debt_ref, 20), counterparty, direction }),
      note: cleanStr(x.note, 500),
    });
  }

  const needs = !!r.needs_review || expenses.some((x) => x.mismatch || x.total === 0) || repayments.some((p) => !p.debt_id);
  return {
    transcript: cleanStr(r.transcript, 4000),
    needs_review: needs,
    question: cleanStr(r.question, 500),
    expenses,
    incomes,
    debts,
    repayments,
  };
}

const curOf = (v) => { const c = (cleanStr(v, 3) || 'EUR').toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : 'EUR'; };

/** AI local stamp → Date; implausible values (far future / very old) fall back to the recording time */
function stampNear(v, createdAt) {
  const d = parseLocalStamp(v);
  if (!d) return createdAt;
  const diff = d - createdAt;
  if (diff > 36 * 3600000 || diff < -2 * 365 * 86400000) return createdAt;
  return d;
}

/** "YYYY-MM-DD" due date, only if plausible (≤ 1 year back, ≤ 5 years ahead) */
export function dueDateOf(v, ref = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const d = parseLocalStamp(m[0]);
  if (!d) return null;
  const diff = d - ref;
  if (diff < -366 * 86400000 || diff > 5 * 366 * 86400000) return null;
  return m[0];
}

// ───────────── income, debts, repayments ─────────────
export const COMPANY = 'الشركة';
export const DEFAULT_INCOME_CATEGORIES = ['راتب', 'استرداد مصاريف من الشركة', 'هدية', 'بيع', 'أخرى'];
export const DEBT_KINDS = { personal: 'شخصي', company_advance: 'سلفة من الشركة', company_loan: 'قرض من الشركة' };
const DEBT_KIND_KEYS = Object.keys(DEBT_KINDS);

/** Name key for matching people: "أبو محمد" ≈ "ابو محمد" ≈ "أبو  محمّد" */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isCompany(name) {
  return /شركه|فيرما|flexgips|firma/.test(normalizeName(name));
}

/**
 * Finds the open debt a repayment belongs to.
 * @param open  [{ ref, id, direction, counterparty, due_date, started_at }]
 */
export function matchDebt(open, { ref, counterparty, direction }) {
  const list = (open || []).filter((d) => d && d.id);
  if (ref) {
    const hit = list.find((d) => d.ref === ref);
    if (hit && hit.direction === direction) return hit.id;
  }
  const n = normalizeName(counterparty);
  if (!n) return null;
  const same = (d) => d.direction === direction;
  const byDue = (a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
    || String(a.started_at || '').localeCompare(String(b.started_at || ''));
  let c = list.filter((d) => same(d) && (normalizeName(d.counterparty) === n || (isCompany(d.counterparty) && isCompany(counterparty))));
  if (!c.length && n.length >= 2) {
    c = list.filter((d) => { const k = normalizeName(d.counterparty); return same(d) && k.length >= 2 && (k.includes(n) || n.includes(k)); });
    if (c.length > 1 && new Set(c.map((d) => normalizeName(d.counterparty))).size > 1) return null; // ambiguous
  }
  if (!c.length) return null;
  return c.slice().sort(byDue)[0].id;
}

/** income (from normalizeAnalysis) → expense-shaped object stored with kind = 'income' */
export function incomeAsExpense(inc) {
  return {
    kind: 'income',
    spent_at: inc.received_at,
    merchant: inc.from || null,
    merchant_address: null,
    purpose: inc.purpose || null,
    note: inc.note || null,
    payment_method: inc.payment_method || null,
    currency: inc.currency || 'EUR',
    items: [{ name: inc.category || 'أخرى', name_original: null, category: inc.category || 'أخرى', quantity: 1, unit: null, unit_price: inc.amount, total: inc.amount }],
    total: inc.amount,
    ai_total: inc.amount,
    mismatch: false,
    image_indexes: [],
  };
}

export function debtPayload(d) {
  return {
    id: d.id,
    direction: d.direction === 'owed' ? 'owed' : 'owe',
    counterparty: cleanStr(d.counterparty, 120) || 'غير معروف',
    amount: round2(parseNum(d.amount) || 0),
    currency: d.currency || 'EUR',
    started_at: d.started_at || new Date().toISOString(),
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.due_date || '')) ? d.due_date : null,
    kind: DEBT_KIND_KEYS.includes(d.kind) ? d.kind : 'personal',
    reason: cleanStr(d.reason, 300),
    note: cleanStr(d.note, 500),
    source: d.source || 'manual',
    transcript: cleanStr(d.transcript, 4000),
    ai_model: cleanStr(d.ai_model, 60),
  };
}

export function paymentPayload(p) {
  return {
    id: p.id,
    debt_id: p.debt_id,
    paid_at: p.paid_at || new Date().toISOString(),
    amount: round2(parseNum(p.amount) || 0),
    note: cleanStr(p.note, 500),
    source: p.source || 'manual',
    transcript: cleanStr(p.transcript, 4000),
  };
}

export function daysAr(n) {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/** paid / remaining / due state of a debt row (v_debts or a fresh debt) */
export function debtStatus(d, now = new Date()) {
  const amount = Number(d.amount) || 0;
  const paid = Number(d.paid) || 0;
  const remaining = d.remaining !== undefined && d.remaining !== null ? Number(d.remaining) || 0 : Math.max(amount - paid, 0);
  const settled = !!d.settled_at || remaining <= 0.004;
  let daysLeft = null;
  if (d.due_date && !settled) {
    const due = parseLocalStamp(d.due_date);
    if (due) daysLeft = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  }
  return {
    amount: round2(amount),
    paid: round2(paid),
    remaining: round2(remaining),
    settled,
    daysLeft,
    overdue: daysLeft !== null && daysLeft < 0,
    dueToday: daysLeft === 0,
    pct: amount ? Math.min(100, Math.max(0, ((amount - remaining) / amount) * 100)) : 0,
  };
}

export function dueLabel(st) {
  if (st.settled) return 'مسدد ✓';
  if (st.daysLeft === null) return 'بدون موعد';
  if (st.daysLeft < 0) return `متأخر ${daysAr(-st.daysLeft)}`;
  if (st.daysLeft === 0) return 'يستحق اليوم';
  if (st.daysLeft === 1) return 'يستحق غداً';
  return `يستحق بعد ${daysAr(st.daysLeft)}`;
}

/** open debts, most urgent first */
export function openDebts(list, now = new Date()) {
  return (list || [])
    .filter((d) => !debtStatus(d, now).settled)
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
      || String(a.started_at || '').localeCompare(String(b.started_at || '')));
}

export function debtsSummary(list, now = new Date()) {
  const out = { owe: 0, owed: 0, overdue: 0, soon: 0, open: 0, companyOpen: 0 };
  for (const d of list || []) {
    const st = debtStatus(d, now);
    if (st.settled) continue;
    out.open++;
    if (d.direction === 'owed') out.owed += st.remaining; else out.owe += st.remaining;
    if (d.direction !== 'owed' && (d.kind === 'company_advance' || d.kind === 'company_loan')) out.companyOpen += st.remaining;
    if (st.overdue) out.overdue++;
    else if (st.daysLeft !== null && st.daysLeft <= 2) out.soon++;
  }
  out.owe = round2(out.owe);
  out.owed = round2(out.owed);
  out.companyOpen = round2(out.companyOpen);
  return out;
}

/** "لـ أبو محمد" but "للشركة" (لـ + ال) */
export function toWhom(name) {
  const n = String(name ?? '').trim();
  return /^ال/.test(n) ? `لل${n.slice(2)}` : `لـ ${n}`;
}

export function debtTitle(d) {
  return d.direction === 'owed' ? `دين لي عند ${d.counterparty}` : `دين عليّ ${toWhom(d.counterparty)}`;
}

/** Google Calendar "create event" link (all-day event on the due date) */
export function calendarUrl({ title, date, details = '' }) {
  const d = parseLocalStamp(date);
  if (!d) return null;
  const a = dateKey(d).replace(/-/g, '');
  const b = dateKey(addDays(d, 1)).replace(/-/g, '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${a}/${b}&details=${encodeURIComponent(details)}`;
}

export function debtCalendarUrl(d, remaining) {
  const amount = fmtMoney(remaining ?? d.amount, d.currency);
  const title = d.direction === 'owed' ? `تحصيل دين من ${d.counterparty}: ${amount}` : `سداد دين ${toWhom(d.counterparty)}: ${amount}`;
  const details = [d.reason ? `السبب: ${d.reason}` : '', d.kind && d.kind !== 'personal' ? DEBT_KINDS[d.kind] : '', 'من تطبيق مصاريفي']
    .filter(Boolean).join('\n');
  return calendarUrl({ title, date: d.due_date, details });
}

/** expense object → payload for the save_expense RPC */
export function toPayload(e) {
  const items = (e.items || []).map((i) => ({
    name: cleanStr(i.name, 120) || 'غير محدد',
    name_original: cleanStr(i.name_original, 200),
    category: cleanStr(i.category, 80) || 'أخرى',
    quantity: parseNum(i.quantity) || 1,
    unit: cleanStr(i.unit, 30),
    unit_price: parseNum(i.unit_price) === null ? null : round2(parseNum(i.unit_price)),
    total: round2(parseNum(i.total) || 0),
  }));
  return {
    id: e.id,
    kind: e.kind === 'income' ? 'income' : 'expense',
    spent_at: e.spent_at,
    total: sumItems(items),
    currency: e.currency || 'EUR',
    merchant: cleanStr(e.merchant, 120),
    merchant_address: cleanStr(e.merchant_address, 200),
    purpose: cleanStr(e.purpose, 200),
    note: cleanStr(e.note, 500),
    payment_method: cleanStr(e.payment_method, 30),
    source: e.source || 'manual',
    transcript: cleanStr(e.transcript, 4000),
    lat: typeof e.lat === 'number' ? e.lat : null,
    lng: typeof e.lng === 'number' ? e.lng : null,
    place_name: cleanStr(e.place_name, 200),
    receipt_paths: Array.isArray(e.receipt_paths) ? e.receipt_paths : [],
    ai_model: cleanStr(e.ai_model, 60),
    items,
  };
}

// ───────────── reports ─────────────
export function placeOf(row) {
  return cleanStr(row.merchant) || cleanStr(row.place_name) || 'غير محدد';
}

/**
 * @param rows  rows of v_items (item + expense columns)
 */
export function aggregate(rows, range) {
  const out = { total: 0, purchases: 0, categories: [], items: [], places: [], series: [] };
  const cats = new Map();
  const items = new Map();
  const places = new Map();
  const expenses = new Set();
  for (const r of rows) {
    const t = Number(r.total) || 0;
    out.total += t;
    expenses.add(r.expense_id);
    const cname = r.category || 'أخرى';
    if (!cats.has(cname)) cats.set(cname, { name: cname, total: 0, count: 0, items: new Map() });
    const c = cats.get(cname);
    c.total += t;
    c.count += 1;
    addItem(c.items, r, t);
    addItem(items, r, t, cname);
    const p = placeOf(r);
    if (!places.has(p)) places.set(p, { name: p, total: 0, exp: new Set() });
    const pl = places.get(p);
    pl.total += t;
    pl.exp.add(r.expense_id);
  }
  out.total = round2(out.total);
  out.purchases = expenses.size;
  out.categories = [...cats.values()]
    .map((c) => ({ ...c, total: round2(c.total), pct: out.total ? (c.total / out.total) * 100 : 0, items: finishItems(c.items) }))
    .sort((a, b) => b.total - a.total);
  out.items = finishItems(items);
  out.places = [...places.values()]
    .map((p) => ({ name: p.name, total: round2(p.total), count: p.exp.size }))
    .sort((a, b) => b.total - a.total);
  if (range) out.series = series(rows, range);
  return out;
}

/** income rows of v_items (kind = 'income') → totals by category and by payer */
export function aggregateIncome(rows) {
  const out = { total: 0, count: 0, categories: [], sources: [] };
  const cats = new Map();
  const srcs = new Map();
  const ids = new Set();
  for (const r of rows || []) {
    const t = Number(r.total) || 0;
    out.total += t;
    ids.add(r.expense_id);
    const c = r.category || 'أخرى';
    if (!cats.has(c)) cats.set(c, { name: c, total: 0, count: 0 });
    cats.get(c).total += t;
    cats.get(c).count += 1;
    const s = cleanStr(r.merchant) || 'غير محدد';
    if (!srcs.has(s)) srcs.set(s, { name: s, total: 0 });
    srcs.get(s).total += t;
  }
  out.total = round2(out.total);
  out.count = ids.size;
  out.categories = [...cats.values()].map((c) => ({ ...c, total: round2(c.total) })).sort((a, b) => b.total - a.total);
  out.sources = [...srcs.values()].map((x) => ({ ...x, total: round2(x.total) })).sort((a, b) => b.total - a.total);
  return out;
}

function addItem(map, r, t, category) {
  const key = r.name || 'غير محدد';
  if (!map.has(key)) map.set(key, { name: key, category: category || r.category, total: 0, n: 0, units: new Map() });
  const it = map.get(key);
  it.total += t;
  it.n += 1;
  const u = r.unit || '';
  it.units.set(u, (it.units.get(u) || 0) + (Number(r.quantity) || 1));
}

function finishItems(map) {
  return [...map.values()]
    .map((it) => ({ name: it.name, category: it.category, total: round2(it.total), n: it.n, qty: qtyLabel(it) }))
    .sort((a, b) => b.total - a.total);
}

export function timesAr(n) {
  if (n === 1) return 'مرة واحدة';
  if (n === 2) return 'مرتان';
  if (n >= 3 && n <= 10) return `${n} مرات`;
  return `${n} مرة`;
}

function qtyLabel(it) {
  const parts = [];
  for (const [u, q] of it.units) {
    if (u) parts.push(`${fmtNum(q, 3)} ${u}`);
  }
  const unitless = it.units.get('');
  if (unitless !== undefined) {
    if (!parts.length) return timesAr(it.n);
    parts.push(`${fmtNum(unitless, 3)} بدون وحدة`);
  }
  return parts.join(' + ');
}

export function series(rows, range) {
  const buckets = [];
  const idx = new Map();
  if (range.bucket === 'month') {
    for (let d = startOfMonth(range.from); d < range.to; d = addMonths(d, 1)) {
      idx.set(monthKey(d), buckets.length);
      buckets.push({ key: monthKey(d), date: d, label: fmtMonthShort(d), total: 0 });
    }
  } else {
    for (let d = startOfDay(range.from); d < range.to; d = addDays(d, 1)) {
      idx.set(dateKey(d), buckets.length);
      buckets.push({ key: dateKey(d), date: d, label: String(d.getDate()), total: 0 });
    }
  }
  for (const r of rows) {
    const d = new Date(r.spent_at);
    const k = range.bucket === 'month' ? monthKey(d) : dateKey(d);
    if (idx.has(k)) buckets[idx.get(k)].total += Number(r.total) || 0;
  }
  for (const b of buckets) b.total = round2(b.total);
  return buckets;
}

// ───────────── CSV export (Excel-friendly, German locale) ─────────────
export function toCSV(rows) {
  const head = ['التاريخ', 'الوقت', 'المتجر', 'المكان', 'الغاية', 'الفئة', 'الصنف', 'الاسم الأصلي', 'الكمية', 'الوحدة', 'سعر الوحدة', 'المبلغ', 'النوع'];
  const q = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (v === null || v === undefined || v === '' ? '' : String(round2(v)).replace('.', ','));
  const lines = [head.join(';')];
  for (const r of rows) {
    const d = new Date(r.spent_at);
    lines.push([
      dateKey(d), fmtTime(d), r.merchant, r.place_name || r.merchant_address, r.purpose, r.category, r.name,
      r.name_original, String(Number(r.quantity) || 1).replace('.', ','), r.unit, num(r.unit_price), num(r.total),
      r.kind === 'income' ? 'وارد' : 'مصروف',
    ].map(q).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

// ───────────── audio ─────────────
/** Float32 mono samples → 16-bit PCM WAV bytes */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
