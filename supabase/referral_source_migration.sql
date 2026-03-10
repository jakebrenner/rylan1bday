-- ============================================================
-- Ryvite V2 — Marketing Attribution
-- Run this in your Supabase SQL Editor
--
-- Adds: referral_source column to profiles for tracking
--       how users discovered Ryvite
-- ============================================================

alter table public.profiles
  add column if not exists referral_source text;

comment on column public.profiles.referral_source is 'How the user heard about Ryvite (Instagram, TikTok, Google, Friend, etc.)';

-- ============================================================
-- DONE! Run this in your Supabase SQL editor.
-- ============================================================
