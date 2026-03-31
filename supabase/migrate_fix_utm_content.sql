-- ============================================================
-- Fix utm_content in existing ad_creatives UTM URLs
-- ============================================================
-- Bug: utm_content was set to source_id (a UUID) instead of
-- creative_id (e.g. 'fb-abc123'). This broke attribution since
-- ad_creative_performance view joins on utm_content = creative_id.
-- ============================================================

UPDATE ad_creatives
SET utm_url = regexp_replace(
  utm_url,
  'utm_content=[^&]+',
  'utm_content=' || creative_id
)
WHERE utm_url IS NOT NULL
  AND utm_url NOT LIKE '%utm_content=' || creative_id || '%';
