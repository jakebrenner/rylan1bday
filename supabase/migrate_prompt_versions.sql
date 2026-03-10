-- ============================================================
-- Prompt Version Control — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Stores versioned creative prompts + Design DNA for invite generation.
-- The system prompt is split into two layers:
--   1. STRUCTURAL RULES (hardcoded in code — never editable, ensures platform compatibility)
--   2. CREATIVE DIRECTION (stored here — the editable creative layer)
-- At generation time: final prompt = STRUCTURAL_RULES + creative_direction
-- ============================================================

-- ============================================================
-- 1. PROMPT_VERSIONS — versioned creative direction + design DNA
-- ============================================================

create table if not exists public.prompt_versions (
  id                  uuid primary key default gen_random_uuid(),
  version             integer not null,
  name                text not null,                    -- human label e.g. "v12 – better SVG illustrations"
  description         text not null default '',         -- what changed in this version
  creative_direction  text not null,                    -- the editable creative layer (merged with hardcoded structural rules at runtime)
  design_dna          jsonb not null default '{}'::jsonb, -- per-event-type guidance (14 event types)
  is_active           boolean not null default false,   -- exactly one row should be active (used in production)
  created_by          text not null default '',         -- admin email who created it
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Ensure only one active prompt version at a time
create unique index if not exists idx_one_active_prompt_version
  on public.prompt_versions (is_active) where is_active = true;

create index if not exists idx_prompt_versions_version
  on public.prompt_versions (version desc);

comment on table public.prompt_versions is 'Versioned system prompts for invite generation. One active version drives production.';

-- Apply updated_at trigger
create trigger prompt_versions_updated_at
  before update on public.prompt_versions
  for each row execute function public.update_updated_at();

-- RLS: Only service role (admin API) can read/write
alter table public.prompt_versions enable row level security;

create policy "Service role full access to prompt_versions"
  on public.prompt_versions for all
  using (true)
  with check (true);

-- ============================================================
-- 2. PROMPT_TEST_RUNS — optional: track lab test results
-- ============================================================

create table if not exists public.prompt_test_runs (
  id                uuid primary key default gen_random_uuid(),
  prompt_version_id uuid references public.prompt_versions(id) on delete set null,
  model             text not null,
  event_type        text not null default 'other',
  event_details     jsonb not null default '{}'::jsonb,
  result_html       text,
  result_css        text,
  result_config     jsonb,
  input_tokens      integer default 0,
  output_tokens     integer default 0,
  latency_ms        integer default 0,
  score             integer,                       -- optional 1-5 quality rating from admin
  notes             text,                          -- admin notes on this test
  created_by        text not null default '',
  created_at        timestamptz not null default now()
);

create index if not exists idx_prompt_test_runs_version
  on public.prompt_test_runs (prompt_version_id);

comment on table public.prompt_test_runs is 'Lab test results for comparing prompt versions across models and event types.';

alter table public.prompt_test_runs enable row level security;

create policy "Service role full access to prompt_test_runs"
  on public.prompt_test_runs for all
  using (true)
  with check (true);

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
