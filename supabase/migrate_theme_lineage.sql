-- Theme Lineage Migration
-- Tracks which gallery template a theme was derived from ("Start from Design" flow).
-- Derived themes are excluded from the public inspiration gallery to prevent duplicates,
-- but remain visible in the admin panel.

-- 1. Add lineage column to event_themes
ALTER TABLE event_themes ADD COLUMN IF NOT EXISTS based_on_theme_id text;

-- 2. Backfill: mark existing template-derived themes using events.settings.template_source_id
UPDATE event_themes et
SET based_on_theme_id = e.settings->>'template_source_id'
FROM events e
WHERE et.event_id = e.id
  AND et.model = 'template'
  AND e.settings->>'template_source_id' IS NOT NULL
  AND et.based_on_theme_id IS NULL;

-- 3. Recreate gallery view — exclude derived themes from public gallery
DROP VIEW IF EXISTS gallery_templates;
CREATE VIEW gallery_templates AS

-- User-generated themes (exclude derived copies)
SELECT
  et.id::text AS id,
  et.html,
  et.css,
  et.config,
  et.admin_rating,
  et.model,
  et.created_at,
  e.event_type,
  'user' AS source
FROM event_themes et
JOIN events e ON et.event_id = e.id
WHERE et.gallery_eligible = true
  AND et.html IS NOT NULL
  AND et.css IS NOT NULL
  AND et.based_on_theme_id IS NULL

UNION ALL

-- Lab-generated themes (prompt test runs)
SELECT
  ptr.id::text AS id,
  ptr.result_html AS html,
  ptr.result_css AS css,
  ptr.result_config AS config,
  ptr.score AS admin_rating,
  ptr.model,
  ptr.created_at,
  ptr.event_type,
  'lab' AS source
FROM prompt_test_runs ptr
WHERE ptr.score IS NOT NULL
  AND ptr.score >= 4
  AND COALESCE(ptr.exclude_from_gallery, false) = false
  AND ptr.result_html IS NOT NULL
  AND ptr.result_css IS NOT NULL

UNION ALL

-- Style library items
SELECT
  sl.id::text AS id,
  sl.html,
  NULL::text AS css,
  NULL::jsonb AS config,
  sl.admin_rating,
  NULL::text AS model,
  sl.created_at,
  sl.event_types[1] AS event_type,
  'style' AS source
FROM style_library sl
WHERE sl.admin_rating IS NOT NULL
  AND sl.admin_rating >= 4
  AND COALESCE(sl.exclude_from_gallery, false) = false
  AND sl.html IS NOT NULL

ORDER BY admin_rating DESC, created_at DESC;

-- 4. Index for filtering derived themes
CREATE INDEX IF NOT EXISTS idx_event_themes_lineage
  ON event_themes (based_on_theme_id) WHERE based_on_theme_id IS NOT NULL;
