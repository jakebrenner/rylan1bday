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
-- production themes it helped generate, PER EVENT TYPE.
--
-- Signals (all scoped to event type):
--   - Admin style rating (direct assessment of the template — global)
--   - Admin theme ratings (quality of generated output — per event type)
--   - User invite ratings (end-user satisfaction — per event type)
--   - Lab test scores (prompt lab results — per event type)
--
-- EVENT TYPE AWARENESS:
--   A style rated 5-star for weddings doesn't boost its score
--   for birthdays. Each (style, event_type) pair gets its own
--   composite score, data_points count, and confidence gate.
--
-- CONFIDENCE GATING (small sample safety):
--   Production/user signals only influence the composite score
--   once a style has enough rated data points FOR THAT EVENT TYPE
--   (threshold: 5). Below that, composite_score = admin_rating.
--
--   Above threshold, signals blend in gradually via Bayesian-like
--   damping: blend_factor = data_points / (data_points + 5)
--     5 data points  → 50% production influence
--     10 data points → 67% production influence
--     20 data points → 80% production influence
--     50 data points → 91% production influence
-- ============================================================

-- DROP first because column layout changed (added event_type, reordered columns).
-- CREATE OR REPLACE can't rename/reorder columns on an existing view.
drop view if exists public.production_style_effectiveness;
create or replace view public.production_style_effectiveness as
select
  sl.id as style_id,
  sl.name as style_name,
  sl.admin_rating as style_rating,
  sl.times_used,
  e.event_type,
  -- Production usage stats (per event type)
  count(et.id)::integer as production_uses,
  count(et.admin_rating)::integer as admin_rated_themes,
  round(avg(et.admin_rating)::numeric, 2) as avg_admin_theme_rating,
  -- User rating stats (aggregated per theme first, then averaged)
  count(ir_agg.event_theme_id)::integer as user_rated_themes,
  round(avg(ir_agg.avg_rating)::numeric, 2) as avg_user_rating,
  -- Lab test stats (pre-aggregated by style + event_type)
  coalesce(lab.lab_test_uses, 0)::integer as lab_test_uses,
  lab.avg_lab_score,
  -- Total rated data points for THIS event type
  (count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0))::integer as data_points,
  -- Confidence-gated composite score (1-5 scale, per event type)
  -- Below 5 data points: pure admin_rating (or 2 for unrated)
  -- Above 5: gradually blends in production/user signals
  round(
    case
      when (count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0)) < 5 then
        -- Not enough data for this event type — trust admin rating only
        coalesce(sl.admin_rating, 2)::numeric
      else
        -- Enough data — blend with Bayesian damping
        -- blend_factor = data_points / (data_points + 5)
        coalesce(sl.admin_rating, 2)::numeric * (
          1.0 - (count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0))::numeric
                / ((count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0))::numeric + 5)
        )
        + (
          -- Blended production score: weighted avg of available signals
          coalesce(sl.admin_rating, 2)::numeric * 0.4 +
          coalesce(avg(et.admin_rating), coalesce(sl.admin_rating::numeric, 2)) * 0.35 +
          coalesce(
            avg(ir_agg.avg_rating),
            lab.avg_lab_score,
            coalesce(sl.admin_rating::numeric, 2)
          ) * 0.25
        ) * (
          (count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0))::numeric
          / ((count(et.admin_rating) + count(ir_agg.event_theme_id) + coalesce(lab.lab_test_uses, 0))::numeric + 5)
        )
    end
  , 2) as composite_score
from public.style_library sl
-- Join event_themes and events to get event_type
left join public.event_themes et
  on sl.id::text = any(et.style_library_ids)
left join public.events e
  on e.id = et.event_id
-- Aggregate user ratings per theme before joining
left join (
  select event_theme_id, avg(rating)::numeric as avg_rating
  from public.invite_ratings
  group by event_theme_id
) ir_agg on ir_agg.event_theme_id = et.id
-- Pre-aggregated lab tests by style + event_type
left join (
  select
    unnest_id as style_id,
    event_type,
    count(*)::integer as lab_test_uses,
    round(avg(score)::numeric, 2) as avg_lab_score
  from public.prompt_test_runs,
       unnest(style_library_ids) as unnest_id
  where score is not null
  group by unnest_id, event_type
) lab on lab.style_id = sl.id::text and lab.event_type = e.event_type
where e.event_type is not null
group by sl.id, sl.name, sl.admin_rating, sl.times_used, e.event_type,
         lab.lab_test_uses, lab.avg_lab_score;

comment on view public.production_style_effectiveness is 'Confidence-gated composite style scores per event type. Below 5 data points for a given event type: pure admin_rating. Above: gradually blends in production quality (35%), user satisfaction (25%), anchored by admin rating (40%). Used by generation endpoint for weighted selection.';

-- ============================================================
-- 3. STYLE RATING IMPACT VIEW
--
-- Quick lookup: for each admin_rating tier (1-5 + unrated) AND
-- event type, what's the average quality of output produced?
-- Helps admins calibrate whether their ratings are predictive
-- and whether certain styles work better for specific event types.
-- ============================================================

drop view if exists public.style_rating_impact;
create or replace view public.style_rating_impact as
select
  coalesce(sl.admin_rating::text, 'unrated') as rating_tier,
  e.event_type,
  count(distinct sl.id)::integer as style_count,
  count(et.id)::integer as total_themes_generated,
  round(avg(et.admin_rating)::numeric, 2) as avg_output_quality,
  round(avg(ir_agg.avg_rating)::numeric, 2) as avg_user_satisfaction,
  round(avg(sl.times_used)::numeric, 1) as avg_times_used
from public.style_library sl
left join public.event_themes et
  on sl.id::text = any(et.style_library_ids)
left join public.events e
  on e.id = et.event_id
left join (
  select event_theme_id, avg(rating)::numeric as avg_rating
  from public.invite_ratings
  group by event_theme_id
) ir_agg on ir_agg.event_theme_id = et.id
where e.event_type is not null
group by coalesce(sl.admin_rating::text, 'unrated'), e.event_type
order by rating_tier, e.event_type;

comment on view public.style_rating_impact is 'Validates whether admin style ratings are predictive of output quality, broken down by event type. Groups styles by rating tier and event type, showing avg output quality + user satisfaction per combination.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
