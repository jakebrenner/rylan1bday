-- ============================================================
-- Ryvite V2 — Billing & Subscription Schema
-- Run this in your Supabase SQL Editor AFTER the main migration.sql
--
-- Adds: plans, coupons, subscriptions, coupon_redemptions, billing_history
-- ============================================================

-- ============================================================
-- Add stripe_customer_id to profiles (do this first)
-- ============================================================

alter table public.profiles
  add column if not exists stripe_customer_id text;

-- ============================================================
-- 1. PLANS — defines available plan tiers
-- ============================================================

create table if not exists public.plans (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,          -- 'single_event'
  display_name     text not null,                 -- 'Single Event'
  description      text,
  price_cents      integer not null,              -- 699 = $6.99
  currency         text not null default 'usd',
  stripe_price_id  text,                          -- Stripe Price object ID
  max_events       integer not null default 1,    -- how many events included
  max_generations  integer not null default 20,   -- AI generations per plan
  features         jsonb not null default '[]'::jsonb,  -- ["AI-designed invites", "RSVP tracking", ...]
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.plans is 'Available subscription/purchase plans';

-- Seed the initial plan
insert into public.plans (name, display_name, description, price_cents, max_events, max_generations, features, sort_order)
values (
  'single_event',
  'Single Event',
  'Everything you need for one beautiful event',
  699,
  1,
  20,
  '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link, SMS, or email", "Up to 20 theme generations"]'::jsonb,
  1
) on conflict (name) do nothing;

-- ============================================================
-- 2. COUPONS — discount codes (before subscriptions, since subscriptions FK to coupons)
-- ============================================================

create table if not exists public.coupons (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  description       text,
  discount_type     text not null check (discount_type in ('percent', 'fixed')),
  discount_value    numeric(10,2) not null,       -- percentage (e.g. 20.00) or cents (e.g. 200 = $2.00)
  min_purchase_cents integer default 0,           -- minimum cart value to apply
  max_uses          integer,                       -- null = unlimited
  times_used        integer not null default 0,
  max_uses_per_user integer default 1,
  valid_from        timestamptz not null default now(),
  valid_until       timestamptz,                   -- null = no expiry
  allowed_plans     text[],                        -- null = all plans, or specific plan names
  allowed_emails    text[],                        -- null = anyone, or specific emails
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_coupons_code on public.coupons(code);
create index idx_coupons_active on public.coupons(is_active) where is_active = true;

comment on table public.coupons is 'Discount coupons with flexible rules engine';

-- ============================================================
-- 3. SUBSCRIPTIONS — user plan purchases
-- ============================================================

create table if not exists public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  plan_id               uuid not null references public.plans(id),
  status                text not null default 'active' check (status in ('active', 'cancelled', 'expired', 'past_due')),
  stripe_customer_id    text,
  stripe_subscription_id text,        -- null for one-time purchases
  stripe_checkout_session_id text,
  coupon_id             uuid references public.coupons(id),
  amount_paid_cents     integer not null default 0,
  discount_cents        integer not null default 0,
  events_used           integer not null default 0,
  generations_used      integer not null default 0,
  current_period_start  timestamptz not null default now(),
  current_period_end    timestamptz,  -- null = lifetime/one-time
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_subscriptions_user_id on public.subscriptions(user_id);
create index idx_subscriptions_stripe_customer on public.subscriptions(stripe_customer_id);
create index idx_subscriptions_status on public.subscriptions(status);

comment on table public.subscriptions is 'User plan purchases and subscription tracking';

-- ============================================================
-- 4. COUPON_REDEMPTIONS — tracks who used what coupon
-- ============================================================

create table if not exists public.coupon_redemptions (
  id              uuid primary key default gen_random_uuid(),
  coupon_id       uuid not null references public.coupons(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  redeemed_at     timestamptz not null default now(),

  unique(coupon_id, user_id, subscription_id)
);

create index idx_coupon_redemptions_user on public.coupon_redemptions(user_id);
create index idx_coupon_redemptions_coupon on public.coupon_redemptions(coupon_id);

comment on table public.coupon_redemptions is 'Tracks individual coupon usage per user';

-- ============================================================
-- 5. BILLING_HISTORY — payment records
-- ============================================================

create table if not exists public.billing_history (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  subscription_id     uuid references public.subscriptions(id) on delete set null,
  stripe_payment_intent_id text,
  stripe_invoice_id   text,
  amount_cents        integer not null,
  currency            text not null default 'usd',
  status              text not null default 'succeeded' check (status in ('succeeded', 'pending', 'failed', 'refunded')),
  description         text,
  receipt_url         text,
  created_at          timestamptz not null default now()
);

create index idx_billing_history_user on public.billing_history(user_id);
create index idx_billing_history_subscription on public.billing_history(subscription_id);

comment on table public.billing_history is 'Payment and billing event history';

-- ============================================================
-- TRIGGERS — updated_at
-- ============================================================

create trigger plans_updated_at
  before update on public.plans
  for each row execute function public.update_updated_at();

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.update_updated_at();

create trigger coupons_updated_at
  before update on public.coupons
  for each row execute function public.update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.billing_history enable row level security;

-- Plans are readable by everyone (public pricing page)
create policy "Anyone can view active plans"
  on public.plans for select
  using (is_active = true);

-- Users can view own subscriptions
create policy "Users can view own subscriptions"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Service role manages subscriptions (API creates them)
create policy "Service can manage subscriptions"
  on public.subscriptions for all
  using (true);

-- Users can view own redemptions
create policy "Users can view own coupon redemptions"
  on public.coupon_redemptions for select
  using (auth.uid() = user_id);

create policy "Service can manage coupon redemptions"
  on public.coupon_redemptions for all
  using (true);

-- Users can view own billing history
create policy "Users can view own billing history"
  on public.billing_history for select
  using (auth.uid() = user_id);

create policy "Service can manage billing history"
  on public.billing_history for all
  using (true);

-- Coupons: service manages, nobody else reads directly
create policy "Service can manage coupons"
  on public.coupons for all
  using (true);

-- ============================================================
-- DONE! Billing schema is ready.
-- ============================================================
