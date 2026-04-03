-- Client Error Log — tracks frontend JavaScript errors, unhandled rejections,
-- and failed API calls as experienced by end users.
-- Complements api_error_log (server-side) with client-side visibility.

CREATE TABLE IF NOT EXISTS public.client_error_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id),
  event_id    UUID REFERENCES public.events(id) ON DELETE SET NULL,
  error_type  TEXT NOT NULL,          -- 'js_error', 'unhandled_rejection', 'api_error', 'render_error'
  error_message TEXT NOT NULL,
  error_stack TEXT,
  page_url    TEXT,
  funnel_step TEXT,                   -- which creation step user was on (0-3)
  component   TEXT,                   -- 'chat', 'generation', 'publish', 'rsvp', etc.
  metadata    JSONB DEFAULT '{}',     -- browser, device, viewport, extra context
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying recent errors by type
CREATE INDEX IF NOT EXISTS idx_client_error_log_type_created
  ON public.client_error_log (error_type, created_at DESC);

-- Index for time-range queries (dashboard, cleanup)
CREATE INDEX IF NOT EXISTS idx_client_error_log_created
  ON public.client_error_log (created_at DESC);

-- Index for per-user error lookup
CREATE INDEX IF NOT EXISTS idx_client_error_log_user
  ON public.client_error_log (user_id) WHERE user_id IS NOT NULL;

-- Index for funnel step analysis (which steps cause most errors?)
CREATE INDEX IF NOT EXISTS idx_client_error_log_step
  ON public.client_error_log (funnel_step) WHERE funnel_step IS NOT NULL;

-- RLS: service role full access (API writes with service role key)
ALTER TABLE public.client_error_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on client_error_log"
  ON public.client_error_log
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- View: client error frequency by type/component (last 24h, 7d)
CREATE OR REPLACE VIEW public.client_error_summary AS
SELECT
  error_type,
  component,
  error_message,
  funnel_step,
  count(*) AS total_count,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d,
  count(DISTINCT user_id) AS unique_users,
  max(created_at) AS last_seen,
  min(created_at) AS first_seen
FROM public.client_error_log
GROUP BY error_type, component, error_message, funnel_step
ORDER BY last_seen DESC;

-- View: errors by funnel step (which steps have most errors?)
CREATE OR REPLACE VIEW public.client_errors_by_step AS
SELECT
  funnel_step,
  count(*) AS total_errors,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d,
  count(DISTINCT user_id) AS unique_users_affected,
  array_agg(DISTINCT error_type) AS error_types
FROM public.client_error_log
WHERE funnel_step IS NOT NULL
GROUP BY funnel_step
ORDER BY total_errors DESC;
