-- Quality Monitoring & Self-Healing System
-- Tracks quality incidents (broken renders, low ratings, high GTP) with full snapshots,
-- AI diagnosis, and auto-healing resolution tracking.

-- ── Quality Incidents Table ──
CREATE TABLE IF NOT EXISTS quality_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id),
  event_theme_id UUID,  -- May reference event_themes(id) but nullable for pre-theme incidents
  user_id UUID,

  -- What triggered the incident
  trigger_type TEXT NOT NULL,  -- 'low_rating' | 'broken_render' | 'high_gtp' | 'user_complaint' | 'content_warning' | 'auto_heal_failure'
  trigger_data JSONB,          -- { rating: 1, feedback: "...", missing: ["title","rsvp"], contentWarnings: [...] }

  -- Full snapshot at time of incident
  design_chat_snapshot JSONB,  -- Full designChatHistory array from client
  theme_snapshot JSONB,        -- { html, css, config } of the broken theme
  validation_results JSONB,    -- { server: [...], client: { valid, missing } }

  -- AI diagnosis
  ai_diagnosis TEXT,           -- AI-generated analysis of what went wrong
  ai_diagnosis_model TEXT,     -- Which model diagnosed (e.g., 'claude-haiku-4-5-20251001')
  diagnosis_tokens JSONB,      -- { input, output }

  -- Resolution
  resolution_type TEXT DEFAULT 'unresolved',  -- 'auto_healed' | 'escalated' | 'admin_reviewed' | 'unresolved'
  resolution_data JSONB,       -- { new_theme_id, model_used, action_taken }
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quality_incidents_event ON quality_incidents(event_id);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_user ON quality_incidents(user_id);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_trigger ON quality_incidents(trigger_type);
CREATE INDEX IF NOT EXISTS idx_quality_incidents_unresolved ON quality_incidents(resolution_type) WHERE resolution_type = 'unresolved';
CREATE INDEX IF NOT EXISTS idx_quality_incidents_created ON quality_incidents(created_at DESC);

-- ── Extend chat_messages for design chat persistence ──
-- Adds event_id to link design chat messages to events, and phase to distinguish create vs design chat
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT 'create';  -- 'create' | 'design'
CREATE INDEX IF NOT EXISTS idx_chat_messages_event ON chat_messages(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_phase ON chat_messages(phase) WHERE phase = 'design';

-- ── Admin view: incident summary stats (last 30 days) ──
CREATE OR REPLACE VIEW quality_incident_summary AS
SELECT
  trigger_type,
  resolution_type,
  COUNT(*) as incident_count,
  COUNT(*) FILTER (WHERE resolution_type = 'auto_healed') as auto_healed_count,
  COUNT(*) FILTER (WHERE resolution_type = 'unresolved') as unresolved_count,
  COUNT(*) FILTER (WHERE resolution_type = 'escalated') as escalated_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::numeric, 1) as avg_resolution_seconds
FROM quality_incidents
WHERE created_at > now() - interval '30 days'
GROUP BY trigger_type, resolution_type
ORDER BY incident_count DESC;

-- ── Admin view: daily incident trend ──
CREATE OR REPLACE VIEW quality_incident_trend AS
SELECT
  date_trunc('day', created_at)::date as day,
  trigger_type,
  COUNT(*) as incident_count,
  COUNT(*) FILTER (WHERE resolution_type = 'auto_healed') as auto_healed,
  COUNT(*) FILTER (WHERE resolution_type = 'unresolved') as unresolved
FROM quality_incidents
WHERE created_at > now() - interval '30 days'
GROUP BY day, trigger_type
ORDER BY day DESC, incident_count DESC;
