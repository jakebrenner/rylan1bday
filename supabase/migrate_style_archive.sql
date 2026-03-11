-- Migration: Add archive support to style_library
-- Run in Supabase SQL editor

-- Add archived columns
ALTER TABLE style_library ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE style_library ADD COLUMN IF NOT EXISTS archived_by TEXT DEFAULT NULL;
