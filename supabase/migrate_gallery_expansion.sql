-- Gallery Expansion Migration
-- Includes lab generations and style library items in the public inspiration gallery.
-- Adds exclude_from_gallery flag so admins can manually exclude any item.

-- 1. Add exclude_from_gallery to event_themes
ALTER TABLE event_themes ADD COLUMN IF NOT EXISTS exclude_from_gallery boolean DEFAULT false;

-- 2. Add exclude_from_gallery to prompt_test_runs
ALTER TABLE prompt_test_runs ADD COLUMN IF NOT EXISTS exclude_from_gallery boolean DEFAULT false;

-- 3. Add exclude_from_gallery to style_library
ALTER TABLE style_library ADD COLUMN IF NOT EXISTS exclude_from_gallery boolean DEFAULT false;

-- 4. Update the gallery eligibility trigger to respect exclude_from_gallery
CREATE OR REPLACE FUNCTION update_gallery_eligibility()
RETURNS trigger AS $$
BEGIN
  NEW.gallery_eligible := (
    NEW.admin_rating IS NOT NULL
    AND NEW.admin_rating >= 4
    AND NOT COALESCE(NEW.exclude_from_gallery, false)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to also fire on exclude_from_gallery changes
DROP TRIGGER IF EXISTS trg_gallery_eligibility ON event_themes;
CREATE TRIGGER trg_gallery_eligibility
BEFORE INSERT OR UPDATE OF admin_rating, exclude_from_gallery ON event_themes
FOR EACH ROW EXECUTE FUNCTION update_gallery_eligibility();

-- 5. Backfill: unset gallery_eligible for any excluded items
UPDATE event_themes SET gallery_eligible = false WHERE exclude_from_gallery = true AND gallery_eligible = true;

-- 6. Drop and recreate the gallery_templates view (id type changes from uuid to text)
DROP VIEW IF EXISTS gallery_templates;
CREATE VIEW gallery_templates AS

-- User-generated themes (existing source)
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

-- 7. Indexes for fast gallery queries on new sources
CREATE INDEX IF NOT EXISTS idx_prompt_test_runs_gallery
  ON prompt_test_runs (score) WHERE score >= 4 AND exclude_from_gallery = false;
CREATE INDEX IF NOT EXISTS idx_style_library_gallery
  ON style_library (admin_rating) WHERE admin_rating >= 4 AND exclude_from_gallery = false;
