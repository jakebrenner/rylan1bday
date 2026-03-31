-- Support Ticket Enhancements
-- Adds lifecycle tracking columns for AI resolution, human escalation, and audit

-- ============================================================
-- New columns on support_tickets for lifecycle tracking
-- ============================================================
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_type text
  CHECK (resolution_type IS NULL OR resolution_type IN ('ai_resolved', 'human_resolved', 'credit_issued', 'user_abandoned'));

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_attempts integer DEFAULT 0;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES auth.users(id);

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS theme_snapshot jsonb;

-- ============================================================
-- Index for resolution analytics
-- ============================================================
CREATE INDEX IF NOT EXISTS support_tickets_resolution_idx ON support_tickets (resolution_type) WHERE resolution_type IS NOT NULL;

-- ============================================================
-- View: support_resolution_analytics
-- Tracks how tickets are resolved: AI vs human vs credit
-- ============================================================
CREATE OR REPLACE VIEW support_resolution_analytics AS
SELECT
  resolution_type,
  count(*) as ticket_count,
  avg(ai_attempts) as avg_ai_attempts,
  count(*) FILTER (WHERE resolution_type = 'ai_resolved') as ai_resolved_count,
  count(*) FILTER (WHERE resolution_type = 'human_resolved') as human_resolved_count,
  count(*) FILTER (WHERE resolution_type = 'credit_issued') as credit_issued_count,
  count(*) FILTER (WHERE resolution_type IS NULL AND status = 'open') as pending_count
FROM support_tickets
GROUP BY resolution_type;
