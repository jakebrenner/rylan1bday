-- ============================================================
-- Ryvite V2 — Add delivery_method to sms_reminders
-- Run this in your Supabase SQL Editor
--
-- Adds delivery_method column so reminders can be sent via
-- 'sms' or 'email'. Defaults to 'sms' for backwards compat.
-- ============================================================

alter table public.sms_reminders
  add column if not exists delivery_method text not null default 'sms'
  check (delivery_method in ('sms', 'email'));

comment on column public.sms_reminders.delivery_method is 'Delivery channel: sms or email. Free events can only use email.';
