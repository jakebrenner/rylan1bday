-- ============================================================
-- All Campaign Performance View
-- Shows ALL Facebook campaigns (not just Ryvite-matched ones)
-- Matches conversions via utm_content (creative-level) OR
-- utm_campaign (campaign-level fallback)
-- ============================================================

CREATE OR REPLACE VIEW all_campaign_performance AS
WITH fb_agg AS (
  -- Aggregate FB metrics by campaign (all campaigns in the account)
  SELECT
    fb_campaign_name,
    fb_campaign_id,
    COUNT(DISTINCT CASE WHEN creative_id IS NOT NULL THEN creative_id END) AS creative_count,
    SUM(impressions) AS total_impressions,
    SUM(clicks) AS total_clicks,
    SUM(spend_cents) AS total_spend_cents
  FROM fb_ad_metrics
  WHERE fb_campaign_name IS NOT NULL
  GROUP BY fb_campaign_name, fb_campaign_id
),
-- Creative-level conversions (utm_content matches ad_creatives.creative_id)
creative_conversions AS (
  SELECT
    fm.fb_campaign_name,
    COUNT(DISTINCT uv.id) AS total_visits,
    COUNT(DISTINCT uv.id) FILTER (WHERE uv.converted_signup) AS total_signups,
    COUNT(DISTINCT uv.id) FILTER (WHERE uv.converted_event) AS total_events,
    COUNT(DISTINCT uv.id) FILTER (WHERE uv.converted_publish) AS total_publishes
  FROM fb_ad_metrics fm
  INNER JOIN utm_visits uv ON uv.utm_content = fm.creative_id
  WHERE fm.creative_id IS NOT NULL
    AND fm.fb_campaign_name IS NOT NULL
  GROUP BY fm.fb_campaign_name
),
-- Campaign-level conversions (utm_campaign matches fb_campaign_name directly)
campaign_conversions AS (
  SELECT
    utm_campaign AS fb_campaign_name,
    COUNT(DISTINCT id) AS total_visits,
    COUNT(DISTINCT id) FILTER (WHERE converted_signup) AS total_signups,
    COUNT(DISTINCT id) FILTER (WHERE converted_event) AS total_events,
    COUNT(DISTINCT id) FILTER (WHERE converted_publish) AS total_publishes
  FROM utm_visits
  WHERE utm_campaign IS NOT NULL
  GROUP BY utm_campaign
),
-- Merge: prefer creative-level, add campaign-level for any not already counted
merged_conversions AS (
  SELECT
    COALESCE(cc.fb_campaign_name, camp.fb_campaign_name) AS fb_campaign_name,
    GREATEST(COALESCE(cc.total_visits, 0), COALESCE(camp.total_visits, 0)) AS total_visits,
    GREATEST(COALESCE(cc.total_signups, 0), COALESCE(camp.total_signups, 0)) AS total_signups,
    GREATEST(COALESCE(cc.total_events, 0), COALESCE(camp.total_events, 0)) AS total_events,
    GREATEST(COALESCE(cc.total_publishes, 0), COALESCE(camp.total_publishes, 0)) AS total_publishes
  FROM creative_conversions cc
  FULL OUTER JOIN campaign_conversions camp ON camp.fb_campaign_name = cc.fb_campaign_name
)
SELECT
  fa.fb_campaign_name AS campaign_name,
  fa.fb_campaign_id,
  fa.creative_count,
  fa.total_impressions,
  fa.total_clicks,
  fa.total_spend_cents,
  COALESCE(mc.total_visits, 0) AS total_visits,
  COALESCE(mc.total_signups, 0) AS total_signups,
  COALESCE(mc.total_events, 0) AS total_events,
  COALESCE(mc.total_publishes, 0) AS total_publishes,
  CASE WHEN fa.total_clicks > 0
    THEN ROUND(COALESCE(mc.total_signups, 0)::decimal / fa.total_clicks * 100, 2)
    ELSE 0 END AS avg_signup_rate,
  CASE WHEN COALESCE(mc.total_signups, 0) > 0
    THEN ROUND(fa.total_spend_cents::decimal / mc.total_signups / 100, 2)
    ELSE NULL END AS avg_cost_per_signup,
  CASE WHEN COALESCE(mc.total_publishes, 0) > 0
    THEN ROUND(fa.total_spend_cents::decimal / mc.total_publishes / 100, 2)
    ELSE NULL END AS avg_cost_per_publish,
  CASE WHEN fa.creative_count > 0 THEN 'ryvite' ELSE 'fb_only' END AS source
FROM fb_agg fa
LEFT JOIN merged_conversions mc ON mc.fb_campaign_name = fa.fb_campaign_name;
