-- Add video rendering status tracking to ad_creatives
-- Enables server-side background video rendering

ALTER TABLE ad_creatives
  ADD COLUMN IF NOT EXISTS video_status TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS video_error TEXT,
  ADD COLUMN IF NOT EXISTS video_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS video_completed_at TIMESTAMPTZ;

-- video_status values: 'none', 'rendering', 'ready', 'failed'

-- Create storage bucket for rendered ad videos (public read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('ad-videos', 'ad-videos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to ad videos
CREATE POLICY "Public read ad-videos" ON storage.objects
  FOR SELECT USING (bucket_id = 'ad-videos');

-- Allow service role to insert/update/delete
CREATE POLICY "Service role manage ad-videos" ON storage.objects
  FOR ALL USING (bucket_id = 'ad-videos' AND auth.role() = 'service_role');
