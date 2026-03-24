-- ============================================================================
-- AUTO-EVAL: Automated prompt testing loop with AI-as-judge evaluation
-- ============================================================================
-- Run this migration in Supabase SQL editor.
-- Prerequisites: prompt_versions and prompt_test_runs tables must exist.
-- ============================================================================

-- Loop runs — tracks each automated test loop execution
create table if not exists public.loop_runs (
  id text primary key,
  config jsonb not null default '{}',
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  total_generations integer not null default 0,
  completed_generations integer not null default 0,
  failed_generations integer not null default 0,
  total_cost_cents numeric not null default 0,
  max_budget_cents numeric not null default 500,
  -- Aggregated scores (updated as evaluations complete)
  avg_overall_score numeric,
  avg_structural_score numeric,
  -- Insights report (generated after loop completes)
  insights_report jsonb,
  -- Draft prompt version created by auto-refinement (null if none)
  draft_prompt_version_id uuid references public.prompt_versions(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by text
);

-- Auto eval scores — AI judge + structural scores per test run
create table if not exists public.auto_eval_scores (
  id uuid primary key default gen_random_uuid(),
  test_run_id uuid references public.prompt_test_runs(id) on delete cascade,
  -- AI judge scores (1-5 each)
  visual_design integer check (visual_design between 1 and 5),
  text_contrast integer check (text_contrast between 1 and 5),
  layout_structure integer check (layout_structure between 1 and 5),
  theme_coherence integer check (theme_coherence between 1 and 5),
  animation_quality integer check (animation_quality between 1 and 5),
  completeness integer check (completeness between 1 and 5),
  overall integer check (overall between 1 and 5),
  -- AI judge qualitative feedback
  issues text[] default '{}',
  strengths text[] default '{}',
  -- AI judge metadata
  eval_model text default 'claude-haiku-4-5-20251001',
  eval_tokens_in integer,
  eval_tokens_out integer,
  eval_latency_ms integer,
  eval_cost_cents numeric,
  -- Programmatic structural score (0-100)
  structural_score integer check (structural_score between 0 and 100),
  structural_issues text[] default '{}',
  structural_passed boolean default true,
  -- Loop context
  loop_run_id text references public.loop_runs(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_auto_eval_loop on public.auto_eval_scores(loop_run_id);
create index if not exists idx_auto_eval_test_run on public.auto_eval_scores(test_run_id);
create index if not exists idx_auto_eval_overall on public.auto_eval_scores(overall);
create index if not exists idx_loop_runs_status on public.loop_runs(status);

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Loop run summary — aggregated scores per prompt×model combo within a loop
create or replace view public.loop_run_summary as
select
  lr.id as loop_run_id,
  lr.status,
  lr.config,
  lr.total_generations,
  lr.completed_generations,
  lr.failed_generations,
  lr.total_cost_cents,
  lr.started_at,
  lr.completed_at,
  lr.insights_report,
  lr.draft_prompt_version_id,
  ptr.prompt_version_id,
  pv.name as prompt_name,
  pv.version as prompt_version,
  ptr.model,
  ptr.event_type,
  count(*) as run_count,
  round(avg(ae.overall), 2) as avg_overall,
  round(avg(ae.visual_design), 2) as avg_visual_design,
  round(avg(ae.text_contrast), 2) as avg_text_contrast,
  round(avg(ae.layout_structure), 2) as avg_layout_structure,
  round(avg(ae.theme_coherence), 2) as avg_theme_coherence,
  round(avg(ae.animation_quality), 2) as avg_animation_quality,
  round(avg(ae.completeness), 2) as avg_completeness,
  round(avg(ae.structural_score), 1) as avg_structural_score,
  round(avg(ptr.latency_ms)) as avg_latency_ms,
  round(avg(ptr.input_tokens + ptr.output_tokens)) as avg_total_tokens
from loop_runs lr
join auto_eval_scores ae on ae.loop_run_id = lr.id
join prompt_test_runs ptr on ptr.id = ae.test_run_id
left join prompt_versions pv on pv.id = ptr.prompt_version_id
group by lr.id, lr.status, lr.config, lr.total_generations,
         lr.completed_generations, lr.failed_generations, lr.total_cost_cents,
         lr.started_at, lr.completed_at, lr.insights_report,
         lr.draft_prompt_version_id,
         ptr.prompt_version_id, pv.name, pv.version, ptr.model, ptr.event_type;

-- Prompt version leaderboard — overall ranking across all loop runs
create or replace view public.prompt_loop_leaderboard as
select
  ptr.prompt_version_id,
  pv.name as prompt_name,
  pv.version as prompt_version,
  ptr.model,
  count(*) as total_runs,
  round(avg(ae.overall), 2) as avg_overall,
  round(avg(ae.visual_design), 2) as avg_visual_design,
  round(avg(ae.text_contrast), 2) as avg_text_contrast,
  round(avg(ae.layout_structure), 2) as avg_layout_structure,
  round(avg(ae.theme_coherence), 2) as avg_theme_coherence,
  round(avg(ae.animation_quality), 2) as avg_animation_quality,
  round(avg(ae.completeness), 2) as avg_completeness,
  round(avg(ae.structural_score), 1) as avg_structural_score,
  round(avg(ptr.latency_ms)) as avg_latency_ms,
  count(*) filter (where ae.overall >= 4) as high_quality_count,
  count(*) filter (where ae.overall <= 2) as low_quality_count
from auto_eval_scores ae
join prompt_test_runs ptr on ptr.id = ae.test_run_id
left join prompt_versions pv on pv.id = ptr.prompt_version_id
group by ptr.prompt_version_id, pv.name, pv.version, ptr.model
order by avg_overall desc;

-- Event type weakness analysis — which event types score lowest
create or replace view public.event_type_quality as
select
  ptr.event_type,
  ptr.prompt_version_id,
  pv.name as prompt_name,
  count(*) as total_runs,
  round(avg(ae.overall), 2) as avg_overall,
  round(avg(ae.visual_design), 2) as avg_visual_design,
  round(avg(ae.text_contrast), 2) as avg_text_contrast,
  round(avg(ae.theme_coherence), 2) as avg_theme_coherence,
  round(avg(ae.structural_score), 1) as avg_structural_score,
  -- Identify the weakest dimension per event type
  case
    when avg(ae.text_contrast) <= least(avg(ae.visual_design), avg(ae.layout_structure), avg(ae.theme_coherence), avg(ae.animation_quality), avg(ae.completeness))
    then 'text_contrast'
    when avg(ae.visual_design) <= least(avg(ae.text_contrast), avg(ae.layout_structure), avg(ae.theme_coherence), avg(ae.animation_quality), avg(ae.completeness))
    then 'visual_design'
    when avg(ae.layout_structure) <= least(avg(ae.visual_design), avg(ae.text_contrast), avg(ae.theme_coherence), avg(ae.animation_quality), avg(ae.completeness))
    then 'layout_structure'
    when avg(ae.theme_coherence) <= least(avg(ae.visual_design), avg(ae.text_contrast), avg(ae.layout_structure), avg(ae.animation_quality), avg(ae.completeness))
    then 'theme_coherence'
    when avg(ae.animation_quality) <= least(avg(ae.visual_design), avg(ae.text_contrast), avg(ae.layout_structure), avg(ae.theme_coherence), avg(ae.completeness))
    then 'animation_quality'
    else 'completeness'
  end as weakest_dimension
from auto_eval_scores ae
join prompt_test_runs ptr on ptr.id = ae.test_run_id
left join prompt_versions pv on pv.id = ptr.prompt_version_id
group by ptr.event_type, ptr.prompt_version_id, pv.name
order by avg_overall asc;

-- ============================================================================
-- RLS (allow service role full access, no public access)
-- ============================================================================
alter table public.loop_runs enable row level security;
alter table public.auto_eval_scores enable row level security;

-- Service role bypass (used by API)
create policy "Service role full access on loop_runs"
  on public.loop_runs for all
  using (true) with check (true);

create policy "Service role full access on auto_eval_scores"
  on public.auto_eval_scores for all
  using (true) with check (true);
