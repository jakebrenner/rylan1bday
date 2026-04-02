-- ============================================================
-- Test Run Metadata — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Adds richer metadata to prompt_test_runs so admins can analyze
-- which combinations of prompts, models, styles, and event details
-- yield the best-rated generations.
-- ============================================================

-- 1. Add style library tracking + thank-you HTML
alter table public.prompt_test_runs
  add column if not exists style_library_ids text[] not null default '{}',
  add column if not exists result_thankyou_html text default '';

comment on column public.prompt_test_runs.style_library_ids is 'Which style library items were used as references for this generation.';
comment on column public.prompt_test_runs.result_thankyou_html is 'Generated thank-you page HTML.';

-- 2. Index for style library analysis (GIN for array containment queries)
create index if not exists idx_prompt_test_runs_styles
  on public.prompt_test_runs using gin (style_library_ids);

-- 3. Index for model + score analysis
create index if not exists idx_prompt_test_runs_model_score
  on public.prompt_test_runs (model, score) where score is not null;

-- 4. Composite index for prompt × model analysis
create index if not exists idx_prompt_test_runs_version_model
  on public.prompt_test_runs (prompt_version_id, model);

-- ============================================================
-- 5. ANALYTICS VIEW — comprehensive test run performance
-- NOTE: This view's cost formula was incorrect (1000x inflation).
-- Superseded by migrate_fix_test_run_cost.sql which has model-aware pricing.
-- ============================================================

create or replace view public.test_run_analytics as
select
  ptr.prompt_version_id,
  pv.name as prompt_name,
  pv.version as prompt_version,
  ptr.model,
  ptr.event_type,
  count(*)::integer as total_runs,
  count(ptr.score)::integer as rated_runs,
  round(avg(ptr.score)::numeric, 2) as avg_score,
  count(*) filter (where ptr.score >= 4)::integer as high_quality,
  count(*) filter (where ptr.score <= 2)::integer as low_quality,
  round(avg(ptr.latency_ms)::numeric, 0) as avg_latency_ms,
  round(avg(ptr.input_tokens + ptr.output_tokens)::numeric, 0) as avg_total_tokens,
  round(avg(ptr.input_tokens * 0.003 + ptr.output_tokens * 0.015)::numeric, 4) as avg_est_cost,
  min(ptr.created_at) as first_run,
  max(ptr.created_at) as last_run
from public.prompt_test_runs ptr
left join public.prompt_versions pv on pv.id = ptr.prompt_version_id
group by ptr.prompt_version_id, pv.name, pv.version, ptr.model, ptr.event_type;

comment on view public.test_run_analytics is 'Comprehensive test run performance analytics grouped by prompt version, model, and event type.';

-- ============================================================
-- 6. STYLE EFFECTIVENESS VIEW — which styles correlate with better ratings
-- ============================================================

create or replace view public.style_effectiveness as
select
  sl.id as style_id,
  sl.name as style_name,
  sl.admin_rating as style_admin_rating,
  sl.times_used,
  count(ptr.id)::integer as times_as_reference,
  count(ptr.score)::integer as rated_references,
  round(avg(ptr.score)::numeric, 2) as avg_generation_score,
  count(*) filter (where ptr.score >= 4)::integer as high_quality_generations,
  count(*) filter (where ptr.score <= 2)::integer as low_quality_generations
from public.style_library sl
left join public.prompt_test_runs ptr on sl.id = any(ptr.style_library_ids)
group by sl.id, sl.name, sl.admin_rating, sl.times_used;

comment on view public.style_effectiveness is 'How effective each style library item is as a generation reference — correlates style usage with output quality ratings.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
