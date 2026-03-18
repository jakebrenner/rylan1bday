-- Viral Loop Tracking Infrastructure
-- Run in Supabase SQL editor

-- ═══════════════════════════════════════════════════════
-- 1. viral_events — lightweight analytics for invite pages
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS viral_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type text NOT NULL,                    -- 'page_view', 'footer_click', 'rsvp_cta_click'
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  metadata jsonb DEFAULT '{}',                 -- slug, referrer, user_agent, etc.
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_viral_events_type ON viral_events(event_type);
CREATE INDEX IF NOT EXISTS idx_viral_events_created ON viral_events(created_at);
CREATE INDEX IF NOT EXISTS idx_viral_events_event ON viral_events(event_id);

-- Composite index for common admin queries (type + date range)
CREATE INDEX IF NOT EXISTS idx_viral_events_type_created ON viral_events(event_type, created_at);

-- ═══════════════════════════════════════════════════════
-- 2. UTM attribution on profiles
-- ═══════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS signup_utm jsonb;

-- Index for querying signups from invite pages
CREATE INDEX IF NOT EXISTS idx_profiles_signup_utm ON profiles USING gin(signup_utm);

-- ═══════════════════════════════════════════════════════
-- 3. RLS policies — viral_events is insert-only for public
-- ═══════════════════════════════════════════════════════

ALTER TABLE viral_events ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (tracking from invite pages — no auth)
CREATE POLICY "viral_events_insert_public" ON viral_events
  FOR INSERT WITH CHECK (true);

-- Only service role can read (admin API)
CREATE POLICY "viral_events_select_service" ON viral_events
  FOR SELECT USING (auth.role() = 'service_role');
