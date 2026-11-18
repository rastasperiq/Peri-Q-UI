-- Distance-based delivery pricing (17 Nov 2026).
--
-- Replaces the fixed delivery fee with:
--   fee = max(base fee + driving km x price per km, minimum fee), rounded to cents
-- Driving distance comes from the Google Routes API, called only by the
-- website server (/api/delivery/quote) with a server-side key. The server
-- stores the distance as a delivery quote; checkout accepts a delivery only
-- with a valid quote owned by the customer for the same address, and works
-- out the fee itself from the quote's distance and the current settings.
-- Clients never send a fee the server trusts.
begin;

-- 1) Pricing settings ------------------------------------------------------
alter table public.app_settings
  add column if not exists delivery_base_fee numeric(10, 2) not null default 15,
  add column if not exists delivery_price_per_km numeric(10, 2) not null default 4,
  add column if not exists delivery_min_fee numeric(10, 2) not null default 20,
  add column if not exists delivery_max_distance_km numeric(6, 2) not null default 15,
  -- Subtotal at or above which delivery is free. Null = disabled.
  add column if not exists delivery_free_threshold numeric(10, 2),
  add column if not exists restaurant_address text not null
    default '28 King Edward Rd, Bloemfontein, Free State 9301, South Africa';

alter table public.app_settings drop constraint if exists app_settings_delivery_pricing_check;
alter table public.app_settings add constraint app_settings_delivery_pricing_check check (
  delivery_base_fee between 0 and 1000
  and delivery_price_per_km between 0 and 1000
  and delivery_min_fee between 0 and 1000
  and delivery_max_distance_km > 0 and delivery_max_distance_km <= 100
  and (delivery_free_threshold is null or delivery_free_threshold between 0 and 100000)
  and length(trim(restaurant_address)) between 8 and 300
);

-- 2) Snapshot columns on orders and their checkout drafts ------------------
-- finalize_card_checkout copies every orders column from checkout_intents by
-- name, so both tables get the same columns.
alter table public.orders
  add column if not exists delivery_distance_km numeric(7, 2),
  add column if not exists delivery_fee numeric(10, 2),
  add column if not exists delivery_quote_id uuid,
  add column if not exists delivery_pricing jsonb;
alter table public.checkout_intents
  add column if not exists delivery_distance_km numeric(7, 2),
  add column if not exists delivery_fee numeric(10, 2),
  add column if not exists delivery_quote_id uuid,
  add column if not exists delivery_pricing jsonb;

-- 3) Delivery quotes --------------------------------------------------------
create or replace function public.normalize_delivery_address(p_address text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g'))
$$;

create table if not exists public.delivery_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  address text not null check (length(address) between 8 and 500),
  address_key text not null,
  distance_meters integer not null check (distance_meters >= 0),
  distance_km numeric(7, 2) not null check (distance_km >= 0),
  duration_seconds integer check (duration_seconds >= 0),
  destination_lat double precision,
  destination_lng double precision,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);
create index if not exists delivery_quotes_lookup
  on public.delivery_quotes (user_id, address_key, expires_at desc);
create index if not exists delivery_quotes_expiry on public.delivery_quotes (expires_at);

alter table public.delivery_quotes enable row level security;
revoke all on public.delivery_quotes from anon, authenticated;
grant all on public.delivery_quotes to service_role;
-- No client policies: quotes are written and read only by the server and by
-- security-definer checkout functions.

-- The single pricing formula. Distance is rounded to 0.01 km first so the
-- customer can check the sum shown at checkout.
create or replace function public.delivery_fee_for_distance(
  p_distance_km numeric,
  p_settings public.app_settings
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(
    greatest(
      p_settings.delivery_base_fee + round(p_distance_km, 2) * p_settings.delivery_price_per_km,
      p_settings.delivery_min_fee
    ),
    2
  )
$$;

create or replace function public.delivery_quote_json(
  q public.delivery_quotes,
  s public.app_settings
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', q.id,
    'address', q.address,
    'distance_km', q.distance_km,
    'duration_minutes', ceil(coalesce(q.duration_seconds, 0) / 60.0)::integer,
    'within_range', q.distance_km <= s.delivery_max_distance_km,
    'delivery_fee', public.delivery_fee_for_distance(q.distance_km, s),
    'base_fee', s.delivery_base_fee,
    'price_per_km', s.delivery_price_per_km,
    'min_fee', s.delivery_min_fee,
    'max_distance_km', s.delivery_max_distance_km,
    'free_delivery_threshold', s.delivery_free_threshold,
    'expires_at', q.expires_at
  )
$$;

-- Reuse an unexpired quote for the same customer and address, so editing the
-- cart or reopening checkout does not call the routing service again.
create or replace function public.find_delivery_quote(p_user_id uuid, p_address text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  q public.delivery_quotes%rowtype;
  s public.app_settings%rowtype;
begin
  select * into s from public.app_settings where id = 'default';
  select * into q
  from public.delivery_quotes
  where user_id = p_user_id
    and address_key = public.normalize_delivery_address(p_address)
    and expires_at > now() + interval '10 minutes'
  order by created_at desc
  limit 1;
  if q.id is null or s.id is null then
    return null;
  end if;
  return public.delivery_quote_json(q, s);
end;
$$;

create or replace function public.record_delivery_quote(
  p_user_id uuid,
  p_address text,
  p_distance_meters integer,
  p_duration_seconds integer,
  p_destination_lat double precision,
  p_destination_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  q public.delivery_quotes%rowtype;
  s public.app_settings%rowtype;
begin
  if p_user_id is null or length(btrim(coalesce(p_address, ''))) < 8 then
    raise exception 'A delivery address is required.' using errcode = '22023';
  end if;
  if p_distance_meters is null or p_distance_meters < 0 or p_distance_meters > 2000000 then
    raise exception 'Invalid route distance.' using errcode = '22023';
  end if;
  select * into s from public.app_settings where id = 'default';
  if s.id is null then
    raise exception 'Store settings are unavailable.' using errcode = 'P0001';
  end if;
  insert into public.delivery_quotes (
    user_id, address, address_key, distance_meters, distance_km,
    duration_seconds, destination_lat, destination_lng
  ) values (
    p_user_id, left(btrim(p_address), 500), public.normalize_delivery_address(p_address),
    p_distance_meters, round(p_distance_meters / 1000.0, 2),
    greatest(coalesce(p_duration_seconds, 0), 0), p_destination_lat, p_destination_lng
  ) returning * into q;
  return public.delivery_quote_json(q, s);
end;
$$;

revoke all on function public.find_delivery_quote(uuid, text) from public, anon, authenticated;
revoke all on function public.record_delivery_quote(uuid, text, integer, integer, double precision, double precision) from public, anon, authenticated;
grant execute on function public.find_delivery_quote(uuid, text) to service_role;
grant execute on function public.record_delivery_quote(uuid, text, integer, integer, double precision, double precision) to service_role;
revoke all on function public.delivery_quote_json(public.delivery_quotes, public.app_settings) from public, anon, authenticated;
grant execute on function public.normalize_delivery_address(text) to anon, authenticated, service_role;
grant execute on function public.delivery_fee_for_distance(numeric, public.app_settings) to anon, authenticated, service_role;

-- 4) Checkout: trusted delivery fee from a valid quote ---------------------
drop function if exists public.prepare_card_checkout(text, text, text, text, text, numeric, text, jsonb);

create or replace function public.prepare_card_checkout(
  p_customer_name text,
  p_customer_phone text,
  p_order_type text,
  p_payment_method text,
  p_delivery_address text,
  p_expected_total numeric,
  p_client_request_id text,
  p_items jsonb,
  p_delivery_quote_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  settings public.app_settings%rowtype;
  quote public.delivery_quotes%rowtype;
  existing_draft public.checkout_intents%rowtype;
  created_order_id uuid;
  item_json jsonb;
  menu_row public.menu_items%rowtype;
  requested_add_on jsonb;
  trusted_add_on jsonb;
  trusted_add_ons jsonb;
  add_on_total numeric;
  items_total numeric := 0;
  trusted_total numeric := 0;
  trusted_delivery_fee numeric := 0;
  item_quantity integer;
  calculated_estimate integer := 0;
  local_time time;
  opening_value time;
  closing_value time;
  is_within_hours boolean;
begin
  if p_payment_method is distinct from 'yoco' then raise exception 'Only Yoco card payments are accepted.'; end if;
  if p_customer_name is null or p_customer_phone is null or p_expected_total is null or p_items is null or p_order_type is null then raise exception 'Missing checkout details.'; end if;
  if auth.uid() is null then
    raise exception 'A signed-in session is required.' using errcode = '42501';
  end if;
  if length(trim(p_customer_name)) not between 2 and 100 then
    raise exception 'Invalid customer name.' using errcode = '22023';
  end if;
  if length(trim(p_customer_phone)) not between 7 and 30 then
    raise exception 'Invalid customer phone.' using errcode = '22023';
  end if;
  if length(coalesce(p_client_request_id, '')) not between 8 and 200 then
    raise exception 'Invalid order request identifier.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'An order must contain between 1 and 50 items.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text || p_client_request_id));
  select * into existing_draft
  from public.checkout_intents
  where user_id = auth.uid() and client_request_id = p_client_request_id;

  -- A retried request may only reuse its draft while the request is unchanged.
  if existing_draft.id is not null then
    if existing_draft.order_type is distinct from p_order_type
       or existing_draft.total_price is distinct from p_expected_total
       or coalesce(existing_draft.delivery_address, '') is distinct from
          coalesce(
            case when p_order_type = 'delivery' then trim(p_delivery_address) else null end,
            ''
          )
    then
      raise exception 'Checkout details changed. Please restart checkout.' using errcode = 'P0001';
    end if;
    return jsonb_build_object('id', existing_draft.id);
  end if;

  select * into settings from public.app_settings where id = 'default';
  if settings.id is null or not settings.store_open then
    raise exception 'Ordering is paused.' using errcode = 'P0001';
  end if;
  local_time := timezone('Africa/Johannesburg', now())::time;
  opening_value := settings.opening_time::time;
  closing_value := settings.closing_time::time;
  is_within_hours := case
    when opening_value = closing_value then true
    when opening_value < closing_value then local_time >= opening_value and local_time < closing_value
    else local_time >= opening_value or local_time < closing_value
  end;
  if not is_within_hours then
    raise exception 'Store is closed.' using errcode = 'P0001';
  end if;
  if p_order_type = 'pickup' and not settings.pickup_available then
    raise exception 'Pickup is unavailable.' using errcode = 'P0001';
  elsif p_order_type = 'delivery' and not settings.delivery_available then
    raise exception 'Delivery is unavailable.' using errcode = 'P0001';
  elsif p_order_type not in ('pickup', 'delivery') then
    raise exception 'Invalid order type.' using errcode = '22023';
  end if;
  if p_order_type = 'delivery' and length(trim(coalesce(p_delivery_address, ''))) < 8 then
    raise exception 'A delivery address is required.' using errcode = '22023';
  end if;
  if p_payment_method is distinct from 'yoco' then
    raise exception 'Invalid payment method.' using errcode = '22023';
  end if;

  if p_order_type = 'delivery' then
    select * into quote
    from public.delivery_quotes
    where id = p_delivery_quote_id
      and user_id = auth.uid()
      and expires_at > now()
      and address_key = public.normalize_delivery_address(p_delivery_address);
    if quote.id is null then
      raise exception 'Delivery fee needs recalculating.' using errcode = 'P0001';
    end if;
    if quote.distance_km > settings.delivery_max_distance_km then
      raise exception 'Address is outside the delivery area.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.checkout_intents (
    user_id, customer_name, customer_phone, order_type, payment_method,
    total_price, status, estimated_minutes, delivery_address, client_request_id,
    payment_status
  ) values (
    auth.uid(), trim(p_customer_name), trim(p_customer_phone), p_order_type,
    p_payment_method, 0, 'pending', 0,
    case when p_order_type = 'delivery' then trim(p_delivery_address) else null end,
    p_client_request_id,
    'pending'
  ) returning id into created_order_id;

  for item_json in select value from jsonb_array_elements(p_items)
  loop
    item_quantity := (item_json ->> 'quantity')::integer;
    if item_quantity not between 1 and 50 then
      raise exception 'Invalid item quantity.' using errcode = '22023';
    end if;
    select * into menu_row
    from public.menu_items
    where id = item_json ->> 'menu_item_id'
    for share;
    if menu_row.id is null then
      raise exception 'Menu item not found.' using errcode = 'P0001';
    end if;
    if not menu_row.is_available then
      raise exception 'Menu item is unavailable.' using errcode = 'P0001';
    end if;
    if item_json ->> 'spice_level' is not null
       and not ((item_json ->> 'spice_level') = any(menu_row.spice_levels)) then
      raise exception 'Invalid spice selection.' using errcode = '22023';
    end if;
    if length(coalesce(item_json ->> 'notes', '')) > 500 then
      raise exception 'Item notes are too long.' using errcode = '22023';
    end if;

    trusted_add_ons := '[]'::jsonb;
    add_on_total := 0;
    for requested_add_on in
      select value from jsonb_array_elements(coalesce(item_json -> 'selected_add_ons', '[]'::jsonb))
    loop
      trusted_add_on := null;
      select value into trusted_add_on
      from jsonb_array_elements(menu_row.add_ons)
      where value ->> 'name' = requested_add_on ->> 'name'
      limit 1;
      if trusted_add_on is null then
        raise exception 'Invalid add-on selection.' using errcode = '22023';
      end if;
      trusted_add_ons := trusted_add_ons || jsonb_build_array(trusted_add_on);
      add_on_total := add_on_total + coalesce((trusted_add_on ->> 'price')::numeric, 0);
    end loop;

    items_total := items_total + ((menu_row.price + add_on_total) * item_quantity);
    calculated_estimate := greatest(calculated_estimate, menu_row.prep_minutes);
    insert into public.checkout_intent_items (
      order_id, menu_item_id, item_name, item_description, item_image_path,
      item_category, unit_price, quantity, spice_level, notes, selected_add_ons
    ) values (
      created_order_id, menu_row.id, menu_row.name, menu_row.description,
      menu_row.image_path, menu_row.category, menu_row.price, item_quantity,
      item_json ->> 'spice_level', left(coalesce(item_json ->> 'notes', ''), 500),
      trusted_add_ons
    );
  end loop;

  trusted_total := items_total;
  if p_order_type = 'delivery' then
    trusted_delivery_fee := case
      when settings.delivery_free_threshold is not null
           and items_total >= settings.delivery_free_threshold then 0
      else public.delivery_fee_for_distance(quote.distance_km, settings)
    end;
    trusted_total := trusted_total + trusted_delivery_fee;
    calculated_estimate := calculated_estimate + 20;
  end if;
  trusted_total := round(trusted_total, 2);
  if abs(trusted_total - p_expected_total) > 0.009 then
    raise exception 'Price changed before checkout.' using errcode = 'P0001';
  end if;

  update public.checkout_intents
  set total_price = trusted_total,
      estimated_minutes = greatest(calculated_estimate, 5),
      payment_amount_cents = round(trusted_total * 100)::integer,
      delivery_fee = case when p_order_type = 'delivery' then trusted_delivery_fee else null end,
      delivery_distance_km = case when p_order_type = 'delivery' then quote.distance_km else null end,
      delivery_quote_id = case when p_order_type = 'delivery' then quote.id else null end,
      delivery_pricing = case when p_order_type = 'delivery' then jsonb_build_object(
        'base_fee', settings.delivery_base_fee,
        'price_per_km', settings.delivery_price_per_km,
        'min_fee', settings.delivery_min_fee,
        'max_distance_km', settings.delivery_max_distance_km,
        'free_delivery_threshold', settings.delivery_free_threshold,
        'free_delivery_applied', trusted_delivery_fee = 0
          and settings.delivery_free_threshold is not null
          and items_total >= settings.delivery_free_threshold,
        'distance_meters', quote.distance_meters,
        'duration_seconds', quote.duration_seconds,
        'origin', settings.restaurant_address,
        'quoted_at', quote.created_at
      ) else null end
  where id = created_order_id;
  return jsonb_build_object('id', created_order_id);
end;
$$;

revoke all on function public.prepare_card_checkout(text, text, text, text, text, numeric, text, jsonb, uuid) from public, anon;
grant execute on function public.prepare_card_checkout(text, text, text, text, text, numeric, text, jsonb, uuid) to authenticated;

-- 5) Housekeeping: drop expired quotes daily (they hold customer addresses).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'delivery-quotes-cleanup';
    perform cron.schedule(
      'delivery-quotes-cleanup', '17 3 * * *',
      $cron$delete from public.delivery_quotes where expires_at < now() - interval '1 day'$cron$
    );
  end if;
end $$;

commit;
