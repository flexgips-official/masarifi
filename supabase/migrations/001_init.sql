-- مصاريفي (Masarifi) – private expense tracker
-- Schema, row level security, RPCs, single-user lock, private receipt storage.

-- ───────────────────────── Tables ─────────────────────────
create table if not exists public.expenses (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  spent_at         timestamptz not null default now(),
  total            numeric(12,2) not null default 0,
  currency         text not null default 'EUR',
  merchant         text,
  merchant_address text,
  purpose          text,
  note             text,
  payment_method   text,
  source           text not null default 'voice'
                   check (source in ('voice','photo','photo_voice','text','manual')),
  transcript       text,
  lat              double precision,
  lng              double precision,
  place_name       text,
  receipt_paths    text[] not null default '{}',
  ai_model         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.expense_items (
  id            uuid primary key default gen_random_uuid(),
  expense_id    uuid not null references public.expenses(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position      integer not null default 0,
  name          text not null,              -- normalized Arabic name (aggregation key)
  name_original text,                       -- as printed on the receipt / as spoken
  category      text not null default 'أخرى',
  quantity      numeric(12,3) not null default 1,
  unit          text,
  unit_price    numeric(12,2),
  total         numeric(12,2) not null default 0
);

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month   text not null,                    -- YYYY-MM (Europe/Berlin)
  calls   integer not null default 0,
  primary key (user_id, month)
);

create index if not exists expenses_user_spent_idx on public.expenses (user_id, spent_at desc);
create index if not exists expense_items_expense_idx on public.expense_items (expense_id);
create index if not exists expense_items_user_cat_idx on public.expense_items (user_id, category);
create index if not exists expense_items_user_name_idx on public.expense_items (user_id, name);

-- ───────────────────────── Row level security ─────────────────────────
alter table public.expenses      enable row level security;
alter table public.expense_items enable row level security;
alter table public.ai_usage      enable row level security;

drop policy if exists expenses_owner on public.expenses;
create policy expenses_owner on public.expenses
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists expense_items_owner on public.expense_items;
create policy expense_items_owner on public.expense_items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.expenses e
                where e.id = expense_id and e.user_id = (select auth.uid()))
  );

drop policy if exists ai_usage_read on public.ai_usage;
create policy ai_usage_read on public.ai_usage
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Items joined with their expense (runs with the caller's rights → RLS applies)
create or replace view public.v_items with (security_invoker = true) as
  select i.id, i.expense_id, i.user_id, i.position, i.name, i.name_original, i.category,
         i.quantity, i.unit, i.unit_price, i.total,
         e.spent_at, e.merchant, e.merchant_address, e.place_name, e.purpose, e.source
  from public.expense_items i
  join public.expenses e on e.id = i.expense_id;

-- Explicit privileges (nothing for anon)
revoke all on public.expenses, public.expense_items, public.ai_usage, public.v_items from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.expenses, public.expense_items to authenticated;
grant select on public.ai_usage, public.v_items to authenticated;

-- ───────────────────────── RPC: save (insert or update) one expense with its items ─────────────────────────
create or replace function public.save_expense(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id  uuid;
  it    jsonb;
  i     integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_id := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());

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
                                 receipt_paths, ai_model)
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
      nullif(p->>'ai_model', '')
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

-- ───────────────────────── RPC: vocabulary (known categories + item names) ─────────────────────────
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
      from (select category as c, count(*) as n, sum(total) as s
            from public.expense_items group by category) a
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'category', category, 'unit', unit, 'n', n, 'sum', s)
                       order by n desc)
      from (select name,
                   mode() within group (order by category) as category,
                   mode() within group (order by unit)     as unit,
                   count(*)   as n,
                   sum(total) as s
            from public.expense_items
            group by name
            order by count(*) desc
            limit 400) b
    ), '[]'::jsonb)
  );
$$;

-- ───────────────────────── RPC: AI usage counter (also verifies the caller) ─────────────────────────
create or replace function public.ai_tick()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid      uuid := auth.uid();
  owner_id uuid;
  m        text;
  c        integer;
  lim      constant integer := 500;   -- hard monthly cap on AI calls (cost protection)
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select id into owner_id from auth.users order by created_at asc limit 1;
  if owner_id is distinct from uid then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  m := to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM');
  insert into public.ai_usage (user_id, month, calls) values (uid, m, 1)
  on conflict (user_id, month) do update set calls = public.ai_usage.calls + 1
  returning calls into c;
  if c > lim then
    raise exception 'monthly limit reached (%)', lim using errcode = 'P0001';
  end if;
  return c;
end;
$$;

revoke execute on function public.save_expense(jsonb) from public, anon;
revoke execute on function public.my_vocab()          from public, anon;
revoke execute on function public.ai_tick()           from public, anon;
grant  execute on function public.save_expense(jsonb) to authenticated;
grant  execute on function public.my_vocab()          to authenticated;
grant  execute on function public.ai_tick()           to authenticated;

-- ───────────────────────── Single-user lock: only the first account may ever register ─────────────────────────
create or replace function public.only_one_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users) then
    raise exception 'registration closed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.only_one_user() from public, anon, authenticated;

drop trigger if exists only_one_user on auth.users;
create trigger only_one_user
  before insert on auth.users
  for each row execute function public.only_one_user();

-- ───────────────────────── Private storage for receipt photos ─────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_select on storage.objects;
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_update on storage.objects;
drop policy if exists receipts_delete on storage.objects;

create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_update on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
