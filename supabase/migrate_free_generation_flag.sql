-- Migration: Add free generation tracking flags to events
-- free_generation_used: Set true after first AI generation (free tier gets 1)
-- free_redo_used: Set true after a free "redo" when AI got the design completely wrong
-- This gives free users 1 generation + 1 redo if the AI missed the mark.

-- 1. Add columns (safe to re-run)
ALTER TABLE events ADD COLUMN IF NOT EXISTS free_generation_used boolean DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS free_redo_used boolean DEFAULT false;

-- 2. Reset flags for existing free events
-- Ensures migrated events with pre-pricing-change generations still get 1 free generation + 1 redo
UPDATE events SET free_generation_used = false, free_redo_used = false WHERE payment_status = 'free';
