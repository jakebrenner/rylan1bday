-- ============================================================
-- Ryvite V2 — Pricing Tiers Migration
-- Run this in your Supabase SQL Editor AFTER billing_migration.sql
--
-- Changes:
-- 1. Drops the CHECK constraint on profiles.tier so it can hold any plan slug
-- 2. Adds stripe_product_id to plans (for Stripe product linking)
-- 3. Adds max_sms_per_event to plans
-- 4. Updates the seeded plan to match current "Per Event" pricing
-- ============================================================

-- 1. Drop the old CHECK constraint on profiles.tier
-- The constraint name may vary; this finds and drops it dynamically
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%tier%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.profiles DROP CONSTRAINT ' || constraint_name;
  END IF;
END $$;

-- 2. Add stripe_product_id to plans (Stripe Product object ID)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS stripe_product_id text;

-- 3. Add max_sms_per_event to plans (SMS limit per event, null = unlimited)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS max_sms_per_event integer;

-- 4. Update the seeded plan to match actual "Per Event" pricing
UPDATE public.plans
SET
  name = 'per_event',
  display_name = 'Per Event',
  description = 'Pay per event — everything you need for one beautiful event',
  price_cents = 699,
  max_events = 1,
  max_generations = 20,
  max_sms_per_event = NULL,
  features = '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link, SMS, or email", "Up to 20 theme generations", "SMS at usage rates"]'::jsonb,
  sort_order = 1,
  is_active = true
WHERE name = 'single_event';

-- If the plan didn't exist, insert it
INSERT INTO public.plans (name, display_name, description, price_cents, max_events, max_generations, max_sms_per_event, features, sort_order, is_active)
SELECT 'per_event', 'Per Event', 'Pay per event — everything you need for one beautiful event',
  699, 1, 20, NULL,
  '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link, SMS, or email", "Up to 20 theme generations", "SMS at usage rates"]'::jsonb,
  1, true
WHERE NOT EXISTS (SELECT 1 FROM public.plans WHERE name = 'per_event');

-- 5. Update existing profiles to use 'per_event' instead of 'pro'/'business'
-- (map old tier names to new plan names — adjust as needed)
UPDATE public.profiles SET tier = 'per_event' WHERE tier IN ('pro', 'business');

-- 6. Allow admin RLS policies for plan management (service role already has full access)
-- The existing "Anyone can view active plans" policy is sufficient for reads.
-- Service role bypasses RLS, so admin CRUD works out of the box.

-- 7. Add is_hidden column to plans (hidden plans only accessible via custom link)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

-- ============================================================
-- DONE! Pricing tiers migration complete.
-- ============================================================
