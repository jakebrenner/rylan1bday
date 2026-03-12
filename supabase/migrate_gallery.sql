-- Public Template Gallery migration
-- Adds gallery_eligible flag to event_themes with auto-trigger on admin rating

-- 1. Add gallery_eligible column
ALTER TABLE event_themes ADD COLUMN IF NOT EXISTS gallery_eligible boolean DEFAULT false;

-- 2. Create trigger function to auto-set gallery_eligible when admin_rating >= 4
CREATE OR REPLACE FUNCTION update_gallery_eligibility()
RETURNS trigger AS $$
BEGIN
  NEW.gallery_eligible := (NEW.admin_rating IS NOT NULL AND NEW.admin_rating >= 4);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it already exists, then create
DROP TRIGGER IF EXISTS trg_gallery_eligibility ON event_themes;
CREATE TRIGGER trg_gallery_eligibility
BEFORE INSERT OR UPDATE OF admin_rating ON event_themes
FOR EACH ROW EXECUTE FUNCTION update_gallery_eligibility();

-- 3. Backfill existing highly-rated themes
UPDATE event_themes SET gallery_eligible = true WHERE admin_rating >= 4;

-- 4. Create view for efficient gallery queries (no user-identifying data exposed)
CREATE OR REPLACE VIEW gallery_templates AS
SELECT
  et.id,
  et.html,
  et.css,
  et.config,
  et.admin_rating,
  et.model,
  et.created_at,
  e.event_type
FROM event_themes et
JOIN events e ON et.event_id = e.id
WHERE et.gallery_eligible = true
  AND et.html IS NOT NULL
  AND et.css IS NOT NULL
ORDER BY et.admin_rating DESC, et.created_at DESC;

-- 5. Index for fast gallery queries
CREATE INDEX IF NOT EXISTS idx_event_themes_gallery ON event_themes (gallery_eligible) WHERE gallery_eligible = true;
