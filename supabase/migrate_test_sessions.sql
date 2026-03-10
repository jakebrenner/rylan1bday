-- ============================================================
-- Test Session Grouping — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Groups related test generations into sessions so that matrix
-- tests (same inputs, different prompt×model combos) can be
-- compared side-by-side. Enables analysis like:
--   "Given identical inputs, why did Haiku score 4 and Opus score 1?"
--   "Which models consistently win head-to-head comparisons?"
-- ============================================================

-- 1. Add session tracking to test runs
alter table public.prompt_test_runs
  add column if not exists test_session_id text,
  add column if not exists session_position integer default 0;

comment on column public.prompt_test_runs.test_session_id is 'Groups test runs from the same matrix test. All runs in one "Generate" click share a session ID.';
comment on column public.prompt_test_runs.session_position is 'Position within the session (0-indexed). Useful for ordering when displaying results.';

-- Index for session lookups
create index if not exists idx_prompt_test_runs_session
  on public.prompt_test_runs (test_session_id) where test_session_id is not null;

-- ============================================================
-- 2. SESSION COMPARISON VIEW — head-to-head within sessions
-- ============================================================

create or replace view public.test_session_comparisons as
with session_runs as (
  select
    ptr.test_session_id,
    ptr.id as run_id,
    ptr.model,
    ptr.prompt_version_id,
    pv.name as prompt_name,
    pv.version as prompt_version,
    ptr.event_type,
    ptr.score,
    ptr.latency_ms,
    ptr.input_tokens,
    ptr.output_tokens,
    ptr.created_at,
    count(*) over (partition by ptr.test_session_id) as session_size,
    rank() over (partition by ptr.test_session_id order by ptr.score desc nulls last) as score_rank,
    max(ptr.score) over (partition by ptr.test_session_id) as session_best_score,
    min(ptr.score) over (partition by ptr.test_session_id) as session_worst_score,
    avg(ptr.score) over (partition by ptr.test_session_id) as session_avg_score
  from public.prompt_test_runs ptr
  left join public.prompt_versions pv on pv.id = ptr.prompt_version_id
  where ptr.test_session_id is not null
)
select * from session_runs
where session_size >= 2;

comment on view public.test_session_comparisons is 'Head-to-head comparisons within matrix test sessions. Each session shares identical inputs — only prompt version and model differ.';

-- ============================================================
-- 3. MODEL HEAD-TO-HEAD WINS VIEW
-- ============================================================

create or replace view public.model_head_to_head as
with ranked as (
  select
    test_session_id,
    model,
    prompt_version_id,
    score,
    rank() over (partition by test_session_id order by score desc nulls last) as rank
  from public.prompt_test_runs
  where test_session_id is not null
    and score is not null
),
sessions as (
  select test_session_id, count(*) as n
  from ranked
  where score is not null
  group by test_session_id
  having count(*) >= 2
)
select
  r.model,
  count(*) filter (where r.rank = 1)::integer as wins,
  count(*)::integer as appearances,
  round(100.0 * count(*) filter (where r.rank = 1) / nullif(count(*), 0), 1) as win_rate_pct,
  round(avg(r.score)::numeric, 2) as avg_score
from ranked r
join sessions s on s.test_session_id = r.test_session_id
group by r.model;

comment on view public.model_head_to_head is 'Model win rates in head-to-head matrix tests. A "win" means the model had the highest score in a session.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor.
-- ============================================================
