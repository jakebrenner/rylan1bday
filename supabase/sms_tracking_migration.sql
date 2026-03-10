-- ============================================================
-- Ryvite V2 — SMS Usage Tracking
-- Run this in your Supabase SQL Editor AFTER billing_migration.sql
--
-- Adds: sms_messages table for per-message tracking
-- Updates: plans table to include sms_price_cents
-- ============================================================

-- ============================================================
-- 1. SMS_MESSAGES — tracks every outbound SMS
-- ============================================================

create table if not exists public.sms_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  event_id        uuid references public.events(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  recipient_phone text not null,
  recipient_name  text,
  message_type    text not null default 'invite' check (message_type in ('invite', 'reminder', 'update', 'custom')),
  status          text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'failed', 'bounced')),
  provider_id     text,                          -- ClickSend message ID
  cost_cents      integer not null default 5,    -- $0.05 per message
  created_at      timestamptz not null default now()
);

create index idx_sms_messages_user on public.sms_messages(user_id);
create index idx_sms_messages_event on public.sms_messages(event_id);
create index idx_sms_messages_subscription on public.sms_messages(subscription_id);
create index idx_sms_messages_created on public.sms_messages(created_at);

comment on table public.sms_messages is 'Tracks every outbound SMS for billing at $0.05/message';

-- ============================================================
-- 2. Add sms_price_cents to plans table
-- ============================================================

alter table public.plans
  add column if not exists sms_price_cents integer not null default 5;

comment on column public.plans.sms_price_cents is 'Cost per SMS in cents (default 5 = $0.05)';

-- ============================================================
-- 3. Update the single_event plan features to mention SMS pricing
-- ============================================================

update public.plans
set features = '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link or email", "SMS invites & reminders ($0.05/text)", "Up to 20 theme generations"]'::jsonb,
    sms_price_cents = 5
where name = 'single_event';

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.sms_messages enable row level security;

-- Users can view their own SMS messages
create policy "Users can view own sms messages"
  on public.sms_messages for select
  using (auth.uid() = user_id);

-- Service role manages SMS messages (API creates them)
create policy "Service can manage sms messages"
  on public.sms_messages for all
  using (true);

-- ============================================================
-- DONE! SMS tracking schema is ready.
-- ============================================================
