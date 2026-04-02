-- ============================================================
-- Fix test_run_analytics view — cost formula correction
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- The previous avg_est_cost formula used per-token rates instead of
-- per-million-token rates, inflating cost estimates by ~1000x.
-- This migration replaces the view with correct model-aware pricing.
-- ============================================================

CREATE OR REPLACE VIEW public.test_run_analytics AS
SELECT
  ptr.prompt_version_id,
  pv.name AS prompt_name,
  pv.version AS prompt_version,
  ptr.model,
  ptr.event_type,
  count(*)::integer AS total_runs,
  count(ptr.score)::integer AS rated_runs,
  round(avg(ptr.score)::numeric, 2) AS avg_score,
  count(*) FILTER (WHERE ptr.score >= 4)::integer AS high_quality,
  count(*) FILTER (WHERE ptr.score <= 2)::integer AS low_quality,
  round(avg(ptr.latency_ms)::numeric, 0) AS avg_latency_ms,
  round(avg(ptr.input_tokens + ptr.output_tokens)::numeric, 0) AS avg_total_tokens,
  -- Cost in dollars (per-million-token pricing, model-aware)
  round(avg(
    CASE
      WHEN ptr.model = 'claude-haiku-4-5-20251001'          THEN (ptr.input_tokens * 1.00  + ptr.output_tokens * 5.00)  / 1000000.0
      WHEN ptr.model IN ('claude-opus-4-20250514', 'claude-opus-4-6')
                                                             THEN (ptr.input_tokens * 15.00 + ptr.output_tokens * 75.00) / 1000000.0
      WHEN ptr.model = 'gpt-4.1'                            THEN (ptr.input_tokens * 2.00  + ptr.output_tokens * 8.00)  / 1000000.0
      WHEN ptr.model = 'gpt-4.1-mini'                       THEN (ptr.input_tokens * 0.40  + ptr.output_tokens * 1.60)  / 1000000.0
      WHEN ptr.model = 'gpt-4.1-nano'                       THEN (ptr.input_tokens * 0.10  + ptr.output_tokens * 0.40)  / 1000000.0
      WHEN ptr.model = 'o3'                                  THEN (ptr.input_tokens * 2.00  + ptr.output_tokens * 8.00)  / 1000000.0
      WHEN ptr.model = 'o4-mini'                             THEN (ptr.input_tokens * 1.10  + ptr.output_tokens * 4.40)  / 1000000.0
      ELSE (ptr.input_tokens * 3.00 + ptr.output_tokens * 15.00) / 1000000.0  -- Sonnet default
    END
  )::numeric, 6) AS avg_est_cost,
  min(ptr.created_at) AS first_run,
  max(ptr.created_at) AS last_run
FROM public.prompt_test_runs ptr
LEFT JOIN public.prompt_versions pv ON pv.id = ptr.prompt_version_id
GROUP BY ptr.prompt_version_id, pv.name, pv.version, ptr.model, ptr.event_type;

COMMENT ON VIEW public.test_run_analytics IS 'Comprehensive test run performance analytics grouped by prompt version, model, and event type. avg_est_cost is in dollars using per-million-token model pricing.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor.
-- This replaces the old view with correct cost calculations.
-- ============================================================
