-- ============================================================
-- Ad Tracking & Marketing Dashboard Migration
-- ============================================================
-- Creates tables for:
--   1. ad_creatives      – generated ad videos + UTM links
--   2. utm_visits        – inbound UTM-tagged visits + conversions
--   3. fb_ad_metrics     – synced Facebook Marketing API data
--   4. ad_suggestions    – AI-generated ad recommendations
-- Plus views for combined performance analytics.
-- ============================================================

-- 1. Ad Creatives ─ each row = one generated ad video + its UTM link
CREATE TABLE IF NOT EXISTS ad_creatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id TEXT UNIQUE NOT NULL,              -- short ID e.g. 'fb-abc123'
  campaign_name TEXT NOT NULL,
  source_type TEXT NOT NULL,                     -- 'showcase', 'user_theme', 'lab_theme'
  source_id UUID NOT NULL,                       -- FK to featured_showcases / event_themes / prompt_test_runs
  event_type TEXT,                               -- wedding, birthday, etc.
  format TEXT NOT NULL,                          -- 'reels_9x16' or 'feed_1x1'
  video_theme TEXT NOT NULL DEFAULT 'dark_gradient', -- visual theme used
  prompt_text TEXT,                              -- prompt shown in the video
  utm_url TEXT NOT NULL,                         -- full URL with UTM params
  invite_html TEXT,                              -- snapshot of invite HTML
  invite_css TEXT,                               -- snapshot of invite CSS
  invite_config JSONB,                           -- snapshot of invite config
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_creatives_campaign ON ad_creatives(campaign_name);
CREATE INDEX IF NOT EXISTS idx_ad_creatives_source ON ad_creatives(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ad_creatives_event_type ON ad_creatives(event_type);

-- 2. UTM Visits ─ every inbound visit with UTM params
CREATE TABLE IF NOT EXISTS utm_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,                              -- links to ad_creatives.creative_id
  utm_term TEXT,
  landing_page TEXT,                             -- URL path they landed on
  user_id UUID REFERENCES auth.users(id),        -- set when/if they sign up
  event_id UUID REFERENCES events(id),           -- set when/if they create an event
  session_id TEXT,                               -- browser session identifier
  ip_address TEXT,
  user_agent TEXT,
  converted_signup BOOLEAN DEFAULT FALSE,
  converted_event BOOLEAN DEFAULT FALSE,
  converted_publish BOOLEAN DEFAULT FALSE,
  converted_signup_at TIMESTAMPTZ,
  converted_event_at TIMESTAMPTZ,
  converted_publish_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_utm_visits_content ON utm_visits(utm_content);
CREATE INDEX IF NOT EXISTS idx_utm_visits_campaign ON utm_visits(utm_campaign);
CREATE INDEX IF NOT EXISTS idx_utm_visits_session ON utm_visits(session_id);
CREATE INDEX IF NOT EXISTS idx_utm_visits_user ON utm_visits(user_id);

-- 3. Facebook Ad Metrics ─ synced from FB Marketing API
CREATE TABLE IF NOT EXISTS fb_ad_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id TEXT,                              -- matches ad_creatives.creative_id
  fb_campaign_id TEXT,
  fb_campaign_name TEXT,
  fb_adset_id TEXT,
  fb_ad_id TEXT,
  fb_ad_name TEXT,
  date DATE NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,                 -- stored in cents for precision
  cpc_cents INTEGER DEFAULT 0,
  ctr DECIMAL(7,4) DEFAULT 0,
  reach INTEGER DEFAULT 0,
  frequency DECIMAL(5,2) DEFAULT 0,
  actions JSONB,                                 -- raw FB actions array
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fb_ad_id, date)
);

CREATE INDEX IF NOT EXISTS idx_fb_metrics_creative ON fb_ad_metrics(creative_id);
CREATE INDEX IF NOT EXISTS idx_fb_metrics_date ON fb_ad_metrics(date);
CREATE INDEX IF NOT EXISTS idx_fb_metrics_campaign ON fb_ad_metrics(fb_campaign_id);

-- 4. AI-generated ad suggestions
CREATE TABLE IF NOT EXISTS ad_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_type TEXT NOT NULL,                  -- 'copy', 'creative', 'targeting', 'general'
  title TEXT NOT NULL,
  description TEXT,
  data JSONB,                                    -- structured suggestion data
  based_on JSONB,                                -- what data informed this suggestion
  confidence DECIMAL(3,2),                       -- 0.00 - 1.00
  status TEXT DEFAULT 'pending',                 -- 'pending', 'applied', 'dismissed'
  applied_creative_id TEXT,                      -- if suggestion was turned into an ad
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Add UTM columns to profiles for first-touch attribution
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'utm_source') THEN
    ALTER TABLE profiles ADD COLUMN utm_source TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'utm_campaign') THEN
    ALTER TABLE profiles ADD COLUMN utm_campaign TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'utm_content') THEN
    ALTER TABLE profiles ADD COLUMN utm_content TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'utm_medium') THEN
    ALTER TABLE profiles ADD COLUMN utm_medium TEXT;
  END IF;
END $$;

-- ============================================================
-- VIEWS
-- ============================================================

-- Combined per-creative performance (our conversions + FB spend)
CREATE OR REPLACE VIEW ad_creative_performance AS
SELECT
  ac.id,
  ac.creative_id,
  ac.campaign_name,
  ac.event_type,
  ac.format,
  ac.video_theme,
  ac.prompt_text,
  ac.created_at,
  ac.created_by,
  -- Facebook metrics (aggregated across all dates)
  COALESCE(fb.total_impressions, 0) AS impressions,
  COALESCE(fb.total_clicks, 0) AS fb_clicks,
  COALESCE(fb.total_spend_cents, 0) AS spend_cents,
  COALESCE(fb.total_reach, 0) AS reach,
  CASE WHEN COALESCE(fb.total_impressions, 0) > 0
    THEN ROUND(COALESCE(fb.total_clicks, 0)::decimal / fb.total_impressions * 100, 2)
    ELSE 0 END AS ctr,
  -- Our conversion metrics (from UTM visits)
  COALESCE(uv.visit_count, 0) AS utm_visits,
  COALESCE(uv.signup_count, 0) AS signups,
  COALESCE(uv.event_count, 0) AS events_created,
  COALESCE(uv.publish_count, 0) AS events_published,
  -- Calculated rates
  CASE WHEN COALESCE(uv.visit_count, 0) > 0
    THEN ROUND(COALESCE(uv.signup_count, 0)::decimal / uv.visit_count * 100, 2)
    ELSE 0 END AS visit_to_signup_rate,
  CASE WHEN COALESCE(fb.total_clicks, 0) > 0
    THEN ROUND(COALESCE(uv.signup_count, 0)::decimal / fb.total_clicks * 100, 2)
    ELSE 0 END AS click_to_signup_rate,
  CASE WHEN COALESCE(uv.signup_count, 0) > 0
    THEN ROUND(COALESCE(fb.total_spend_cents, 0)::decimal / uv.signup_count / 100, 2)
    ELSE NULL END AS cost_per_signup,
  CASE WHEN COALESCE(uv.publish_count, 0) > 0
    THEN ROUND(COALESCE(fb.total_spend_cents, 0)::decimal / uv.publish_count / 100, 2)
    ELSE NULL END AS cost_per_publish
FROM ad_creatives ac
LEFT JOIN (
  SELECT creative_id,
         SUM(impressions) AS total_impressions,
         SUM(clicks) AS total_clicks,
         SUM(spend_cents) AS total_spend_cents,
         SUM(reach) AS total_reach
  FROM fb_ad_metrics
  GROUP BY creative_id
) fb ON fb.creative_id = ac.creative_id
LEFT JOIN (
  SELECT utm_content,
         COUNT(*) AS visit_count,
         COUNT(*) FILTER (WHERE converted_signup) AS signup_count,
         COUNT(*) FILTER (WHERE converted_event) AS event_count,
         COUNT(*) FILTER (WHERE converted_publish) AS publish_count
  FROM utm_visits
  GROUP BY utm_content
) uv ON uv.utm_content = ac.creative_id;

-- Campaign-level aggregation
CREATE OR REPLACE VIEW campaign_performance AS
SELECT
  campaign_name,
  COUNT(DISTINCT creative_id) AS creative_count,
  SUM(impressions) AS total_impressions,
  SUM(fb_clicks) AS total_clicks,
  SUM(spend_cents) AS total_spend_cents,
  SUM(utm_visits) AS total_visits,
  SUM(signups) AS total_signups,
  SUM(events_created) AS total_events,
  SUM(events_published) AS total_publishes,
  CASE WHEN SUM(fb_clicks) > 0
    THEN ROUND(SUM(signups)::decimal / SUM(fb_clicks) * 100, 2)
    ELSE 0 END AS avg_signup_rate,
  CASE WHEN SUM(signups) > 0
    THEN ROUND(SUM(spend_cents)::decimal / SUM(signups) / 100, 2)
    ELSE NULL END AS avg_cost_per_signup,
  CASE WHEN SUM(events_published) > 0
    THEN ROUND(SUM(spend_cents)::decimal / SUM(events_published) / 100, 2)
    ELSE NULL END AS avg_cost_per_publish,
  MIN(created_at) AS first_creative_at,
  MAX(created_at) AS last_creative_at
FROM ad_creative_performance
GROUP BY campaign_name;

-- Daily trend for dashboard charts
CREATE OR REPLACE VIEW daily_ad_metrics AS
SELECT
  fm.date,
  fm.creative_id,
  ac.campaign_name,
  ac.event_type,
  ac.format,
  fm.impressions,
  fm.clicks,
  fm.spend_cents,
  fm.reach,
  fm.ctr,
  (SELECT COUNT(*) FROM utm_visits uv
   WHERE uv.utm_content = fm.creative_id
     AND uv.created_at::date = fm.date) AS daily_visits,
  (SELECT COUNT(*) FROM utm_visits uv
   WHERE uv.utm_content = fm.creative_id
     AND uv.converted_signup
     AND uv.converted_signup_at::date = fm.date) AS daily_signups
FROM fb_ad_metrics fm
JOIN ad_creatives ac ON ac.creative_id = fm.creative_id
ORDER BY fm.date DESC;

-- RLS Policies (admin-only for all marketing tables)
ALTER TABLE ad_creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE utm_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_ad_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_suggestions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by API endpoints)
CREATE POLICY "Service role full access" ON ad_creatives FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON utm_visits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON fb_ad_metrics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON ad_suggestions FOR ALL USING (true) WITH CHECK (true);
