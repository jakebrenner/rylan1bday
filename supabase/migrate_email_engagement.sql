-- Email Engagement Tracking
-- Adds email_type categorization and open/click/bounce tracking to notification_log
-- Enables unified customer touchpoint analytics with funnel metrics

-- ============================================================
-- 1. Add email_type to categorize all outbound communications
-- ============================================================
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS email_type text;

COMMENT ON COLUMN notification_log.email_type IS 'Category: review_request, review_reminder, abandonment_nudge, invite_email, event_reminder, rsvp_digest, cohost_invite, sms_test, limit_notification';

-- ============================================================
-- 2. Add engagement tracking columns
-- ============================================================
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS open_count integer DEFAULT 0;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS click_count integer DEFAULT 0;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS bounce_type text; -- hard, soft, complaint

-- ============================================================
-- 3. Add user_id for linking to profiles (not all have event_id)
-- ============================================================
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- ============================================================
-- 4. Indexes for analytics queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_notif_log_email_type ON notification_log (email_type);
CREATE INDEX IF NOT EXISTS idx_notif_log_user_id ON notification_log (user_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_provider_id ON notification_log (provider_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_sent_at ON notification_log (sent_at DESC);

-- ============================================================
-- 5. Backfill email_type for existing records
-- ============================================================
-- Review-related: match by subject patterns
UPDATE notification_log SET email_type = 'abandonment_nudge'
WHERE email_type IS NULL AND channel = 'email' AND subject ILIKE '%still in draft%';

UPDATE notification_log SET email_type = 'invite_email'
WHERE email_type IS NULL AND channel = 'email' AND subject ILIKE '%invited%';

UPDATE notification_log SET email_type = 'event_reminder'
WHERE email_type IS NULL AND channel = 'email' AND subject ILIKE '%reminder%';

-- SMS defaults
UPDATE notification_log SET email_type = 'sms_invite'
WHERE email_type IS NULL AND channel = 'sms';

-- ============================================================
-- 6. View: touchpoint_funnel — per-type engagement funnel
-- ============================================================
CREATE OR REPLACE VIEW touchpoint_funnel AS
SELECT
  email_type,
  channel,
  count(*) AS total_sent,
  count(delivered_at) AS delivered,
  count(opened_at) AS opened,
  count(clicked_at) AS clicked,
  count(bounced_at) AS bounced,
  CASE WHEN count(*) > 0
    THEN round(count(delivered_at)::numeric / count(*)::numeric * 100, 1)
    ELSE 0 END AS delivery_rate,
  CASE WHEN count(delivered_at) > 0
    THEN round(count(opened_at)::numeric / count(delivered_at)::numeric * 100, 1)
    ELSE 0 END AS open_rate,
  CASE WHEN count(opened_at) > 0
    THEN round(count(clicked_at)::numeric / count(opened_at)::numeric * 100, 1)
    ELSE 0 END AS click_rate,
  CASE WHEN count(*) > 0
    THEN round(count(bounced_at)::numeric / count(*)::numeric * 100, 1)
    ELSE 0 END AS bounce_rate
FROM notification_log
WHERE email_type IS NOT NULL
GROUP BY email_type, channel
ORDER BY total_sent DESC;

-- ============================================================
-- 7. View: touchpoint_daily — daily send/open/click trends
-- ============================================================
CREATE OR REPLACE VIEW touchpoint_daily AS
SELECT
  date_trunc('day', sent_at)::date AS day,
  email_type,
  count(*) AS sent,
  count(delivered_at) AS delivered,
  count(opened_at) AS opened,
  count(clicked_at) AS clicked,
  count(bounced_at) AS bounced
FROM notification_log
WHERE email_type IS NOT NULL AND sent_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ============================================================
-- 8. View: review_request_funnel — end-to-end review pipeline
-- ============================================================
CREATE OR REPLACE VIEW review_request_funnel AS
SELECT
  count(*) AS total_requests,
  count(CASE WHEN status IN ('sent', 'reminded', 'completed') THEN 1 END) AS emails_sent,
  count(CASE WHEN status = 'reminded' THEN 1 END) AS reminders_sent,
  count(CASE WHEN status = 'completed' THEN 1 END) AS reviews_submitted,
  CASE WHEN count(CASE WHEN status IN ('sent', 'reminded', 'completed') THEN 1 END) > 0
    THEN round(
      count(CASE WHEN status = 'completed' THEN 1 END)::numeric /
      count(CASE WHEN status IN ('sent', 'reminded', 'completed') THEN 1 END)::numeric * 100, 1)
    ELSE 0 END AS conversion_rate
FROM review_requests;
