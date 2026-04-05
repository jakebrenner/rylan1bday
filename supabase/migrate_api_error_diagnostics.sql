-- Add diagnostics JSONB column to api_error_log
-- Stores endpoint-specific debugging data (raw response snippets, parser state,
-- model info, validation issues) so error alerts contain everything needed
-- to pinpoint and fix the root cause.

alter table public.api_error_log
  add column if not exists diagnostics jsonb;

comment on column public.api_error_log.diagnostics is
  'Endpoint-specific debugging data: raw response previews, parser state, model info, validation issues. Included in Claude Code fix prompts.';
