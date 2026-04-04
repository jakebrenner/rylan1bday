-- Prompt Health & Auto-Scoring Migration
-- Adds AI-powered prompt optimization infrastructure:
-- 1. prompt_health_analyses — stores AI analysis results
-- 2. prompt_health_recommendations — individual actionable suggestions
-- 3. auto_score columns on event_themes — Haiku auto-rates every generation
-- 4. Analytics views for calibration and summary

-- ═══════════════════════════════════════════════════════════════════
-- 1. PROMPT HEALTH ANALYSES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prompt_health_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_version_id UUID REFERENCES public.prompt_versions(id) ON DELETE SET NULL,
  analysis_model    TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  health_score      INTEGER CHECK (health_score >= 1 AND health_score <= 10),
  summary           TEXT,
  full_result       JSONB NOT NULL DEFAULT '{}',
  data_snapshot     JSONB NOT NULL DEFAULT '{}',
  input_tokens      INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0,
  cost_cents        NUMERIC(10,4) DEFAULT 0,
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prompt_health_created
  ON public.prompt_health_analyses(created_at DESC);

ALTER TABLE public.prompt_health_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on prompt_health_analyses"
  ON public.prompt_health_analyses FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════════
-- 2. PROMPT HEALTH RECOMMENDATIONS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.prompt_health_recommendations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         UUID NOT NULL REFERENCES public.prompt_health_analyses(id) ON DELETE CASCADE,
  type                TEXT NOT NULL DEFAULT 'modify',
  section             TEXT NOT NULL DEFAULT 'creative_direction',
  event_type          TEXT,
  severity            TEXT DEFAULT 'minor',
  title               TEXT NOT NULL,
  current_text        TEXT,
  suggested_text      TEXT,
  rationale           TEXT,
  expected_impact     TEXT,
  status              TEXT DEFAULT 'pending',
  applied_version_id  UUID REFERENCES public.prompt_versions(id) ON DELETE SET NULL,
  reviewed_by         TEXT,
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recommendations_analysis
  ON public.prompt_health_recommendations(analysis_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_pending
  ON public.prompt_health_recommendations(status) WHERE status = 'pending';

ALTER TABLE public.prompt_health_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on prompt_health_recommendations"
  ON public.prompt_health_recommendations FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════════
-- 3. AUTO-SCORE COLUMNS ON EVENT_THEMES
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.event_themes
  ADD COLUMN IF NOT EXISTS auto_score INTEGER CHECK (auto_score >= 1 AND auto_score <= 5),
  ADD COLUMN IF NOT EXISTS auto_score_reasoning TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS auto_scored_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_event_themes_auto_score
  ON public.event_themes(auto_score) WHERE auto_score IS NOT NULL;

COMMENT ON COLUMN public.event_themes.auto_score IS 'AI-generated quality score 1-5, assigned by Haiku immediately after generation.';
COMMENT ON COLUMN public.event_themes.auto_score_reasoning IS 'One-sentence explanation of the auto-score.';

-- ═══════════════════════════════════════════════════════════════════
-- 4. AUTO-SCORE CALIBRATION VIEW
-- Compares auto_score vs admin_rating where both exist
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.auto_score_calibration AS
SELECT
  auto_score,
  admin_rating,
  COUNT(*)::integer AS sample_count,
  ROUND(AVG(admin_rating - auto_score)::numeric, 2) AS avg_bias,
  ROUND(STDDEV(admin_rating - auto_score)::numeric, 2) AS stddev_bias
FROM public.event_themes
WHERE auto_score IS NOT NULL AND admin_rating IS NOT NULL
GROUP BY auto_score, admin_rating
ORDER BY auto_score, admin_rating;

-- ═══════════════════════════════════════════════════════════════════
-- 5. AUTO-SCORE SUMMARY VIEW
-- Like admin_theme_quality but for auto-scores
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.auto_score_summary AS
SELECT
  et.prompt_version_id,
  COALESCE(pv.name, 'Hardcoded Default') AS prompt_name,
  COALESCE(pv.version, 0) AS prompt_version,
  et.model,
  COUNT(*)::integer AS total_themes,
  COUNT(et.auto_score)::integer AS scored_count,
  ROUND(AVG(et.auto_score)::numeric, 2) AS avg_auto_score,
  COUNT(*) FILTER (WHERE et.auto_score >= 4)::integer AS high_quality_count,
  COUNT(*) FILTER (WHERE et.auto_score <= 2)::integer AS low_quality_count,
  COUNT(*) FILTER (WHERE et.auto_score <= 2 AND et.admin_rating IS NULL)::integer AS flagged_for_review,
  ROUND(AVG(et.latency_ms)::numeric, 0) AS avg_latency_ms
FROM public.event_themes et
LEFT JOIN public.prompt_versions pv ON pv.id = et.prompt_version_id
WHERE et.auto_score IS NOT NULL
GROUP BY et.prompt_version_id, pv.name, pv.version, et.model;
