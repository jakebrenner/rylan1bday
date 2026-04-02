-- ============================================================
-- All Campaign Performance View
-- Shows ALL Facebook campaigns (not just Ryvite-matched ones)
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
conversion_agg AS (
  -- Aggregate Ryvite conversion data per FB campaign (only for matched creatives)
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
)
SELECT
  fa.fb_campaign_name AS campaign_name,
  fa.fb_campaign_id,
  fa.creative_count,
  fa.total_impressions,
  fa.total_clicks,
  fa.total_spend_cents,
  COALESCE(ca.total_visits, 0) AS total_visits,
  COALESCE(ca.total_signups, 0) AS total_signups,
  COALESCE(ca.total_events, 0) AS total_events,
  COALESCE(ca.total_publishes, 0) AS total_publishes,
  CASE WHEN fa.total_clicks > 0
    THEN ROUND(COALESCE(ca.total_signups, 0)::decimal / fa.total_clicks * 100, 2)
    ELSE 0 END AS avg_signup_rate,
  CASE WHEN COALESCE(ca.total_signups, 0) > 0
    THEN ROUND(fa.total_spend_cents::decimal / ca.total_signups / 100, 2)
    ELSE NULL END AS avg_cost_per_signup,
  CASE WHEN COALESCE(ca.total_publishes, 0) > 0
    THEN ROUND(fa.total_spend_cents::decimal / ca.total_publishes / 100, 2)
    ELSE NULL END AS avg_cost_per_publish,
  CASE WHEN fa.creative_count > 0 THEN 'ryvite' ELSE 'fb_only' END AS source
FROM fb_agg fa
LEFT JOIN conversion_agg ca ON ca.fb_campaign_name = fa.fb_campaign_name;
