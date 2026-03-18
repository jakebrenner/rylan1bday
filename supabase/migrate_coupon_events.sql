-- ============================================================
-- Migration: Coupon Event Credits + Credit Ledger
-- Run this in your Supabase SQL Editor
--
-- Adds event credit support to coupons and creates an audit
-- ledger for tracking all credit movements per user.
-- ============================================================

-- ============================================================
-- 1. Add event credit fields to coupons table
-- ============================================================

alter table public.coupons
  add column if not exists event_credits integer not null default 0,
  add column if not exists coupon_type text not null default 'discount'
    check (coupon_type in ('discount', 'event_credits', 'both'));

comment on column public.coupons.event_credits is 'Number of free events this coupon grants per redemption (0 = monetary discount only)';
comment on column public.coupons.coupon_type is 'discount = monetary only, event_credits = free events only, both = monetary discount + free events';

-- ============================================================
-- 2. Add events_granted to coupon_redemptions
-- ============================================================

alter table public.coupon_redemptions
  add column if not exists events_granted integer not null default 0;

comment on column public.coupon_redemptions.events_granted is 'Number of event credits granted in this specific redemption';

-- ============================================================
-- 3. Create credit_ledger table for audit trail
-- ============================================================

create table if not exists public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  entry_type      text not null check (entry_type in ('credit_added', 'credit_used', 'credit_refunded', 'credit_expired')),
  amount          integer not null,          -- positive = credits added, negative = credits used
  balance_after   integer not null,          -- running balance after this entry
  source          text not null check (source in ('first_event', 'coupon', 'purchase', 'admin_grant', 'event_publish', 'refund')),
  reference_id    text,                      -- coupon code, event ID, stripe payment ID, etc.
  reference_label text,                      -- human-readable: event title, coupon description, etc.
  notes           text,
  created_at      timestamptz not null default now()
);

create index idx_credit_ledger_user on public.credit_ledger(user_id);
create index idx_credit_ledger_user_date on public.credit_ledger(user_id, created_at desc);

comment on table public.credit_ledger is 'Audit trail of all credit movements — additions, usage, refunds';

-- ============================================================
-- 4. RLS policies for credit_ledger
-- ============================================================

alter table public.credit_ledger enable row level security;

create policy "Users can view own credit ledger"
  on public.credit_ledger for select
  using (auth.uid() = user_id);

create policy "Service role manages credit ledger"
  on public.credit_ledger for all
  using (true)
  with check (true);

-- ============================================================
-- 5. Update tier CHECK constraint to include 'per_event'
-- ============================================================

-- Drop old constraint and re-add with updated values
alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles add constraint profiles_tier_check
  check (tier in ('free', 'per_event'));

-- Migrate any remaining stale tier values
update public.profiles
  set tier = 'per_event', updated_at = now()
  where tier not in ('free', 'per_event');
