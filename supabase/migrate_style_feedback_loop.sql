-- ============================================================
-- Style Feedback Loop — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Closes the feedback loop between style selection and generation
-- quality by:
--   1. Adding style_library_ids to event_themes for direct
--      traceability from output quality back to input styles
--   2. Creating a production_style_effectiveness view that
--      computes a composite score from all three rating sources
--      (admin style rating, production theme quality, user ratings)
--   3. Providing a ready-to-query composite_score that the
--      generation endpoint uses for smarter weighted selection
-- ============================================================

-- ============================================================
-- 1. EVENT_THEMES — add style_library_ids for traceability
-- ============================================================

alter table public.event_themes
  add column if not exists style_library_ids text[] not null default '{}';

comment on column public.event_themes.style_library_ids is 'Which style library items were used as references when generating this theme. Enables direct correlation between input styles and output quality.';

-- GIN index for array containment queries (e.g. "find all themes that used style X")
create index if not exists idx_event_themes_style_ids
  on public.event_themes using gin (style_library_ids);

-- ============================================================
-- 2. PRODUCTION STYLE EFFECTIVENESS VIEW
--
-- Correlates each style library item with the quality of real
-- production themes it helped generate, using three signals:
--   - Admin style rating (direct assessment of the template)
--   - Admin theme ratings (quality of generated output)
--   - User invite ratings (end-user satisfaction)
--
-- Composite score formula (1-5 scale):
--   40% admin style rating (curator signal)
--   35% avg admin theme rating (production quality signal)
--   25% avg user rating (end-user satisfaction signal)
--
-- When production data is missing, falls back to the admin
-- style rating (or 2.0 for unrated styles) so new/unrated
-- styles still get a fair chance.
-- ============================================================

create or replace view public.production_style_effectiveness as
select
  sl.id as style_id,
  sl.name as style_name,
  sl.admin_rating as style_rating,
  sl.times_used,
  -- Production usage stats
  count(et.id)::integer as production_uses,
  count(et.admin_rating)::integer as admin_rated_themes,
  round(avg(et.admin_rating)::numeric, 2) as avg_admin_theme_rating,
  -- User rating stats (aggregated per theme first, then averaged)
  count(ir_agg.event_theme_id)::integer as user_rated_themes,
  round(avg(ir_agg.avg_rating)::numeric, 2) as avg_user_rating,
  -- Lab test stats (from prompt_test_runs)
  count(ptr.id)::integer as lab_test_uses,
  round(avg(ptr.score)::numeric, 2) as avg_lab_score,
  -- Composite score: weighted blend of all signals (1-5 scale)
  round(
    coalesce(sl.admin_rating, 2) * 0.4 +
    coalesce(avg(et.admin_rating), coalesce(sl.admin_rating::numeric, 2)) * 0.35 +
    coalesce(
      -- Prefer user ratings when available, fall back to lab scores, then admin rating
      avg(ir_agg.avg_rating),
      avg(ptr.score)::numeric,
      coalesce(sl.admin_rating::numeric, 2)
    ) * 0.25
  , 2) as composite_score
from public.style_library sl
-- Join to event_themes via style_library_ids array
left join public.event_themes et
  on sl.id::text = any(et.style_library_ids)
-- Aggregate user ratings per theme before joining
left join (
  select event_theme_id, avg(rating)::numeric as avg_rating
  from public.invite_ratings
  group by event_theme_id
) ir_agg on ir_agg.event_theme_id = et.id
-- Lab test results
left join public.prompt_test_runs ptr
  on sl.id = any(ptr.style_library_ids)
group by sl.id, sl.name, sl.admin_rating, sl.times_used;

comment on view public.production_style_effectiveness is 'Composite style effectiveness scores blending admin ratings (40%), production theme quality (35%), and user satisfaction (25%). Used by the generation endpoint for weighted style selection.';

-- ============================================================
-- 3. STYLE RATING IMPACT VIEW
--
-- Quick lookup: for each admin_rating tier (1-5 + unrated),
-- what's the average quality of output produced?
-- Helps admins calibrate whether their ratings are predictive.
-- ============================================================

create or replace view public.style_rating_impact as
select
  coalesce(sl.admin_rating::text, 'unrated') as rating_tier,
  count(distinct sl.id)::integer as style_count,
  count(et.id)::integer as total_themes_generated,
  round(avg(et.admin_rating)::numeric, 2) as avg_output_quality,
  round(avg(ir_agg.avg_rating)::numeric, 2) as avg_user_satisfaction,
  round(avg(sl.times_used)::numeric, 1) as avg_times_used
from public.style_library sl
left join public.event_themes et
  on sl.id::text = any(et.style_library_ids)
left join (
  select event_theme_id, avg(rating)::numeric as avg_rating
  from public.invite_ratings
  group by event_theme_id
) ir_agg on ir_agg.event_theme_id = et.id
group by coalesce(sl.admin_rating::text, 'unrated')
order by rating_tier;

comment on view public.style_rating_impact is 'Validates whether admin style ratings are predictive of output quality. Groups styles by rating tier and shows avg output quality + user satisfaction per tier.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
