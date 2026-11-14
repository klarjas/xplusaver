-- EcomStore marketplace schema
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone text,
  role text not null default 'customer' check (role in ('customer','vendor','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  store_name text not null,
  description text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','blocked')),
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  title text not null,
  description text not null default '',
  price numeric(12,2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  category text not null default 'General',
  status text not null default 'pending' check (status in ('pending','active','rejected','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  telegram_message_id text not null,
  file_id text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  status text not null default 'pending' check (status in ('pending','paid','processing','shipped','completed','cancelled')),
  total numeric(12,2) not null check (total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  vendor_id uuid not null references public.vendors(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0)
);

create index if not exists products_public_listing_idx on public.products(status, created_at desc);
create index if not exists products_vendor_idx on public.products(vendor_id);
create index if not exists product_images_product_idx on public.product_images(product_id, sort_order);

alter table public.profiles enable row level security;
alter table public.vendors enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Profiles: users can read/update their own profile. Admin operations use backend service role.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Public can browse approved vendors and active products.
drop policy if exists "vendors_read_approved" on public.vendors;
create policy "vendors_read_approved" on public.vendors for select using (status = 'approved' or user_id = auth.uid());
drop policy if exists "products_read_active" on public.products;
create policy "products_read_active" on public.products for select using (
  status = 'active' and exists (select 1 from public.vendors v where v.id = vendor_id and v.status = 'approved')
);
drop policy if exists "product_images_read_public" on public.product_images;
create policy "product_images_read_public" on public.product_images for select using (
  exists (select 1 from public.products p join public.vendors v on v.id = p.vendor_id
          where p.id = product_id and p.status = 'active' and v.status = 'approved')
);

-- Customers can only see their own orders and order items.
drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own" on public.orders for select using (customer_id = auth.uid());
drop policy if exists "order_items_select_own" on public.order_items;
create policy "order_items_select_own" on public.order_items for select using (
  exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())
);

-- Writes and privileged moderation are performed through the authenticated API using service role
-- after verifying the caller's Supabase access token and database ownership.


-- Marketplace completion migration: safe to re-run.
alter table public.orders
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists delivery_address text,
  add column if not exists delivery_note text,
  add column if not exists payment_method text not null default 'cash_on_delivery',
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists updated_at timestamptz not null default now();

alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('cash_on_delivery','bank_transfer'));
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid','pending_verification','paid','refunded'));

create index if not exists orders_customer_created_idx on public.orders(customer_id, created_at desc);
create index if not exists order_items_vendor_idx on public.order_items(vendor_id);

-- One atomic checkout: verifies stock and current prices, decrements inventory,
-- and writes the order plus line items in a single database transaction.
create or replace function public.place_marketplace_order(
  p_customer_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_delivery_note text,
  p_payment_method text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_total numeric(12,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
begin
  if p_customer_id is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_customer_name,''))) < 2 then raise exception 'Customer name is required'; end if;
  if length(trim(coalesce(p_customer_phone,''))) < 6 then raise exception 'Valid phone number is required'; end if;
  if length(trim(coalesce(p_delivery_address,''))) < 5 then raise exception 'Delivery address is required'; end if;
  if p_payment_method not in ('cash_on_delivery','bank_transfer') then raise exception 'Invalid payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'Cart is empty or too large';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 99 then raise exception 'Invalid quantity'; end if;
    select p.* into v_product
    from public.products p
    join public.vendors v on v.id = p.vendor_id
    where p.id = (v_item->>'product_id')::uuid
      and p.status = 'active' and v.status = 'approved'
    for update of p;
    if not found then raise exception 'A product is no longer available'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for %', v_product.title; end if;
    v_total := v_total + (v_product.price * v_qty);
  end loop;

  insert into public.orders(customer_id, customer_name, customer_phone, delivery_address,
    delivery_note, payment_method, payment_status, total)
  values(p_customer_id, trim(p_customer_name), trim(p_customer_phone), trim(p_delivery_address),
    nullif(trim(coalesce(p_delivery_note,'')),''), p_payment_method,
    case when p_payment_method = 'bank_transfer' then 'pending_verification' else 'unpaid' end,
    v_total)
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::integer;
    select p.* into v_product from public.products p
    where p.id = (v_item->>'product_id')::uuid for update;
    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;
    insert into public.order_items(order_id, product_id, vendor_id, quantity, unit_price)
    values(v_order_id, v_product.id, v_product.vendor_id, v_qty, v_product.price);
  end loop;
  return v_order_id;
end;
$$;

revoke all on function public.place_marketplace_order(uuid,text,text,text,text,text,jsonb) from public;
revoke all on function public.place_marketplace_order(uuid,text,text,text,text,text,jsonb) from anon;
revoke all on function public.place_marketplace_order(uuid,text,text,text,text,text,jsonb) from authenticated;
grant execute on function public.place_marketplace_order(uuid,text,text,text,text,text,jsonb) to service_role;

-- Allow owners and vendors to view their own operational records in the API.
drop policy if exists "vendors_read_approved" on public.vendors;
create policy "vendors_read_approved" on public.vendors for select
using (status = 'approved' or user_id = auth.uid());
alter table public.order_items add column if not exists fulfillment_status text not null default 'pending';
alter table public.order_items drop constraint if exists order_items_fulfillment_status_check;
alter table public.order_items add constraint order_items_fulfillment_status_check
  check (fulfillment_status in ('pending','processing','shipped','completed','cancelled'));

drop policy if exists "orders_vendor_select" on public.orders;
create policy "orders_vendor_select" on public.orders for select
using (exists (select 1 from public.order_items oi join public.vendors v on v.id = oi.vendor_id
  where oi.order_id = id and v.user_id = auth.uid()));


-- Prevent users from elevating their own role through the public profiles table.
revoke update on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update(display_name, phone) on public.profiles to authenticated;
