-- Error Tracking & Self-Healing Migration
-- Creates tables for error reporting, design chat persistence, and admin dashboard views

-- ═══════════════════════════════════════════════════════════════════
-- 1. THEME ERROR REPORTS
-- Captures client-side rendering issues detected on invite pages
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS theme_error_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  event_theme_id uuid REFERENCES event_themes(id) ON DELETE CASCADE,
  error_type text NOT NULL,              -- 'css_parse', 'missing_element', 'font_load', 'layout_overflow', 'render_error', 'js_error', 'contrast', 'height_calc'
  error_details jsonb NOT NULL DEFAULT '{}',  -- specific error info (missing classes, overflow dims, etc.)
  page_context text,                     -- 'invite_page', 'create_preview', 'thank_you'
  device_info jsonb,                     -- { viewport: {w,h}, ua, platform, pixelRatio, connectionType }
  theme_html_hash text,                  -- SHA-256 hash of theme HTML for dedup
  severity text DEFAULT 'warning',       -- 'critical', 'warning', 'info'
  auto_heal_status text,                 -- null, 'pending', 'in_progress', 'healed', 'failed', 'escalated'
  auto_heal_result jsonb,                -- { model_used, fix_applied, tokens, latency_ms, new_theme_id }
  fingerprint text,                      -- browser fingerprint for dedup
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_reports_theme ON theme_error_reports(event_theme_id);
CREATE INDEX IF NOT EXISTS idx_error_reports_status ON theme_error_reports(auto_heal_status) WHERE auto_heal_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_reports_severity ON theme_error_reports(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_reports_dedup ON theme_error_reports(theme_html_hash, error_type);

-- ═══════════════════════════════════════════════════════════════════
-- 2. DESIGN CHAT LOGS
-- Full conversation persistence for debugging design chat issues
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS design_chat_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE NOT NULL,
  event_theme_id uuid REFERENCES event_themes(id) ON DELETE SET NULL,
  message_index int NOT NULL,
  role text NOT NULL,                    -- 'user', 'assistant', 'system'
  content text NOT NULL,                 -- the message text
  tier_used text,                        -- '1', '1.5', '1.75', '2', '3', null for user/system messages
  metadata jsonb DEFAULT '{}',           -- { model, inputTokens, outputTokens, latencyMs, photoUrls, rsvpFieldChanges, htmlReplacements }
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_logs_event ON design_chat_logs(event_id, message_index);
CREATE INDEX IF NOT EXISTS idx_chat_logs_theme ON design_chat_logs(event_theme_id);

-- ═══════════════════════════════════════════════════════════════════
-- 3. SELF-HEAL LOG
-- Tracks all auto-heal attempts with before/after for admin review
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS self_heal_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  original_theme_id uuid REFERENCES event_themes(id) ON DELETE SET NULL,
  new_theme_id uuid REFERENCES event_themes(id) ON DELETE SET NULL,
  trigger_type text NOT NULL,            -- 'low_rating', 'error_report', 'critical_error', 'admin_manual'
  trigger_details jsonb DEFAULT '{}',    -- { rating, feedback, errorTypes[], errorCount }
  diagnosis text,                        -- AI diagnosis of the issue
  fix_tier text,                         -- 'rule_based', 'haiku', 'sonnet'
  fix_description text,                  -- what was changed
  status text NOT NULL DEFAULT 'pending', -- 'pending', 'in_progress', 'success', 'failed', 'escalated'
  model_used text,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  cost_cents int,
  error_message text,                    -- if failed, why
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_heal_log_event ON self_heal_log(event_id);
CREATE INDEX IF NOT EXISTS idx_heal_log_status ON self_heal_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_heal_log_original ON self_heal_log(original_theme_id);

-- ═══════════════════════════════════════════════════════════════════
-- 4. ADD auto_healed FLAG TO event_themes
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE event_themes ADD COLUMN IF NOT EXISTS auto_healed boolean DEFAULT false;
ALTER TABLE event_themes ADD COLUMN IF NOT EXISTS healed_from_id uuid REFERENCES event_themes(id);

-- ═══════════════════════════════════════════════════════════════════
-- 5. ERROR DASHBOARD SUMMARY VIEW
-- Aggregated error stats for the admin Health tab
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW error_dashboard_summary AS
SELECT
  date_trunc('day', ter.created_at) AS day,
  ter.error_type,
  ter.severity,
  count(*) AS error_count,
  count(DISTINCT ter.event_theme_id) AS affected_themes,
  count(DISTINCT ter.event_id) AS affected_events,
  count(*) FILTER (WHERE ter.auto_heal_status = 'healed') AS auto_healed,
  count(*) FILTER (WHERE ter.auto_heal_status = 'failed') AS heal_failed,
  count(*) FILTER (WHERE ter.auto_heal_status = 'escalated') AS escalated
FROM theme_error_reports ter
GROUP BY 1, 2, 3;

-- ═══════════════════════════════════════════════════════════════════
-- 6. SELF-HEAL EFFECTIVENESS VIEW
-- How well is the self-healing system performing?
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW self_heal_effectiveness AS
SELECT
  date_trunc('week', created_at) AS week,
  trigger_type,
  fix_tier,
  count(*) AS total_attempts,
  count(*) FILTER (WHERE status = 'success') AS successes,
  count(*) FILTER (WHERE status = 'failed') AS failures,
  count(*) FILTER (WHERE status = 'escalated') AS escalations,
  ROUND(100.0 * count(*) FILTER (WHERE status = 'success') / NULLIF(count(*), 0), 1) AS success_rate,
  AVG(latency_ms) FILTER (WHERE status = 'success') AS avg_fix_latency_ms,
  SUM(cost_cents) AS total_cost_cents
FROM self_heal_log
GROUP BY 1, 2, 3;

-- ═══════════════════════════════════════════════════════════════════
-- 7. ESCALATED ISSUES VIEW (for admin Health tab)
-- Issues that need manual attention
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW escalated_issues AS
SELECT
  shl.id AS heal_log_id,
  shl.event_id,
  e.title AS event_title,
  e.slug AS event_slug,
  shl.original_theme_id,
  shl.trigger_type,
  shl.trigger_details,
  shl.diagnosis,
  shl.status,
  shl.error_message,
  shl.created_at,
  -- Aggregate error types for this theme
  (SELECT jsonb_agg(DISTINCT ter.error_type)
   FROM theme_error_reports ter
   WHERE ter.event_theme_id = shl.original_theme_id) AS error_types,
  -- Count of error reports
  (SELECT count(*)
   FROM theme_error_reports ter
   WHERE ter.event_theme_id = shl.original_theme_id) AS error_report_count,
  -- Latest user rating
  (SELECT jsonb_build_object('rating', ir.rating, 'feedback', ir.feedback)
   FROM invite_ratings ir
   WHERE ir.event_theme_id = shl.original_theme_id
   ORDER BY ir.created_at DESC LIMIT 1) AS latest_rating
FROM self_heal_log shl
JOIN events e ON e.id = shl.event_id
WHERE shl.status IN ('failed', 'escalated')
ORDER BY shl.created_at DESC;
