// In-memory stand-in for supabase-js used ONLY by the browser UI test (tests/ui_test.py).
// It mimics the subset of the API the app uses, including the save_expense / my_vocab RPCs.
(function () {
  const db = { expenses: [], expense_items: [], debts: [], debt_payments: [], ai_usage: [{ month: monthKey(new Date()), calls: 3 }] };
  const storage = new Map();
  const log = [];
  window.__fake = { db, storage, log };
  function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  const uuid = () => crypto.randomUUID();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 15));

  let session = null;
  const listeners = [];
  const emit = (ev) => listeners.forEach((cb) => cb(ev, session));
  const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'test@example.invalid' };

  function vItems() {
    return db.expense_items.map((i) => {
      const e = db.expenses.find((x) => x.id === i.expense_id) || {};
      return { ...i, spent_at: e.spent_at, merchant: e.merchant, merchant_address: e.merchant_address, place_name: e.place_name, purpose: e.purpose, source: e.source, kind: e.kind };
    });
  }

  function vDebts() {
    return db.debts.map((d) => {
      const pays = db.debt_payments.filter((p) => p.debt_id === d.id);
      const paid = Math.round(pays.reduce((a, p) => a + Number(p.amount), 0) * 100) / 100;
      const remaining = Math.max(Math.round((Number(d.amount) - paid) * 100) / 100, 0);
      return { ...d, paid, remaining, payments: pays.length, settled_at: remaining <= 0.004 ? (d.settled_at || new Date().toISOString()) : null };
    });
  }

  const DEFAULTS = {
    debts: () => ({ user_id: USER.id, currency: 'EUR', kind: 'personal', due_date: null, reason: null, note: null, source: 'manual', settled_at: null, started_at: new Date().toISOString(), created_at: new Date().toISOString() }),
    debt_payments: () => ({ user_id: USER.id, paid_at: new Date().toISOString(), note: null, source: 'manual', created_at: new Date().toISOString() }),
  };

  class Q {
    constructor(table) { this.table = table; this.op = 'select'; this.cols = '*'; this.f = []; this.ord = null; this.lim = null; this.rng = null; this.single = false; this.patch = null; }
    select(c = '*') { this.cols = c; return this; }
    update(p) { this.op = 'update'; this.patch = p; return this; }
    upsert(rows) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    gte(c, v) { this.f.push((r) => new Date(r[c]) >= new Date(v)); return this; }
    lt(c, v) { this.f.push((r) => new Date(r[c]) < new Date(v)); return this; }
    order(c, o = {}) { this.ord = { c, asc: o.ascending !== false }; return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.single = true; return this; }
    then(res, rej) { return delay().then(() => this.exec()).then(res, rej); }
    exec() {
      log.push({ table: this.table, op: this.op, cols: this.cols });
      if (!session) return { data: null, error: { message: 'JWT missing' } };
      if (this.op === 'upsert' || this.op === 'insert') {
        if (!db[this.table]) return { data: null, error: { message: 'unknown table ' + this.table } };
        for (const row of this.rows) {
          if (this.table === 'debt_payments' && !db.debts.some((d) => d.id === row.debt_id)) return { data: null, error: { message: 'new row violates row-level security policy' } };
          const ex = row.id && db[this.table].find((x) => x.id === row.id);
          if (ex) {
            if (this.op === 'insert') return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
            Object.assign(ex, clone(row));
          } else {
            db[this.table].push({ ...(DEFAULTS[this.table] ? DEFAULTS[this.table]() : {}), id: uuid(), ...clone(row) });
          }
        }
        return { data: null, error: null };
      }
      const base = this.table === 'v_items' ? vItems() : this.table === 'v_debts' ? vDebts() : db[this.table];
      if (!base) return { data: null, error: { message: 'unknown table ' + this.table } };
      let rows = base.filter((r) => this.f.every((fn) => fn(r)));
      if (this.op === 'update') {
        rows.forEach((r) => Object.assign(db[this.table].find((x) => x.id === r.id), this.patch));
        return { data: null, error: null };
      }
      if (this.op === 'delete') {
        const ids = new Set(rows.map((r) => r.id));
        db[this.table] = db[this.table].filter((r) => !ids.has(r.id));
        if (this.table === 'expenses') db.expense_items = db.expense_items.filter((i) => !ids.has(i.expense_id));
        if (this.table === 'debts') db.debt_payments = db.debt_payments.filter((p) => !ids.has(p.debt_id));
        return { data: null, error: null };
      }
      rows = clone(rows);
      if (this.ord) {
        const { c, asc } = this.ord;
        rows.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) rows = rows.slice(0, this.lim);
      if (this.cols.includes('expense_items(')) {
        rows.forEach((r) => { r.expense_items = clone(db.expense_items.filter((i) => i.expense_id === r.id)); });
      }
      if (this.single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
  }

  function saveExpense(p) {
    const id = p.id || uuid();
    let e = db.expenses.find((x) => x.id === id);
    const fields = {
      spent_at: p.spent_at || new Date().toISOString(), total: Number(p.total) || 0, currency: p.currency || 'EUR',
      merchant: p.merchant, merchant_address: p.merchant_address, purpose: p.purpose, note: p.note,
      payment_method: p.payment_method, place_name: p.place_name,
    };
    if (e) {
      Object.assign(e, fields);
      if (p.kind === 'income' || p.kind === 'expense') e.kind = p.kind;
      if ('lat' in p) e.lat = p.lat;
      if ('lng' in p) e.lng = p.lng;
      if (Array.isArray(p.receipt_paths)) e.receipt_paths = p.receipt_paths;
      db.expense_items = db.expense_items.filter((i) => i.expense_id !== id);
    } else {
      e = { id, user_id: USER.id, ...fields, kind: p.kind === 'income' ? 'income' : 'expense', source: p.source || 'manual', transcript: p.transcript, lat: p.lat, lng: p.lng,
        receipt_paths: p.receipt_paths || [], ai_model: p.ai_model, created_at: new Date().toISOString() };
      db.expenses.push(e);
    }
    (p.items || []).forEach((it, pos) => db.expense_items.push({
      id: uuid(), expense_id: id, user_id: USER.id, position: pos, name: it.name || 'غير محدد', name_original: it.name_original,
      category: it.category || 'أخرى', quantity: Number(it.quantity) || 1, unit: it.unit, unit_price: it.unit_price, total: Number(it.total) || 0,
    }));
    return id;
  }

  function vocab() {
    const cats = new Map();
    const incCats = new Map();
    const items = new Map();
    for (const i of db.expense_items) {
      const e = db.expenses.find((x) => x.id === i.expense_id) || {};
      const target = e.kind === 'income' ? incCats : cats;
      const c = target.get(i.category) || { name: i.category, n: 0, sum: 0 };
      c.n++; c.sum += i.total; target.set(i.category, c);
      if (e.kind === 'income') continue;
      const it = items.get(i.name) || { name: i.name, category: i.category, unit: i.unit, n: 0, sum: 0 };
      it.n++; it.sum += i.total; items.set(i.name, it);
    }
    const people = new Map();
    for (const d of db.debts) people.set(d.counterparty, { name: d.counterparty, n: ((people.get(d.counterparty) || {}).n || 0) + 1 });
    const sort = (m) => [...m.values()].sort((a, b) => b.n - a.n);
    return { categories: sort(cats), income_categories: sort(incCats), items: sort(items), counterparties: sort(people) };
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { return { data: { session }, error: null }; },
          onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', session), 10); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithPassword({ email, password }) {
            if (password !== 'test-password-123') return { data: {}, error: { message: 'Invalid login credentials' } };
            session = { access_token: 'fake-access-token', user: { ...USER, email } };
            setTimeout(() => emit('SIGNED_IN'), 10);
            return { data: { session }, error: null };
          },
          async signUp() { return { data: { session: null, user: null }, error: { message: 'Database error saving new user' } }; },
          async signOut() { session = null; setTimeout(() => emit('SIGNED_OUT'), 10); return { error: null }; },
          async resetPasswordForEmail() { return { error: null }; },
          async updateUser() { return { data: {}, error: null }; },
        },
        from(t) { return new Q(t); },
        async rpc(name, args) {
          await delay();
          log.push({ rpc: name, args: clone(args || {}) });
          if (!session) return { data: null, error: { message: 'JWT missing' } };
          if (name === 'save_expense') return { data: saveExpense(args.p), error: null };
          if (name === 'my_vocab') return { data: vocab(), error: null };
          return { data: null, error: { message: 'unknown rpc' } };
        },
        storage: {
          from(bucket) {
            return {
              async upload(path, blob, opts) { storage.set(path, { size: blob.size, type: opts && opts.contentType }); log.push({ upload: path, size: blob.size }); return { data: { path }, error: null }; },
              async remove(paths) { paths.forEach((p) => storage.delete(p)); return { data: [], error: null }; },
              async createSignedUrls(paths) {
                const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
                return { data: paths.map((p) => ({ path: p, signedUrl: px })), error: null };
              },
            };
          },
        },
      };
    },
  };
})();
