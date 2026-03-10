-- ============================================================
-- Generation Insights — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Adds rich metadata to generation_log and events for analyzing:
--   - User location/geo patterns (which regions prefer which styles)
--   - Style library references used per generation
--   - Generations-to-publish (GTP) — key satisfaction metric
--   - Prompt version tracking per generation
-- ============================================================

-- ============================================================
-- 1. GENERATION_LOG — add metadata columns
-- ============================================================

alter table public.generation_log
  add column if not exists client_ip text default '',
  add column if not exists client_geo jsonb not null default '{}'::jsonb,
  add column if not exists style_library_ids text[] not null default '{}',
  add column if not exists prompt_version_id uuid references public.prompt_versions(id) on delete set null,
  add column if not exists event_type text default '',
  add column if not exists is_tweak boolean not null default false,
  add column if not exists user_agent text default '';

comment on column public.generation_log.client_ip is 'Client IP address from x-forwarded-for header.';
comment on column public.generation_log.client_geo is 'Geolocation data: {country, region, city, latitude, longitude} from Vercel geo headers.';
comment on column public.generation_log.style_library_ids is 'Which style library items were used as references for this generation.';
comment on column public.generation_log.prompt_version_id is 'Which prompt version was active for this generation.';
comment on column public.generation_log.event_type is 'Event type (kidsBirthday, wedding, etc.) for cross-event analysis.';
comment on column public.generation_log.is_tweak is 'Whether this was a tweak/refinement vs a fresh generation.';
comment on column public.generation_log.user_agent is 'Browser user-agent for device/platform analysis.';

-- Index for geo analysis
create index if not exists idx_gen_log_geo
  on public.generation_log using gin (client_geo);

-- Index for style reference analysis
create index if not exists idx_gen_log_styles
  on public.generation_log using gin (style_library_ids);

-- Index for prompt version analysis
create index if not exists idx_gen_log_prompt_version
  on public.generation_log (prompt_version_id) where prompt_version_id is not null;

-- Index for event type analysis
create index if not exists idx_gen_log_event_type
  on public.generation_log (event_type) where event_type != '';

-- ============================================================
-- 2. EVENTS — add generations-to-publish tracking
-- ============================================================

alter table public.events
  add column if not exists generations_to_publish integer,
  add column if not exists published_at timestamptz,
  add column if not exists first_generation_at timestamptz;

comment on column public.events.generations_to_publish is 'Number of theme generations before the event was published. Key satisfaction metric — lower = better UX.';
comment on column public.events.published_at is 'When the event was first published. Null if still draft.';
comment on column public.events.first_generation_at is 'When the first theme was generated for this event.';

-- ============================================================
-- 3. VIEWS — analytics dashboards
-- ============================================================

-- Generations-to-publish summary
create or replace view public.generation_satisfaction as
select
  e.event_type,
  count(*)::integer as total_published,
  round(avg(e.generations_to_publish)::numeric, 1) as avg_gtp,
  percentile_cont(0.5) within group (order by e.generations_to_publish) as median_gtp,
  min(e.generations_to_publish) as min_gtp,
  max(e.generations_to_publish) as max_gtp,
  count(*) filter (where e.generations_to_publish = 1)::integer as first_try_publishes,
  round(100.0 * count(*) filter (where e.generations_to_publish = 1) / nullif(count(*), 0), 1) as first_try_pct
from public.events e
where e.generations_to_publish is not null
group by e.event_type;

comment on view public.generation_satisfaction is 'Generations-to-publish (GTP) metrics by event type. Lower GTP = higher user satisfaction.';

-- Geographic generation patterns
create or replace view public.generation_geo_insights as
select
  client_geo->>'country' as country,
  client_geo->>'region' as region,
  client_geo->>'city' as city,
  event_type,
  count(*)::integer as total_generations,
  count(distinct user_id)::integer as unique_users,
  round(avg(latency_ms)::numeric, 0) as avg_latency_ms
from public.generation_log
where client_geo != '{}'::jsonb and status = 'success'
group by client_geo->>'country', client_geo->>'region', client_geo->>'city', event_type
having count(*) >= 2;

comment on view public.generation_geo_insights is 'Generation patterns by geographic region and event type. Use to understand regional style preferences.';

-- Model performance in production (not lab tests)
create or replace view public.production_model_performance as
select
  gl.model,
  gl.event_type,
  gl.prompt_version_id,
  pv.name as prompt_name,
  count(*)::integer as total_generations,
  count(distinct gl.user_id)::integer as unique_users,
  round(avg(gl.latency_ms)::numeric, 0) as avg_latency_ms,
  round(avg(gl.input_tokens + gl.output_tokens)::numeric, 0) as avg_total_tokens,
  count(*) filter (where gl.status = 'error')::integer as error_count,
  round(100.0 * count(*) filter (where gl.status = 'error') / nullif(count(*), 0), 1) as error_rate_pct
from public.generation_log gl
left join public.prompt_versions pv on pv.id = gl.prompt_version_id
where gl.model is not null
group by gl.model, gl.event_type, gl.prompt_version_id, pv.name;

comment on view public.production_model_performance is 'Real production generation performance by model, event type, and prompt version.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
