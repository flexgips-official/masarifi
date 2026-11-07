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
  assert.ok(line.endsWith(';2;علبة;10;20'));
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
