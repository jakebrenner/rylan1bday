-- ============================================================
-- Funnel Analytics — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Creates views and a tracking table for understanding the
-- full user journey: visit → signup → create → generate →
-- publish → send invites → collect RSVPs
-- ============================================================

-- ============================================================
-- 1. FUNNEL_EVENTS — granular step-level tracking
-- ============================================================
-- Records individual step transitions for precise funnel analysis.
-- Complements events.settings.creation_step which only stores
-- the CURRENT step (not timestamps for each transition).

CREATE TABLE IF NOT EXISTS public.funnel_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id),
  event_id    UUID REFERENCES public.events(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,  -- 'page_view','signup','event_created','chat_started','details_extracted','generation_started','generation_complete','design_tweaked','guests_added','published','invites_sent','first_rsvp'
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- step-specific data (message count, event_type, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_user ON public.funnel_events(user_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_event ON public.funnel_events(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_funnel_events_step ON public.funnel_events(step);
CREATE INDEX IF NOT EXISTS idx_funnel_events_created ON public.funnel_events(created_at);

COMMENT ON TABLE public.funnel_events IS 'Granular step-level funnel tracking for conversion analysis. Each row = one step transition.';

-- RLS: users can insert their own funnel events
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY funnel_events_insert ON public.funnel_events
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY funnel_events_select_own ON public.funnel_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Service role can read all (for admin analytics)
-- (service role bypasses RLS by default)

-- ============================================================
-- 2. VIEWS — funnel analytics dashboards
-- ============================================================

-- View: funnel_stage_summary
-- Shows conversion counts at each major stage, derived from existing data
CREATE OR REPLACE VIEW public.funnel_stage_summary AS
WITH stage_counts AS (
  SELECT
    (SELECT COUNT(*)::INTEGER FROM public.profiles) AS total_signups,
    (SELECT COUNT(*)::INTEGER FROM public.events) AS total_events_created,
    (SELECT COUNT(*)::INTEGER FROM public.events WHERE first_generation_at IS NOT NULL) AS total_generated,
    (SELECT COUNT(*)::INTEGER FROM public.events WHERE status = 'published') AS total_published,
    (SELECT COUNT(*)::INTEGER FROM public.events WHERE status = 'published' AND settings->>'invites_sent' = 'true') AS total_invites_sent,
    (SELECT COUNT(DISTINCT event_id)::INTEGER FROM public.guests WHERE status IN ('attending','declined','maybe')) AS total_with_rsvps
)
SELECT * FROM stage_counts;

COMMENT ON VIEW public.funnel_stage_summary IS 'High-level funnel counts: signups → events → generated → published → sent → RSVPs';

-- View: creation_step_distribution
-- Where do draft (unpublished) events get stuck?
CREATE OR REPLACE VIEW public.creation_step_distribution AS
SELECT
  COALESCE(settings->>'creation_step', '0') AS creation_step,
  CASE COALESCE(settings->>'creation_step', '0')
    WHEN '0' THEN 'Template Selected'
    WHEN '1' THEN 'Chat / Details'
    WHEN '2' THEN 'Design Preview'
    WHEN '3' THEN 'Guest List'
    ELSE 'Unknown'
  END AS step_label,
  COUNT(*)::INTEGER AS event_count,
  COUNT(*) FILTER (WHERE status = 'published')::INTEGER AS published_count,
  COUNT(*) FILTER (WHERE status = 'draft')::INTEGER AS draft_count
FROM public.events
GROUP BY COALESCE(settings->>'creation_step', '0')
ORDER BY COALESCE(settings->>'creation_step', '0');

COMMENT ON VIEW public.creation_step_distribution IS 'Distribution of events by creation step — shows where users get stuck.';

-- View: chat_engagement_by_outcome
-- Compare message counts between users who published vs dropped off
CREATE OR REPLACE VIEW public.chat_engagement_by_outcome AS
WITH event_chat_counts AS (
  SELECT
    cm.session_id,
    cm.user_id,
    COUNT(*) FILTER (WHERE cm.role = 'user') AS user_messages,
    COUNT(*) AS total_messages,
    MIN(cm.created_at) AS first_message_at,
    MAX(cm.created_at) AS last_message_at,
    EXTRACT(EPOCH FROM (MAX(cm.created_at) - MIN(cm.created_at))) AS session_duration_secs
  FROM public.chat_messages cm
  WHERE cm.phase = 'create' OR cm.phase IS NULL
  GROUP BY cm.session_id, cm.user_id
)
SELECT
  CASE WHEN e.status = 'published' THEN 'published' ELSE 'dropped' END AS outcome,
  COUNT(*)::INTEGER AS session_count,
  ROUND(AVG(ecc.user_messages)::NUMERIC, 1) AS avg_user_messages,
  ROUND(AVG(ecc.total_messages)::NUMERIC, 1) AS avg_total_messages,
  ROUND(AVG(ecc.session_duration_secs / 60.0)::NUMERIC, 1) AS avg_session_minutes,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ecc.user_messages) AS median_user_messages
FROM event_chat_counts ecc
LEFT JOIN public.events e ON e.user_id = ecc.user_id
  AND e.created_at BETWEEN ecc.first_message_at - INTERVAL '1 hour' AND ecc.last_message_at + INTERVAL '1 hour'
GROUP BY CASE WHEN e.status = 'published' THEN 'published' ELSE 'dropped' END;

COMMENT ON VIEW public.chat_engagement_by_outcome IS 'Chat message counts compared between users who published vs dropped off.';

-- View: funnel_by_event_type
-- Conversion rates broken down by event type
CREATE OR REPLACE VIEW public.funnel_by_event_type AS
SELECT
  COALESCE(event_type, 'unknown') AS event_type,
  COUNT(*)::INTEGER AS events_created,
  COUNT(*) FILTER (WHERE first_generation_at IS NOT NULL)::INTEGER AS generated,
  COUNT(*) FILTER (WHERE status = 'published')::INTEGER AS published,
  ROUND(100.0 * COUNT(*) FILTER (WHERE first_generation_at IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS gen_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'published') / NULLIF(COUNT(*), 0), 1) AS publish_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'published') / NULLIF(COUNT(*) FILTER (WHERE first_generation_at IS NOT NULL), 0), 1) AS gen_to_publish_pct,
  ROUND(AVG(generations_to_publish)::NUMERIC, 1) AS avg_gtp
FROM public.events
GROUP BY COALESCE(event_type, 'unknown')
HAVING COUNT(*) >= 2
ORDER BY COUNT(*) DESC;

COMMENT ON VIEW public.funnel_by_event_type IS 'Funnel conversion rates broken down by event type.';

-- View: weekly_funnel_trends
-- Weekly cohort of signups, events, and publishes
CREATE OR REPLACE VIEW public.weekly_funnel_trends AS
WITH weeks AS (
  SELECT generate_series(
    DATE_TRUNC('week', NOW() - INTERVAL '12 weeks'),
    DATE_TRUNC('week', NOW()),
    INTERVAL '1 week'
  )::DATE AS week_start
)
SELECT
  w.week_start,
  COALESCE((SELECT COUNT(*)::INTEGER FROM public.profiles p WHERE p.created_at >= w.week_start AND p.created_at < w.week_start + INTERVAL '1 week'), 0) AS signups,
  COALESCE((SELECT COUNT(*)::INTEGER FROM public.events e WHERE e.created_at >= w.week_start AND e.created_at < w.week_start + INTERVAL '1 week'), 0) AS events_created,
  COALESCE((SELECT COUNT(*)::INTEGER FROM public.events e WHERE e.first_generation_at >= w.week_start AND e.first_generation_at < w.week_start + INTERVAL '1 week'), 0) AS first_generations,
  COALESCE((SELECT COUNT(*)::INTEGER FROM public.events e WHERE e.published_at >= w.week_start AND e.published_at < w.week_start + INTERVAL '1 week'), 0) AS published
FROM weeks w
ORDER BY w.week_start;

COMMENT ON VIEW public.weekly_funnel_trends IS 'Weekly cohort trends for signups, events, generations, and publishes.';

-- View: time_to_publish_stats
-- How long does it take from event creation to publish?
CREATE OR REPLACE VIEW public.time_to_publish_stats AS
SELECT
  COALESCE(event_type, 'all') AS event_type,
  COUNT(*)::INTEGER AS published_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (published_at - created_at)) / 60.0)::NUMERIC, 1) AS avg_minutes_to_publish,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - created_at)) / 60.0)::NUMERIC, 1) AS median_minutes_to_publish,
  ROUND(AVG(EXTRACT(EPOCH FROM (first_generation_at - created_at)) / 60.0)::NUMERIC, 1) AS avg_minutes_to_first_gen,
  ROUND(AVG(EXTRACT(EPOCH FROM (published_at - first_generation_at)) / 60.0)::NUMERIC, 1) AS avg_minutes_gen_to_publish
FROM public.events
WHERE published_at IS NOT NULL AND created_at IS NOT NULL
GROUP BY ROLLUP (event_type)
HAVING COUNT(*) >= 2;

COMMENT ON VIEW public.time_to_publish_stats IS 'Time-to-publish metrics: how long from creation to publish, broken down by event type.';
