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
