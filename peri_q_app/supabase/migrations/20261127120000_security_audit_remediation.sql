-- Security audit remediation (November 2026): SA-002, SA-008, SA-012.
-- Additive and re-runnable. Apply to TEST first, then LIVE (DATABASE_ENVIRONMENTS.md).
-- Before LIVE: the LIVE database must already be marked LIVE (node db.mjs status
-- --env live), because unmarked databases now refuse live-mode payments.

begin;

-- SA-008: the policy versions customers may accept. The website and app send
-- the version they show; only versions listed here as accepting are recorded,
-- and payment needs a recorded acceptance for the exact checkout draft.
create table if not exists public.policy_versions (
  version text primary key check (length(version) between 1 and 60),
  accepting boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);
insert into public.policy_versions (version) values ('2026-11-03-draft')
on conflict (version) do nothing;

alter table public.policy_versions enable row level security;
revoke all on table public.policy_versions from anon, authenticated;
grant select on table public.policy_versions to authenticated;
grant select, insert, update on table public.policy_versions to service_role;
drop policy if exists "policy_versions_read" on public.policy_versions;
create policy "policy_versions_read" on public.policy_versions for select to authenticated using (true);

create or replace function public.record_policy_acceptance(
  p_version text,
  p_context text,
  p_client text,
  p_checkout_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  existing_id uuid;
  created_id uuid;
begin
  if caller_id is null then
    raise exception 'A signed-in session is required.' using errcode = '42501';
  end if;
  if length(coalesce(p_version, '')) not between 1 and 60
     or p_context not in ('signup', 'checkout')
     or p_client not in ('website', 'android') then
    raise exception 'Invalid policy acceptance.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.policy_versions where version = p_version and accepting) then
    raise exception 'These terms are out of date. Refresh the page and accept the current terms.' using errcode = '22023';
  end if;
  if p_checkout_id is not null then
    if not exists (
      select 1 from public.checkout_intents where id = p_checkout_id and user_id = caller_id
    ) then
      raise exception 'Checkout not found for this account.' using errcode = '42501';
    end if;
    select id into existing_id from public.policy_acceptances
    where user_id = caller_id and checkout_id = p_checkout_id;
    if existing_id is not null then
      return existing_id;
    end if;
  end if;

  insert into public.policy_acceptances (user_id, documents, version, context, client, checkout_id)
  values (caller_id, array['terms', 'privacy'], p_version, p_context, p_client, p_checkout_id)
  on conflict (user_id, checkout_id) where checkout_id is not null do nothing
  returning id into created_id;
  if created_id is null then
    select id into created_id from public.policy_acceptances
    where user_id = caller_id and checkout_id = p_checkout_id;
  end if;
  return created_id;
end;
$$;

revoke all on function public.record_policy_acceptance(text, text, text, uuid) from public, anon;
grant execute on function public.record_policy_acceptance(text, text, text, uuid) to authenticated;

-- Server check before a Yoco checkout is created: the caller accepted a
-- current version of the terms for this exact draft.
create or replace function public.checkout_policy_accepted(p_user_id uuid, p_checkout_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.policy_acceptances a
    join public.policy_versions v on v.version = a.version and v.accepting
    where a.user_id = p_user_id
      and a.checkout_id = p_checkout_id
      and a.context = 'checkout'
  );
$$;
revoke all on function public.checkout_policy_accepted(uuid, uuid) from public, anon, authenticated;
grant execute on function public.checkout_policy_accepted(uuid, uuid) to service_role;

-- SA-002: draft quotas and request bounds inside the checkout function.
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
  -- Bound the request before any work is done (audit SA-002).
  if pg_column_size(p_items) > 65536 then
    raise exception 'This order is too large.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as line
    where jsonb_typeof(line -> 'selected_add_ons') = 'array'
      and jsonb_array_length(line -> 'selected_add_ons') > 20
  ) then
    raise exception 'Too many add-ons on one item.' using errcode = '22023';
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

  -- New drafts only (a retried request returned above and costs nothing):
  -- cap how many checkouts one account can open, whether it calls this
  -- function through the website or directly (audit SA-002). The lock makes
  -- the count exact under concurrent calls.
  perform pg_advisory_xact_lock(hashtext('checkout-draft-quota:' || auth.uid()::text));
  if (select count(*) from public.checkout_intents
      where user_id = auth.uid() and created_at > now() - interval '10 minutes') >= 10
     or (select count(*) from public.checkout_intents
      where user_id = auth.uid() and created_at > now() - interval '1 day') >= 40 then
    raise exception 'Too many checkouts started. Please wait a few minutes and try again.' using errcode = 'P0001';
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

-- SA-012: an unmarked database never accepts live-mode payments.
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
    -- Real money only reaches a database marked LIVE (audit SA-012).
    if payment_mode = 'live' then
      raise exception 'Live payment rejected: this database is not marked LIVE'
        using errcode = 'P0001';
    end if;
    return new;
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

commit;
