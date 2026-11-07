-- مصاريفي 2.0 – income (وارد), debts (ديون) and repayments (سداد)
-- Backward compatible: existing rows become kind = 'expense'; old app versions keep working.

-- ───────────────────────── 1) Income lives in expenses with kind = 'income' ─────────────────────────
alter table public.expenses add column if not exists kind text not null default 'expense';
alter table public.expenses drop constraint if exists expenses_kind_check;
alter table public.expenses add constraint expenses_kind_check check (kind in ('expense', 'income'));
create index if not exists expenses_user_kind_spent_idx on public.expenses (user_id, kind, spent_at desc);

-- ───────────────────────── 2) Debts and repayments ─────────────────────────
create table if not exists public.debts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction    text not null check (direction in ('owe', 'owed')),   -- owe = عليّ (I owe), owed = لي (owed to me)
  counterparty text not null,                                         -- person, or 'الشركة'
  amount       numeric(12,2) not null check (amount > 0),
  currency     text not null default 'EUR',
  started_at   timestamptz not null default now(),
  due_date     date,
  kind         text not null default 'personal'
               check (kind in ('personal', 'company_advance', 'company_loan')),
  reason       text,
  note         text,
  source       text not null default 'manual'
               check (source in ('voice', 'photo', 'photo_voice', 'text', 'manual')),
  transcript   text,
  lat          double precision,
  lng          double precision,
  place_name   text,
  ai_model     text,
  settled_at   timestamptz,                                           -- maintained automatically
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.debt_payments (
  id         uuid primary key default gen_random_uuid(),
  debt_id    uuid not null references public.debts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  paid_at    timestamptz not null default now(),
  amount     numeric(12,2) not null check (amount > 0),
  note       text,
  source     text not null default 'manual'
             check (source in ('voice', 'photo', 'photo_voice', 'text', 'manual')),
  transcript text,
  created_at timestamptz not null default now()
);

create index if not exists debts_user_idx on public.debts (user_id, settled_at, due_date);
create index if not exists debt_payments_debt_idx on public.debt_payments (debt_id);
create index if not exists debt_payments_user_idx on public.debt_payments (user_id, paid_at desc);

alter table public.debts         enable row level security;
alter table public.debt_payments enable row level security;

drop policy if exists debts_owner on public.debts;
create policy debts_owner on public.debts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists debt_payments_owner on public.debt_payments;
create policy debt_payments_owner on public.debt_payments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.debts d
                where d.id = debt_id and d.user_id = (select auth.uid()))
  );

-- settled_at follows the payments automatically (fully repaid ⇒ settled)
create or replace function public.debts_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_paid numeric;
begin
  select coalesce(sum(p.amount), 0) into v_paid from public.debt_payments p where p.debt_id = new.id;
  if v_paid >= new.amount - 0.004 then
    new.settled_at := coalesce(new.settled_at, now());
  else
    new.settled_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists debts_before_write on public.debts;
create trigger debts_before_write
  before insert or update on public.debts
  for each row execute function public.debts_before_write();

create or replace function public.debt_payments_after_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.debts set updated_at = now() where id = old.debt_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.debts set updated_at = now() where id = new.debt_id;
  end if;
  return null;
end;
$$;

drop trigger if exists debt_payments_after_write on public.debt_payments;
create trigger debt_payments_after_write
  after insert or update or delete on public.debt_payments
  for each row execute function public.debt_payments_after_write();

revoke execute on function public.debts_before_write()        from public, anon;
revoke execute on function public.debt_payments_after_write() from public, anon;

-- Debts with paid / remaining amounts (caller's rights → RLS applies)
create or replace view public.v_debts with (security_invoker = true) as
  select d.id, d.user_id, d.direction, d.counterparty, d.amount, d.currency, d.started_at, d.due_date, d.kind,
         d.reason, d.note, d.source, d.transcript, d.lat, d.lng, d.place_name, d.ai_model,
         d.settled_at, d.created_at, d.updated_at,
         coalesce(p.paid, 0)::numeric(12,2)                         as paid,
         greatest(d.amount - coalesce(p.paid, 0), 0)::numeric(12,2) as remaining,
         coalesce(p.n, 0)::integer                                  as payments,
         p.last_paid_at
  from public.debts d
  left join lateral (
    select sum(x.amount) as paid, count(*) as n, max(x.paid_at) as last_paid_at
    from public.debt_payments x
    where x.debt_id = d.id
  ) p on true;

-- ───────────────────────── 3) v_items gets the entry kind (appended column) ─────────────────────────
create or replace view public.v_items with (security_invoker = true) as
  select i.id, i.expense_id, i.user_id, i.position, i.name, i.name_original, i.category,
         i.quantity, i.unit, i.unit_price, i.total,
         e.spent_at, e.merchant, e.merchant_address, e.place_name, e.purpose, e.source, e.kind
  from public.expense_items i
  join public.expenses e on e.id = i.expense_id;

-- ───────────────────────── 4) Privileges ─────────────────────────
revoke all on public.debts, public.debt_payments, public.v_debts from anon;
grant select, insert, update, delete on public.debts, public.debt_payments to authenticated;
grant select on public.v_debts, public.v_items to authenticated;

-- ───────────────────────── 5) save_expense understands kind ─────────────────────────
create or replace function public.save_expense(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id   uuid;
  v_kind text;
  it     jsonb;
  i      integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_id := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
  v_kind := case when p->>'kind' in ('expense', 'income') then p->>'kind' else null end;

  if exists (select 1 from public.expenses where id = v_id) then
    update public.expenses set
      spent_at         = coalesce((p->>'spent_at')::timestamptz, spent_at),
      total            = coalesce((p->>'total')::numeric, 0),
      currency         = coalesce(nullif(p->>'currency', ''), 'EUR'),
      merchant         = nullif(btrim(p->>'merchant'), ''),
      merchant_address = nullif(btrim(p->>'merchant_address'), ''),
      purpose          = nullif(btrim(p->>'purpose'), ''),
      note             = nullif(btrim(p->>'note'), ''),
      payment_method   = nullif(btrim(p->>'payment_method'), ''),
      place_name       = nullif(btrim(p->>'place_name'), ''),
      kind             = coalesce(v_kind, kind),
      lat              = case when p ? 'lat' then (p->>'lat')::double precision else lat end,
      lng              = case when p ? 'lng' then (p->>'lng')::double precision else lng end,
      receipt_paths    = case when jsonb_typeof(p->'receipt_paths') = 'array'
                              then array(select jsonb_array_elements_text(p->'receipt_paths'))
                              else receipt_paths end,
      updated_at       = now()
    where id = v_id;
    delete from public.expense_items where expense_id = v_id;
  else
    insert into public.expenses (id, spent_at, total, currency, merchant, merchant_address, purpose,
                                 note, payment_method, source, transcript, lat, lng, place_name,
                                 receipt_paths, ai_model, kind)
    values (
      v_id,
      coalesce((p->>'spent_at')::timestamptz, now()),
      coalesce((p->>'total')::numeric, 0),
      coalesce(nullif(p->>'currency', ''), 'EUR'),
      nullif(btrim(p->>'merchant'), ''),
      nullif(btrim(p->>'merchant_address'), ''),
      nullif(btrim(p->>'purpose'), ''),
      nullif(btrim(p->>'note'), ''),
      nullif(btrim(p->>'payment_method'), ''),
      coalesce(nullif(p->>'source', ''), 'manual'),
      nullif(p->>'transcript', ''),
      (p->>'lat')::double precision,
      (p->>'lng')::double precision,
      nullif(btrim(p->>'place_name'), ''),
      case when jsonb_typeof(p->'receipt_paths') = 'array'
           then array(select jsonb_array_elements_text(p->'receipt_paths'))
           else '{}'::text[] end,
      nullif(p->>'ai_model', ''),
      coalesce(v_kind, 'expense')
    );
  end if;

  for it in select value from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    insert into public.expense_items (expense_id, position, name, name_original, category,
                                      quantity, unit, unit_price, total)
    values (
      v_id,
      i,
      coalesce(nullif(btrim(it->>'name'), ''), 'غير محدد'),
      nullif(btrim(it->>'name_original'), ''),
      coalesce(nullif(btrim(it->>'category'), ''), 'أخرى'),
      coalesce(nullif(it->>'quantity', '')::numeric, 1),
      nullif(btrim(it->>'unit'), ''),
      nullif(it->>'unit_price', '')::numeric,
      coalesce(nullif(it->>'total', '')::numeric, 0)
    );
    i := i + 1;
  end loop;

  return v_id;
end;
$$;

-- ───────────────────────── 6) Vocabulary: expense vs income categories, known people ─────────────────────────
create or replace function public.my_vocab()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c, 'n', n, 'sum', s) order by n desc)
      from (select i.category as c, count(*) as n, sum(i.total) as s
            from public.expense_items i join public.expenses e on e.id = i.expense_id
            where e.kind = 'expense'
            group by i.category) a
    ), '[]'::jsonb),
    'income_categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c, 'n', n, 'sum', s) order by n desc)
      from (select i.category as c, count(*) as n, sum(i.total) as s
            from public.expense_items i join public.expenses e on e.id = i.expense_id
            where e.kind = 'income'
            group by i.category) a
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'category', category, 'unit', unit, 'n', n, 'sum', s)
                       order by n desc)
      from (select i.name,
                   mode() within group (order by i.category) as category,
                   mode() within group (order by i.unit)     as unit,
                   count(*)     as n,
                   sum(i.total) as s
            from public.expense_items i join public.expenses e on e.id = i.expense_id
            where e.kind = 'expense'
            group by i.name
            order by count(*) desc
            limit 400) b
    ), '[]'::jsonb),
    'counterparties', coalesce((
      select jsonb_agg(jsonb_build_object('name', counterparty, 'n', n) order by n desc)
      from (select counterparty, count(*) as n from public.debts
            group by counterparty order by count(*) desc limit 100) c
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.save_expense(jsonb) from public, anon;
revoke execute on function public.my_vocab()          from public, anon;
grant  execute on function public.save_expense(jsonb) to authenticated;
grant  execute on function public.my_vocab()          to authenticated;
