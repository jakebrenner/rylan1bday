-- Reviews & Testimonials System
-- Adds review collection, moderation, and public display capabilities

-- ============================================================
-- Table: reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  event_theme_id uuid REFERENCES event_themes(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  headline text CHECK (char_length(headline) <= 120),
  body text CHECK (char_length(body) <= 2000),
  reviewer_name text NOT NULL,
  is_anonymous boolean DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'featured', 'rejected')),
  event_type text,
  admin_notes text,
  moderated_by text,
  moderated_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One review per user per event
CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_event_unique ON reviews (user_id, event_id);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews (status);
CREATE INDEX IF NOT EXISTS reviews_created_at_idx ON reviews (created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_event_type_idx ON reviews (event_type);

-- ============================================================
-- Table: review_requests
-- ============================================================
CREATE TABLE IF NOT EXISTS review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'reminded', 'completed', 'dismissed')),
  sent_at timestamptz,
  reminder_sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- One request per event
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_event_unique ON review_requests (event_id);
CREATE INDEX IF NOT EXISTS review_requests_status_idx ON review_requests (status);
CREATE INDEX IF NOT EXISTS review_requests_token_idx ON review_requests (token);

-- ============================================================
-- View: review_stats
-- ============================================================
CREATE OR REPLACE VIEW review_stats AS
SELECT
  count(*) AS total_reviews,
  round(avg(rating)::numeric, 2) AS avg_rating,
  count(*) FILTER (WHERE status = 'pending') AS pending_count,
  count(*) FILTER (WHERE status = 'approved') AS approved_count,
  count(*) FILTER (WHERE status = 'featured') AS featured_count,
  count(*) FILTER (WHERE status = 'rejected') AS rejected_count,
  (SELECT count(*) FROM review_requests) AS total_requests,
  (SELECT count(*) FROM review_requests WHERE status = 'completed') AS completed_requests
FROM reviews;

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for API/cron)
CREATE POLICY reviews_service_all ON reviews FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY review_requests_service_all ON review_requests FOR ALL USING (true) WITH CHECK (true);

-- Public can read featured/approved reviews (for homepage)
CREATE POLICY reviews_public_read ON reviews FOR SELECT
  USING (status IN ('approved', 'featured'));
