-- Migration: Real profitability tracking
-- Adds cost_cents to generation_log to preserve historical costs at time of generation.
-- Updates total_cost_cents comment to reflect raw API cost (no markup).

-- 1. Add cost_cents column to generation_log for per-generation cost preservation
ALTER TABLE public.generation_log
  ADD COLUMN IF NOT EXISTS cost_cents numeric(10,4) DEFAULT NULL;

COMMENT ON COLUMN public.generation_log.cost_cents IS 'Raw API cost in cents at time of generation. Preserves historical pricing even if model costs change.';

-- 2. Backfill cost_cents from existing token data using current API pricing
UPDATE public.generation_log
SET cost_cents = ROUND(
  CASE
    WHEN model = 'claude-haiku-4-5-20251001' THEN (COALESCE(input_tokens, 0) * 1.00 + COALESCE(output_tokens, 0) * 5.00) / 1000000.0
    WHEN model IN ('claude-opus-4-20250514', 'claude-opus-4-6') THEN (COALESCE(input_tokens, 0) * 15.00 + COALESCE(output_tokens, 0) * 75.00) / 1000000.0
    ELSE (COALESCE(input_tokens, 0) * 3.00 + COALESCE(output_tokens, 0) * 15.00) / 1000000.0
  END * 100, 4
)
WHERE cost_cents IS NULL AND status = 'success';

-- 3. Update total_cost_cents comment — it now tracks raw API cost, not marked-up cost
COMMENT ON COLUMN public.events.total_cost_cents IS 'Cumulative raw API cost in cents for all AI generations and SMS for this event (no markup)';

-- 4. Recalculate total_cost_cents as raw cost (remove old markup)
-- Old values had 1.5x markup baked in, so divide by 1.5 to get raw cost
-- Only update events that were backfilled with markup (before this migration)
UPDATE public.events
SET total_cost_cents = ROUND(total_cost_cents / 1.5)
WHERE total_cost_cents > 0;
