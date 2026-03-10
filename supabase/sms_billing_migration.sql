-- ============================================================
-- Ryvite V2 — SMS Threshold Billing
-- Run this in your Supabase SQL Editor AFTER sms_tracking_migration.sql
--
-- Adds: 'billed' column to sms_messages for threshold-based billing
-- SMS costs accumulate and are auto-charged when they reach $5.00
-- ============================================================

-- Add billed flag to track which messages have been charged
alter table public.sms_messages
  add column if not exists billed boolean not null default false;

create index if not exists idx_sms_messages_unbilled
  on public.sms_messages(user_id) where billed = false;

comment on column public.sms_messages.billed is 'Whether this SMS cost has been charged to the user (threshold billing at $5)';

-- Update SMS price from $0.05 to $0.10 per message
update public.plans
set sms_price_cents = 10,
    features = '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link, SMS, or email", "Up to 20 theme generations"]'::jsonb
where name = 'single_event';

-- ============================================================
-- DONE! Run this in your Supabase SQL editor.
-- ============================================================
