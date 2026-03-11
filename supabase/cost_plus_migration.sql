-- ============================================================
-- Ryvite V2 — Cost-Plus (Pay As You Go) Pricing Migration
-- Run this in your Supabase SQL Editor AFTER pricing_tiers_migration.sql
--
-- Changes:
-- 1. Adds billing_type column to plans ('fixed' or 'usage')
-- 2. Adds ai_markup_pct to plans (markup % for AI costs, e.g. 50 = 1.5x)
-- 3. Adds sms_base_cost_cents to plans (actual SMS provider cost per msg)
-- 4. Adds billed column to generation_log for AI cost threshold billing
-- 5. Inserts the "Pay As You Go" cost-plus plan
-- ============================================================

-- 1. Add billing_type to plans (fixed = upfront price, usage = pay for what you use)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'fixed'
  CHECK (billing_type IN ('fixed', 'usage'));

-- 2. Add AI markup percentage (applied to raw API cost)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS ai_markup_pct integer NOT NULL DEFAULT 50;

-- 3. Add base SMS cost (actual provider cost, separate from customer-facing sms_price_cents)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS sms_base_cost_cents integer NOT NULL DEFAULT 3;

-- 4. Add billed flag to generation_log for AI cost threshold billing
ALTER TABLE public.generation_log
  ADD COLUMN IF NOT EXISTS billed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_gen_log_unbilled
  ON public.generation_log(user_id) WHERE billed = false;

COMMENT ON COLUMN public.generation_log.billed IS 'Whether this AI cost has been charged to the user (threshold billing)';

-- 5. Insert the Pay As You Go plan
INSERT INTO public.plans (
  name, display_name, description, price_cents, billing_type,
  max_events, max_generations, max_sms_per_event,
  ai_markup_pct, sms_base_cost_cents, sms_price_cents,
  features, sort_order, is_active, is_hidden
)
SELECT
  'pay_as_you_go',
  'Pay As You Go',
  'Pay only for what you use — AI design costs + SMS at transparent rates with no upfront fee',
  0,        -- no upfront cost
  'usage',  -- usage-based billing
  1,        -- 1 event per purchase
  50,       -- generous generation limit
  NULL,     -- unlimited SMS
  50,       -- 50% markup on AI costs
  3,        -- actual SMS cost ~$0.03
  5,        -- customer pays $0.05/SMS (3 + ~67% markup)
  '["AI-designed invite", "Unlimited RSVPs", "Guest tracking", "Share via link, SMS, or email", "Up to 50 theme generations", "SMS at $0.05/message", "No upfront cost — pay only for usage"]'::jsonb,
  0,        -- sort first (default plan)
  true,
  false
WHERE NOT EXISTS (SELECT 1 FROM public.plans WHERE name = 'pay_as_you_go');

-- 6. Update existing per_event plan sort order so pay_as_you_go appears first
UPDATE public.plans SET sort_order = 10 WHERE name = 'per_event' AND sort_order < 10;

-- ============================================================
-- DONE! Cost-plus pricing migration complete.
-- ============================================================
