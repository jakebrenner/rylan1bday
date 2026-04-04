-- Prompt Activation History
-- Tracks every prompt version activation for audit trail, rollback, and performance analysis.
-- Run in Supabase SQL editor.

-- 1. Add activated_at and activated_by to prompt_versions for quick lookups
ALTER TABLE public.prompt_versions
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_by TEXT DEFAULT '';

-- Backfill: set activated_at/activated_by for the currently active version
UPDATE public.prompt_versions
SET activated_at = COALESCE(updated_at, created_at),
    activated_by = COALESCE(created_by, '')
WHERE is_active = true AND activated_at IS NULL;

-- 2. Create activation history table
CREATE TABLE IF NOT EXISTS public.prompt_activation_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_version_id     UUID NOT NULL REFERENCES public.prompt_versions(id) ON DELETE CASCADE,
  activated_by          TEXT NOT NULL DEFAULT '',
  deactivated_version_id UUID REFERENCES public.prompt_versions(id) ON DELETE SET NULL,
  notes                 TEXT DEFAULT '',
  activated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for timeline queries
CREATE INDEX IF NOT EXISTS idx_activation_history_time
  ON public.prompt_activation_history (activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_activation_history_version
  ON public.prompt_activation_history (prompt_version_id);

-- RLS: service role full access (matches existing prompt_versions pattern)
ALTER TABLE public.prompt_activation_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on prompt_activation_history"
  ON public.prompt_activation_history
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 3. Seed initial history row from the currently active version
INSERT INTO public.prompt_activation_history (prompt_version_id, activated_by, activated_at)
SELECT id, COALESCE(created_by, ''), COALESCE(activated_at, updated_at, created_at)
FROM public.prompt_versions
WHERE is_active = true
ON CONFLICT DO NOTHING;
