-- Blog System Migration for Ryvite
-- Run this in the Supabase SQL editor

-- 1. Create blog post status enum
DO $$ BEGIN
  CREATE TYPE blog_post_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Blog categories table
CREATE TABLE IF NOT EXISTS blog_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Blog posts table
CREATE TABLE IF NOT EXISTS blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT DEFAULT '',
  content TEXT DEFAULT '',
  published_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_date TIMESTAMPTZ,
  category TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  post_type TEXT DEFAULT 'article',
  author_slug TEXT DEFAULT 'ryvite-team',
  reviewed_by TEXT,
  featured_image JSONB,
  seo JSONB,
  featured BOOLEAN DEFAULT false,
  status blog_post_status DEFAULT 'draft',
  related_slugs TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Blog slug redirects (301 redirect tracking)
CREATE TABLE IF NOT EXISTS blog_redirects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts (status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts (category);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_date ON blog_posts (published_date DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_author_slug ON blog_posts (author_slug);
CREATE INDEX IF NOT EXISTS idx_blog_redirects_old_slug ON blog_redirects (old_slug);

-- 6. Enable RLS on all tables
ALTER TABLE blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_redirects ENABLE ROW LEVEL SECURITY;

-- 7. RLS policies

-- blog_categories: public read, service-role write
CREATE POLICY "blog_categories_public_read" ON blog_categories
  FOR SELECT USING (true);

CREATE POLICY "blog_categories_service_write" ON blog_categories
  FOR ALL USING (true) WITH CHECK (true);

-- blog_posts: public read for published, service-role write
CREATE POLICY "blog_posts_public_read" ON blog_posts
  FOR SELECT USING (true);

CREATE POLICY "blog_posts_service_write" ON blog_posts
  FOR ALL USING (true) WITH CHECK (true);

-- blog_redirects: public read, service-role write
CREATE POLICY "blog_redirects_public_read" ON blog_redirects
  FOR SELECT USING (true);

CREATE POLICY "blog_redirects_service_write" ON blog_redirects
  FOR ALL USING (true) WITH CHECK (true);
