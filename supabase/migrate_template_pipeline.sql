-- Template Import Pipeline Migration
-- Adds pipeline support columns to style_library and creates template_import_log audit table.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Add pipeline columns to style_library
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.style_library
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending_review', 'approved', 'rejected'));

ALTER TABLE public.style_library
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'pipeline', 'admin'));

ALTER TABLE public.style_library
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;

ALTER TABLE public.style_library
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.style_library.status IS 'Review status: pending_review (pipeline imports), approved (visible to generation), rejected';
COMMENT ON COLUMN public.style_library.source IS 'Origin: manual (admin upload), pipeline (automated import), admin (admin panel)';
COMMENT ON COLUMN public.style_library.imported_at IS 'Timestamp when imported via pipeline (NULL for manual uploads)';
COMMENT ON COLUMN public.style_library.metadata IS 'Pipeline provenance: mood, colors, fonts, generation params, etc.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Indexes on style_library
-- ══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_style_library_status
  ON public.style_library (status);

-- Partial index for the admin review queue
CREATE INDEX IF NOT EXISTS idx_style_library_pending
  ON public.style_library (imported_at DESC)
  WHERE status = 'pending_review';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. template_import_log table
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.template_import_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id        TEXT,
  template_name   TEXT,
  event_type      TEXT,
  status          TEXT NOT NULL DEFAULT 'success'
                    CHECK (status IN ('success', 'validation_failed', 'insert_failed')),
  validation_errors JSONB,
  style_library_id TEXT REFERENCES public.style_library(id) ON DELETE SET NULL,
  source          TEXT NOT NULL DEFAULT 'pipeline'
);

COMMENT ON TABLE public.template_import_log IS 'Audit trail for template pipeline imports — tracks success, validation failures, and insert errors';

ALTER TABLE public.template_import_log ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. Indexes on template_import_log
-- ══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_import_log_batch
  ON public.template_import_log (batch_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_import_log_created
  ON public.template_import_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_log_style
  ON public.template_import_log (style_library_id)
  WHERE style_library_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. Views
-- ══════════════════════════════════════════════════════════════════════════════

-- Daily import stats grouped by event_type and outcome
CREATE OR REPLACE VIEW public.pipeline_import_stats AS
SELECT
  date_trunc('day', created_at)::date AS import_date,
  event_type,
  status,
  count(*)::int AS total
FROM public.template_import_log
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

-- Admin review queue: pending pipeline templates
CREATE OR REPLACE VIEW public.pending_template_review AS
SELECT
  id,
  name,
  event_types,
  tags,
  admin_rating,
  metadata,
  imported_at,
  created_at,
  char_length(html) AS html_length
FROM public.style_library
WHERE status = 'pending_review'
ORDER BY imported_at DESC NULLS LAST;
