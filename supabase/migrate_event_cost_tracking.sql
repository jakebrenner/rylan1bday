-- Migration: Persistent event cost tracking
-- Adds total_cost_cents to events table so cumulative cost survives page refreshes.
-- The column is atomically incremented after each AI generation or SMS send.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS total_cost_cents integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.events.total_cost_cents IS 'Cumulative cost in cents (with markup) for all AI generations and SMS for this event';

-- Backfill existing events from generation_log
-- Uses 50% markup (default) — close enough for historical data
UPDATE public.events e
SET total_cost_cents = sub.cost
FROM (
  SELECT
    g.event_id,
    ROUND(
      SUM(
        CASE
          WHEN g.model = 'claude-haiku-4-5-20251001' THEN (g.input_tokens * 0.80 + g.output_tokens * 4.00) / 1000000.0
          WHEN g.model = 'claude-opus-4-6' THEN (g.input_tokens * 15.00 + g.output_tokens * 75.00) / 1000000.0
          ELSE (g.input_tokens * 3.00 + g.output_tokens * 15.00) / 1000000.0
        END
      ) * 1.50 * 100
    )::integer AS cost
  FROM public.generation_log g
  WHERE g.status = 'success'
  GROUP BY g.event_id
) sub
WHERE e.id = sub.event_id
  AND e.total_cost_cents = 0;

-- Atomic increment RPC — used by generate-theme.js to safely add cost
CREATE OR REPLACE FUNCTION public.increment_event_cost(p_event_id uuid, p_cost_cents integer)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.events
  SET total_cost_cents = total_cost_cents + p_cost_cents
  WHERE id = p_event_id;
$$;

-- Also backfill SMS costs if sms_messages table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sms_messages' AND table_schema = 'public') THEN
    UPDATE public.events e
    SET total_cost_cents = e.total_cost_cents + COALESCE(sub.sms_cost, 0)
    FROM (
      SELECT event_id, SUM(cost_cents) AS sms_cost
      FROM public.sms_messages
      GROUP BY event_id
    ) sub
    WHERE e.id = sub.event_id AND sub.sms_cost > 0;
  END IF;
END $$;
