-- API Error Log — tracks all unhandled 500 errors from Vercel serverless functions
-- Includes error details, request context, and a Claude Code prompt for fixing

create table if not exists public.api_error_log (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null,
  action text,
  error_message text not null,
  error_stack text,
  request_body jsonb,
  request_meta jsonb,
  claude_prompt text,
  created_at timestamptz not null default now()
);

-- Index for querying recent errors by endpoint
create index if not exists idx_api_error_log_endpoint_created
  on public.api_error_log (endpoint, created_at desc);

-- Index for time-range queries (dashboard, cleanup)
create index if not exists idx_api_error_log_created
  on public.api_error_log (created_at desc);

-- RLS: service role only (API writes with service role key)
alter table public.api_error_log enable row level security;

create policy "Service role full access on api_error_log"
  on public.api_error_log
  for all
  using (true)
  with check (true);

-- View: error frequency by endpoint+action (last 24h, 7d, 30d)
create or replace view public.api_error_summary as
select
  endpoint,
  action,
  error_message,
  count(*) as total_count,
  count(*) filter (where created_at > now() - interval '24 hours') as last_24h,
  count(*) filter (where created_at > now() - interval '7 days') as last_7d,
  max(created_at) as last_seen,
  min(created_at) as first_seen
from public.api_error_log
group by endpoint, action, error_message
order by last_seen desc;
