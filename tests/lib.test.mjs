// Unit tests for docs/lib.js – run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../docs/lib.js';

test('parseNum handles German, English and Arabic formats', () => {
  assert.equal(L.parseNum('12,5'), 12.5);
  assert.equal(L.parseNum('1.234,56'), 1234.56);
  assert.equal(L.parseNum('1,234.56'), 1234.56);
  assert.equal(L.parseNum('٣٥'), 35);
  assert.equal(L.parseNum('١٢٫٥'), 12.5);
  assert.equal(L.parseNum('4,50 €'), 4.5);
  assert.equal(L.parseNum('-2,10'), -2.1);
  assert.equal(L.parseNum(''), null);
  assert.equal(L.parseNum('abc'), null);
  assert.equal(L.parseNum(7), 7);
  assert.equal(L.parseNum(null), null);
});

test('money / number formatting', () => {
  assert.match(L.fmtMoney(1234.5), /1\.234,50\s€/);
  assert.equal(L.numInput(10.25), '10,25');
  assert.equal(L.numInput(null), '');
  assert.equal(L.fmtDuration(75), '01:15');
});

test('parseLocalStamp', () => {
  const d = L.parseLocalStamp('2026-11-05 14:30');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 14);
  assert.equal(L.parseLocalStamp('2026-02-31 10:00'), null);
  assert.equal(L.parseLocalStamp('garbage'), null);
  assert.equal(L.parseLocalStamp('2026-11-05').getHours(), 12);
});

test('periodRange – week starts Monday, running month compares same elapsed span', () => {
  const now = new Date(2026, 10, 6, 19, 0); // Fri 6 Nov 2026
  const w = L.periodRange('week', now);
  assert.equal(w.from.getDay(), 1);
  assert.equal(w.from.getDate(), 2);
  assert.equal(w.to.getDate(), 9);
  const m = L.periodRange('month', now);
  assert.equal(m.from.getDate(), 1);
  assert.equal(m.to.getMonth(), 11);
  assert.equal(m.prevFrom.getMonth(), 9);
  assert.equal(m.prevTo.getMonth(), 9);
  assert.equal(m.prevTo.getDate(), 6);
  assert.ok(m.running);
  const lm = L.periodRange('lastmonth', now);
  assert.equal(lm.from.getMonth(), 9);
  assert.equal(lm.to.getMonth(), 10);
  assert.equal(lm.prevTo.getTime(), lm.from.getTime());
  assert.ok(!lm.running);
  const y = L.periodRange('year', now);
  assert.equal(y.bucket, 'month');
  const c = L.periodRange('custom', now, { from: new Date(2026, 9, 10), to: new Date(2026, 9, 12) });
  assert.equal(c.from.getDate(), 10);
  assert.equal(c.to.getDate(), 13);
  assert.equal((c.to - c.from) / 86400000, 3);
});

test('normalizeAnalysis – cigarettes example, quantities and unit price', () => {
  const created = new Date(2026, 10, 6, 19, 0);
  const res = L.normalizeAnalysis({
    transcript: 'اشتريت علبتين دخان بعشرين يورو',
    needs_review: false,
    expenses: [{
      spent_at_local: null, at_current_location: true, merchant: 'Kiosk', currency: 'eur', total: 20,
      items: [{ name: 'دخان', category: 'دخان', quantity: 2, unit: 'علبة', unit_price: null, total: 20 }],
    }],
  }, { createdAt: created, imageCount: 0 });
  assert.equal(res.expenses.length, 1);
  const e = res.expenses[0];
  assert.equal(e.total, 20);
  assert.equal(e.items[0].unit_price, 10);
  assert.equal(e.currency, 'EUR');
  assert.equal(e.mismatch, false);
  assert.equal(res.needs_review, false);
  assert.equal(new Date(e.spent_at).getTime(), created.getTime());
});

test('normalizeAnalysis – receipt with discount, images, mismatch detection and date sanity', () => {
  const created = new Date(2026, 10, 6, 19, 0);
  const res = L.normalizeAnalysis({
    transcript: 'فاتورة من Kaufland',
    needs_review: false,
    expenses: [
      {
        spent_at_local: '2026-11-05 18:12', at_current_location: false, merchant: 'Kaufland', total: 9.5,
        image_indexes: [0, 7],
        items: [
          { name: 'حليب', category: 'أكل للبيت', quantity: 2, unit: 'لتر', unit_price: 1.25, total: 2.5 },
          { name: 'خبز', category: 'أكل للبيت', quantity: 1, total: 8 },
          { name: 'خصم', category: 'أكل للبيت', quantity: 1, total: -1 },
        ],
      },
      { spent_at_local: '2091-01-01 10:00', at_current_location: true, total: 5, items: [] },
    ],
  }, { createdAt: created, imageCount: 1 });
  const [a, b] = res.expenses;
  assert.equal(a.total, 9.5);
  assert.equal(a.mismatch, false);
  assert.deepEqual(a.image_indexes, [0]);
  assert.equal(new Date(a.spent_at).getDate(), 5);
  assert.equal(a.at_current_location, false);
  // second expense: no items but a total → synthesised item, implausible date ignored
  assert.equal(b.items.length, 1);
  assert.equal(b.total, 5);
  assert.equal(new Date(b.spent_at).getTime(), created.getTime());

  const mm = L.normalizeAnalysis({ needs_review: false, expenses: [{ total: 30, items: [{ name: 'x', category: 'y', quantity: 1, total: 25 }] }] },
    { createdAt: created, imageCount: 0 });
  assert.equal(mm.expenses[0].mismatch, true);
  assert.equal(mm.needs_review, true);
});

test('normalizeAnalysis – no GPS for purchases clearly earlier than the recording', () => {
  const created = new Date(2026, 10, 7, 9, 30);
  const one = (stamp) => L.normalizeAnalysis({
    expenses: [{ spent_at_local: stamp, at_current_location: true, total: 10, items: [{ name: 'دخان', category: 'دخان', quantity: 1, total: 10 }] }],
  }, { createdAt: created, imageCount: 0 }).expenses[0].at_current_location;
  assert.equal(one('2026-11-07 08:15'), false); // receipt 75 min old → photographed elsewhere
  assert.equal(one('2026-11-07 09:10'), true);  // receipt 20 min old → still near the shop
  assert.equal(one(null), true);                // "now"
  assert.equal(one('2026-11-06 12:00'), false); // yesterday
});

test('normalizeAnalysis – garbage input is safe', () => {
  const r = L.normalizeAnalysis(null, { createdAt: new Date(), imageCount: 2 });
  assert.deepEqual(r.expenses, []);
  const r2 = L.normalizeAnalysis({ expenses: [null, 5, { items: 'x' }] }, { createdAt: new Date(), imageCount: 0 });
  assert.deepEqual(r2.expenses, []);
});

test('toPayload produces RPC-ready payload with item sum as total', () => {
  const p = L.toPayload({
    id: 'abc', spent_at: '2026-11-06T18:00:00.000Z', merchant: '  ', purpose: 'للبيت', source: 'voice', lat: 50.9, lng: 'x',
    items: [{ name: 'دخان', category: 'دخان', quantity: '2', unit: 'علبة', unit_price: '10', total: '20' }, { name: '', category: '', quantity: null, total: 5 }],
  });
  assert.equal(p.total, 25);
  assert.equal(p.merchant, null);
  assert.equal(p.lat, 50.9);
  assert.equal(p.lng, null);
  assert.equal(p.items[1].name, 'غير محدد');
  assert.equal(p.items[1].category, 'أخرى');
  assert.equal(p.items[1].quantity, 1);
  assert.equal(p.items[0].unit_price, 10);
});

test('aggregate – categories, item quantities (30 packs = 300 €), places, series', () => {
  const rows = [];
  for (let i = 0; i < 15; i++) {
    rows.push({ expense_id: 'k' + i, spent_at: new Date(2026, 10, 1 + (i % 6), 10).toISOString(), name: 'دخان', category: 'دخان', quantity: 2, unit: 'علبة', total: 20, merchant: 'Kiosk' });
  }
  rows.push({ expense_id: 'm1', spent_at: new Date(2026, 10, 3, 12).toISOString(), name: 'أكل للبيت', category: 'أكل للبيت', quantity: 1, unit: null, total: 2000, merchant: null, place_name: 'Kaufland, Frechen' });
  rows.push({ expense_id: 'c1', spent_at: new Date(2026, 10, 4, 8).toISOString(), name: 'قهوة', category: 'قهوة ومشروبات', quantity: 1, unit: null, total: 50, purpose: 'للمكتب' });
  const range = L.periodRange('month', new Date(2026, 10, 6, 19));
  const agg = L.aggregate(rows, range);
  assert.equal(agg.total, 2350);
  assert.equal(agg.purchases, 17);
  assert.equal(agg.categories[0].name, 'أكل للبيت');
  const smoke = agg.categories.find((c) => c.name === 'دخان');
  assert.equal(smoke.total, 300);
  assert.equal(smoke.items[0].qty, '30 علبة');
  const food = agg.items.find((i) => i.name === 'أكل للبيت');
  assert.equal(food.qty, 'مرة واحدة');
  assert.equal(agg.places.find((p) => p.name === 'Kiosk').count, 15);
  assert.ok(agg.places.find((p) => p.name === 'Kaufland, Frechen'));
  assert.equal(agg.series.length, 30);
  assert.equal(agg.series.reduce((a, b) => a + b.total, 0), 2350);
});

test('toCSV – BOM, semicolons, decimal comma, quoting', () => {
  const csv = L.toCSV([{ spent_at: new Date(2026, 10, 6, 9, 5).toISOString(), merchant: 'A;B', place_name: null, purpose: 'x', category: 'دخان', name: 'دخان', name_original: 'Marlboro "Gold"', quantity: 2, unit: 'علبة', unit_price: 10, total: 20 }]);
  assert.ok(csv.startsWith('﻿'));
  const line = csv.split('\r\n')[1];
  assert.ok(line.startsWith('2026-11-06;09:05;"A;B";'));
  assert.ok(line.includes('"Marlboro ""Gold"""'));
  assert.ok(line.endsWith(';2;علبة;10;20;مصروف'));
  const inc = L.toCSV([{ spent_at: new Date(2026, 10, 6, 9, 5).toISOString(), kind: 'income', merchant: 'الشركة', category: 'راتب', name: 'راتب', quantity: 1, total: 2500 }]);
  assert.ok(inc.split('\r\n')[1].endsWith(';2500;وارد'));
});

test('normalizeAnalysis – incomes, debts, repayments, company money', () => {
  const created = new Date(2026, 10, 7, 10, 30);
  const open = [
    { ref: 'd1', id: 'D1', direction: 'owe', counterparty: 'أبو محمد', due_date: '2026-11-21', started_at: '2026-11-01' },
    { ref: 'd2', id: 'D2', direction: 'owe', counterparty: 'الشركة', kind: 'company_advance', due_date: null, started_at: '2026-10-01' },
    { ref: 'd3', id: 'D3', direction: 'owed', counterparty: 'سامر', due_date: '2026-11-30', started_at: '2026-11-02' },
  ];
  const r = L.normalizeAnalysis({
    transcript: 't', needs_review: false, question: null, expenses: [],
    incomes: [{ category: 'راتب', amount: '2500', from: 'FlexGips', currency: 'eur' }, { category: 'هدية', amount: 0 }],
    debts: [
      { direction: 'owe', counterparty: 'خالي', amount: 50, kind: 'personal', due_date: '2026-11-21' },
      { direction: 'owe', counterparty: 'المدير', amount: 500, kind: 'company_advance', due_date: '2099-01-01' },
      { direction: 'weird', counterparty: '', amount: 10, kind: 'nonsense', due_date: '21.11.2026' },
    ],
    repayments: [
      { direction: 'owe', counterparty: 'ابو  محمّد', amount: 100 },            // name normalisation
      { direction: 'owe', counterparty: 'الشركة', amount: 500, debt_ref: 'd2' }, // by ref
      { direction: 'owed', counterparty: 'سامر', amount: 40, debt_ref: 'd1' },   // wrong ref direction → by name
      { direction: 'owe', counterparty: 'شخص مجهول', amount: 5 },               // unmatched
    ],
  }, { createdAt: created, imageCount: 0, openDebts: open });
  assert.equal(r.incomes.length, 1);
  assert.equal(r.incomes[0].from, 'الشركة');
  assert.equal(r.incomes[0].amount, 2500);
  assert.equal(r.incomes[0].currency, 'EUR');
  assert.equal(r.debts.length, 3);
  assert.equal(r.debts[0].due_date, '2026-11-21');
  assert.equal(r.debts[1].counterparty, 'الشركة');   // company kinds always belong to the company
  assert.equal(r.debts[1].due_date, null);           // implausible date dropped
  assert.equal(r.debts[2].direction, 'owe');
  assert.equal(r.debts[2].kind, 'personal');
  assert.equal(r.debts[2].counterparty, 'غير معروف');
  assert.equal(r.debts[2].due_date, null);
  assert.deepEqual(r.repayments.map((p) => p.debt_id), ['D1', 'D2', 'D3', null]);
  assert.equal(r.needs_review, true);                // unmatched repayment needs a decision
});

test('matchDebt – earliest due date wins, ambiguous fuzzy names stay unmatched', () => {
  const open = [
    { id: 'A', direction: 'owe', counterparty: 'أحمد', due_date: '2026-12-01' },
    { id: 'B', direction: 'owe', counterparty: 'احمد', due_date: '2026-11-15' },
    { id: 'C', direction: 'owe', counterparty: 'أحمد علي', due_date: null },
    { id: 'D', direction: 'owe', counterparty: 'أحمد سمير', due_date: null },
  ];
  assert.equal(L.matchDebt(open, { counterparty: 'أحمد', direction: 'owe' }), 'B');
  assert.equal(L.matchDebt(open, { counterparty: 'أحمد', direction: 'owed' }), null);
  assert.equal(L.matchDebt(open, { counterparty: 'علي', direction: 'owe' }), 'C');
  assert.equal(L.matchDebt(open.slice(2), { counterparty: 'أحمد', direction: 'owe' }), null);
  assert.ok(L.isCompany('Firma') && L.isCompany('الشركة') && L.isCompany('شركة') && !L.isCompany('أبو محمد'));
});

test('debts – status, labels, summary, calendar link, payloads', () => {
  const now = new Date(2026, 10, 7, 10);
  const late = { direction: 'owe', counterparty: 'أبو محمد', amount: 150, paid: 100, remaining: 50, due_date: '2026-11-05' };
  const st = L.debtStatus(late, now);
  assert.equal(st.remaining, 50);
  assert.equal(st.overdue, true);
  assert.equal(L.dueLabel(st), 'متأخر يومان');
  assert.equal(Math.round(st.pct), 67);
  assert.equal(L.dueLabel(L.debtStatus({ amount: 10, due_date: '2026-11-07' }, now)), 'يستحق اليوم');
  assert.equal(L.dueLabel(L.debtStatus({ amount: 10, due_date: '2026-11-08' }, now)), 'يستحق غداً');
  assert.equal(L.dueLabel(L.debtStatus({ amount: 10, due_date: '2026-11-21' }, now)), 'يستحق بعد 14 يوماً');
  assert.equal(L.dueLabel(L.debtStatus({ amount: 10, paid: 10, remaining: 0 }, now)), 'مسدد ✓');
  const list = [
    late,
    { direction: 'owed', counterparty: 'سامر', amount: 100, remaining: 60, due_date: '2026-11-08' },
    { direction: 'owe', counterparty: 'الشركة', kind: 'company_advance', amount: 500, remaining: 500, due_date: null },
    { direction: 'owe', counterparty: 'x', amount: 20, remaining: 0, settled_at: '2026-11-06' },
  ];
  assert.deepEqual(L.debtsSummary(list, now), { owe: 550, owed: 60, overdue: 1, soon: 1, open: 3, companyOpen: 500 });
  assert.deepEqual(L.openDebts(list, now).map((d) => d.counterparty), ['أبو محمد', 'سامر', 'الشركة']);
  const url = L.debtCalendarUrl({ direction: 'owe', counterparty: 'أبو محمد', amount: 150, due_date: '2026-11-21', reason: 'سيارة' }, 50);
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text='));
  assert.ok(url.includes('&dates=20261121/20261122'));
  assert.ok(decodeURIComponent(url).includes('سداد دين لـ أبو محمد'));
  assert.equal(L.calendarUrl({ title: 'x', date: 'kein Datum' }), null);
  const dp = L.debtPayload({ id: 'i', direction: 'x', counterparty: ' ', amount: '12,5', kind: 'bad', due_date: '2026-1-1' });
  assert.equal(dp.direction, 'owe');
  assert.equal(dp.counterparty, 'غير معروف');
  assert.equal(dp.amount, 12.5);
  assert.equal(dp.kind, 'personal');
  assert.equal(dp.due_date, null);
  const pp = L.paymentPayload({ id: 'p', debt_id: 'D', amount: '40' });
  assert.equal(pp.amount, 40);
  assert.ok(pp.paid_at);
  assert.equal(L.daysAr(1), 'يوم واحد');
  assert.equal(L.daysAr(5), '5 أيام');
});

test('income – stored as expense row with kind income; aggregation by category and payer', () => {
  const e = L.incomeAsExpense({ received_at: '2026-11-07T09:00:00.000Z', from: 'الشركة', category: 'راتب', amount: 2500, currency: 'EUR' });
  const p = L.toPayload({ ...e, id: 'x' });
  assert.equal(p.kind, 'income');
  assert.equal(p.total, 2500);
  assert.equal(p.items[0].category, 'راتب');
  assert.equal(L.toPayload({ items: [] }).kind, 'expense');
  const agg = L.aggregateIncome([
    { expense_id: 'a', category: 'راتب', merchant: 'الشركة', total: 2500 },
    { expense_id: 'b', category: 'هدية', merchant: 'أبوي', total: 200 },
    { expense_id: 'c', category: 'راتب', merchant: 'الشركة', total: 100 },
  ]);
  assert.equal(agg.total, 2800);
  assert.equal(agg.count, 3);
  assert.deepEqual(agg.categories.map((c) => [c.name, c.total]), [['راتب', 2600], ['هدية', 200]]);
  assert.equal(agg.sources[0].name, 'الشركة');
  assert.equal(L.dueDateOf('2026-11-31'), null);
  assert.equal(L.dueDateOf('2026-11-30', new Date(2026, 10, 7)), '2026-11-30');
});

test('encodeWav writes a valid header', () => {
  const bytes = L.encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
  const v = new DataView(bytes.buffer);
  const tag = (o) => String.fromCharCode(...bytes.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(bytes.length, 44 + 8);
  assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
});

test('catEmoji & timesAr', () => {
  assert.equal(L.catEmoji('دخان'), '🚬');
  assert.equal(L.catEmoji('مطاعم وأكل خارج البيت'), '🍽️');
  assert.equal(L.catEmoji('أكل للبيت'), '🛒');
  assert.equal(L.catEmoji('قهوة ومشروبات'), '☕');
  assert.equal(L.catEmoji('شيء جديد'), '🏷️');
  assert.equal(L.timesAr(1), 'مرة واحدة');
  assert.equal(L.timesAr(2), 'مرتان');
  assert.equal(L.timesAr(5), '5 مرات');
  assert.equal(L.timesAr(12), '12 مرة');
});
