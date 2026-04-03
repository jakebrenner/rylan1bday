-- SMS Delivery Metadata — adds carrier, country, and provider status tracking
-- to sms_messages for diagnosing delivery failures (e.g. carrier filtering of
-- unregistered 10DLC senders).

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS carrier text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_error text;

-- Index for carrier-level delivery analysis
CREATE INDEX IF NOT EXISTS idx_sms_messages_carrier
  ON public.sms_messages (carrier) WHERE carrier IS NOT NULL;

-- Index for provider status analysis
CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_status
  ON public.sms_messages (provider_status) WHERE provider_status IS NOT NULL;

-- View: SMS delivery rates by carrier and status
CREATE OR REPLACE VIEW public.sms_delivery_by_carrier AS
SELECT
  carrier,
  country,
  count(*) AS total_sent,
  count(*) FILTER (WHERE status = 'delivered') AS delivered,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) FILTER (WHERE status = 'bounced') AS bounced,
  count(*) FILTER (WHERE status = 'sent' OR status = 'queued') AS pending,
  ROUND(100.0 * count(*) FILTER (WHERE status = 'delivered') / NULLIF(count(*), 0), 1) AS delivery_rate_pct,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d
FROM public.sms_messages
WHERE carrier IS NOT NULL
GROUP BY carrier, country
ORDER BY total_sent DESC;

-- View: SMS delivery summary with provider error breakdown
CREATE OR REPLACE VIEW public.sms_delivery_summary AS
SELECT
  status,
  provider_status,
  provider_error,
  count(*) AS total_count,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d,
  max(created_at) AS last_seen
FROM public.sms_messages
GROUP BY status, provider_status, provider_error
ORDER BY total_count DESC;
