-- TEST / LIVE environment guard.
--
-- Adds a one-row marker that says which environment a database belongs to,
-- and database-level guards that keep payment modes in their own environment.
--
-- Safe on LIVE: until a marker row exists every guard is a no-op, so applying
-- this migration changes no behaviour. The marker is set separately, by the
-- database owner, with tools/environments/sql/mark-test.sql (TEST project) or
-- mark-live.sql (production). The API roles can read the marker but can never
-- write it, so neither the website nor the app can switch environments.
--
-- Safe to run twice: every object uses if not exists / create or replace /
-- drop ... if exists.

begin;

create table if not exists public.app_environment (
  id boolean primary key default true check (id),
  environment text not null check (environment in ('test', 'live')),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  label text not null check (length(label) between 1 and 60),
  -- LIVE only: true while the shop still runs on Yoco test keys (before
  -- go-live). Set to false at go-live so test-mode payments are refused.
  allow_test_payments boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.app_environment enable row level security;
revoke all on table public.app_environment from public, anon, authenticated, service_role;
-- Non-secret identifiers only. The project ref is already public (it is part
-- of the Supabase URL that the website and app ship with).
grant select (environment, project_ref, label) on table public.app_environment to anon, authenticated;
grant select on table public.app_environment to service_role;

drop policy if exists "app_environment_read" on public.app_environment;
create policy "app_environment_read" on public.app_environment
  for select to anon, authenticated using (true);

-- Which environment is this database? NULL when the marker is not set yet.
create or replace function public.current_app_environment()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select environment from public.app_environment where id;
$$;
revoke all on function public.current_app_environment() from public;
grant execute on function public.current_app_environment() to anon, authenticated, service_role;

-- Destructive scripts call this first, inside their own transaction:
--   select public.assert_app_environment('test');
-- It raises unless the marker says exactly that environment.
create or replace function public.assert_app_environment(p_expected text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actual text := public.current_app_environment();
begin
  if p_expected is null or p_expected not in ('test', 'live') then
    raise exception 'assert_app_environment: expected must be test or live';
  end if;
  if actual is distinct from p_expected then
    raise exception 'Environment check failed: this database is %, not %',
      coalesce(actual, 'unmarked'), p_expected
      using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.assert_app_environment(text) from public;
grant execute on function public.assert_app_environment(text) to service_role;

-- A TEST database refuses live-mode payments; a LIVE database refuses
-- test-mode payments once allow_test_payments is switched off at go-live.
-- Works on any table with a yoco_mode or mode column.
create or replace function public.enforce_payment_mode_environment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  env public.app_environment%rowtype;
  row_json jsonb := to_jsonb(new);
  payment_mode text := coalesce(row_json ->> 'yoco_mode', row_json ->> 'mode');
begin
  if payment_mode is null then
    return new;
  end if;
  select * into env from public.app_environment where id;
  if not found then
    return new; -- unmarked database: legacy behaviour
  end if;
  if env.environment = 'test' and payment_mode = 'live' then
    raise exception 'Live payment rejected: this is the TEST database'
      using errcode = 'P0001';
  end if;
  if env.environment = 'live' and payment_mode = 'test' and not env.allow_test_payments then
    raise exception 'Test payment rejected: this is the LIVE database'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_payment_mode_environment() from public;

drop trigger if exists orders_payment_mode_environment on public.orders;
create trigger orders_payment_mode_environment
before insert or update of yoco_mode on public.orders
for each row execute procedure public.enforce_payment_mode_environment();

drop trigger if exists checkout_intents_payment_mode_environment on public.checkout_intents;
create trigger checkout_intents_payment_mode_environment
before insert or update of yoco_mode on public.checkout_intents
for each row execute procedure public.enforce_payment_mode_environment();

drop trigger if exists payments_payment_mode_environment on public.payments;
create trigger payments_payment_mode_environment
before insert or update of mode on public.payments
for each row execute procedure public.enforce_payment_mode_environment();

drop trigger if exists payment_refunds_payment_mode_environment on public.payment_refunds;
create trigger payment_refunds_payment_mode_environment
before insert or update of mode on public.payment_refunds
for each row execute procedure public.enforce_payment_mode_environment();

commit;
