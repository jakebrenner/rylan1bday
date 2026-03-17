-- Quality Assurance Enhancement Migration
-- Adds browser/device tracking, pattern analysis, and suggested rules system.
-- Run AFTER migrate_quality_monitor.sql

-- ── Add client_meta to quality_incidents for browser/device tracking ──
ALTER TABLE quality_incidents ADD COLUMN IF NOT EXISTS client_meta JSONB;
-- Schema: { user_agent, client_ip, client_geo, screen_width, screen_height, viewport_width, viewport_height, device_pixel_ratio, platform, touch, connection }

CREATE INDEX IF NOT EXISTS idx_quality_incidents_client_meta ON quality_incidents USING GIN (client_meta);

-- ── Suggested Rules Table ──
-- AI-generated prompt rules derived from recurring incident patterns.
-- Admin reviews and either applies, dismisses, or flags for code change.
CREATE TABLE IF NOT EXISTS suggested_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_cause TEXT NOT NULL,
  trigger_pattern TEXT,                -- e.g., 'css_invisible x5 in 24h'
  suggested_text TEXT NOT NULL,        -- AI-generated rule to add to prompt
  source_incidents UUID[],             -- Array of incident IDs that triggered this
  incident_count INT DEFAULT 0,        -- How many incidents triggered this suggestion
  affected_events INT DEFAULT 0,       -- How many unique events affected
  affected_browsers TEXT[],            -- Unique browsers affected
  status TEXT DEFAULT 'pending',       -- 'pending' | 'applied' | 'dismissed' | 'needs_deploy'
  applied_to_prompt_version UUID,      -- If applied, which prompt_versions.id it was added to
  dismiss_reason TEXT,                 -- Why admin dismissed (optional)
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suggested_rules_status ON suggested_rules(status) WHERE status = 'pending';

-- ── View: Quality Incidents by Browser/Device ──
-- Groups incidents by browser family + device class for pinpointing browser-specific bugs
CREATE OR REPLACE VIEW quality_incidents_by_browser AS
SELECT
  CASE
    WHEN client_meta->>'user_agent' ILIKE '%Safari%' AND client_meta->>'user_agent' NOT ILIKE '%Chrome%' THEN 'Safari'
    WHEN client_meta->>'user_agent' ILIKE '%Chrome%' AND client_meta->>'user_agent' NOT ILIKE '%Edg%' THEN 'Chrome'
    WHEN client_meta->>'user_agent' ILIKE '%Edg%' THEN 'Edge'
    WHEN client_meta->>'user_agent' ILIKE '%Firefox%' THEN 'Firefox'
    WHEN client_meta->>'user_agent' ILIKE '%SamsungBrowser%' THEN 'Samsung'
    ELSE 'Other'
  END as browser,
  CASE
    WHEN (client_meta->>'screen_width')::int <= 430 THEN 'Mobile'
    WHEN (client_meta->>'screen_width')::int <= 1024 THEN 'Tablet'
    ELSE 'Desktop'
  END as device_class,
  trigger_type,
  COUNT(*) as incident_count,
  COUNT(*) FILTER (WHERE resolution_type = 'auto_healed') as healed_count,
  COUNT(*) FILTER (WHERE resolution_type = 'unresolved') as unresolved_count
FROM quality_incidents
WHERE client_meta IS NOT NULL
  AND client_meta->>'screen_width' IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2, 3
ORDER BY incident_count DESC;

-- ── View: Root Cause Patterns ──
-- Aggregates diagnosed incidents by root cause to detect recurring issues
-- that should be permanently fixed via prompt/code changes
CREATE OR REPLACE VIEW quality_root_cause_patterns AS
SELECT
  COALESCE(ai_diagnosis::jsonb->>'rootCause', 'unknown') as root_cause,
  trigger_type,
  COUNT(*) as total_incidents,
  COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') as last_7_days,
  COUNT(*) FILTER (WHERE created_at > now() - interval '1 day') as last_24_hours,
  mode() WITHIN GROUP (ORDER BY COALESCE(ai_diagnosis::jsonb->>'healStrategy', 'unknown')) as most_common_heal,
  COUNT(DISTINCT event_id) as affected_events,
  COUNT(DISTINCT COALESCE(client_meta->>'user_agent', 'unknown')) as affected_browser_agents
FROM quality_incidents
WHERE ai_diagnosis IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2
HAVING COUNT(*) >= 3
ORDER BY last_7_days DESC, total_incidents DESC;

-- ── View: Validation Rule Effectiveness ──
-- Shows which server-side validation checks catch issues most often
CREATE OR REPLACE VIEW validation_rule_effectiveness AS
SELECT
  issue as validation_issue,
  COUNT(*) as times_caught,
  COUNT(*) FILTER (WHERE resolution_type = 'auto_healed') as auto_fixed,
  COUNT(*) FILTER (WHERE resolution_type = 'escalated') as escalated,
  COUNT(*) FILTER (WHERE resolution_type = 'unresolved') as still_unresolved
FROM quality_incidents,
  LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(validation_results->'server') = 'array' THEN validation_results->'server'
      ELSE '[]'::jsonb
    END
  ) AS issue
WHERE validation_results->'server' IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY times_caught DESC;
