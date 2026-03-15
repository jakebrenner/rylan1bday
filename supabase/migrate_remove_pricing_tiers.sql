-- Migration: Remove pricing tiers (pro/business) — all users move to free or per_event
-- Run in Supabase SQL editor

-- Move any remaining 'pro' or 'business' users to 'per_event'
UPDATE public.profiles
SET tier = 'per_event', updated_at = now()
WHERE tier IN ('pro', 'business');
