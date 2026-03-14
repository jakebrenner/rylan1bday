-- Migration: Pricing Model Update — $4.99 Flat Per-Event
-- Replaces complex two-tier pricing (per-event + pay-as-you-go) with simple $4.99/event model
-- Free tier: 1 event, 1 AI generation, email/link only (no SMS)
-- Paid tier: $4.99/event, unlimited AI (soft cap 10), SMS up to 1000/event

-- 1. Add payment columns to events
ALTER TABLE events ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
-- Add CHECK constraint separately (safe to re-run — drops and recreates if exists)
DO $$ BEGIN
  ALTER TABLE events DROP CONSTRAINT IF EXISTS events_payment_status_check;
  ALTER TABLE events ADD CONSTRAINT events_payment_status_check
    CHECK (payment_status IN ('unpaid', 'paid', 'free', 'refunded'));
END $$;
ALTER TABLE events ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS sms_limit integer DEFAULT 1000;
ALTER TABLE events ADD COLUMN IF NOT EXISTS sms_sent_count integer DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS free_generation_used boolean DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS free_redo_used boolean DEFAULT false;

-- Index for payment_status (used in WHERE filters across billing, events, SMS, and generation APIs)
CREATE INDEX IF NOT EXISTS idx_events_payment_status ON events(payment_status);

-- 2. Add global admin flag to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_global_admin boolean DEFAULT false;

-- Set Jake as global admin (by email — update with actual user ID if known)
UPDATE profiles SET is_global_admin = true
WHERE id IN (SELECT id FROM auth.users WHERE email = 'jakebrennan54@gmail.com');

-- 3. Create SMS approvals table
CREATE TABLE IF NOT EXISTS sms_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email text,
  event_title text,
  current_sms_sent integer DEFAULT 0,
  current_limit integer DEFAULT 1000,
  requested_count integer,
  guest_count integer,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  approved_limit integer,
  approved_at timestamptz,
  approved_by uuid,
  reason text
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_sms_approvals_event ON sms_approvals(event_id);
CREATE INDEX IF NOT EXISTS idx_sms_approvals_status ON sms_approvals(status);

-- 4. Deactivate old plans (safe: no-op if plans table doesn't exist yet)
DO $$ BEGIN
  UPDATE plans SET is_active = false WHERE name IN ('per_event', 'pay_as_you_go');
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'plans table does not exist yet — skipping deactivation';
END $$;

-- 5. Insert new $4.99 flat plan (safe: no-op if plans table doesn't exist yet)
DO $$ BEGIN
  INSERT INTO plans (name, display_name, description, price_cents, currency, billing_type, max_events, max_generations, features, is_active, sort_order)
  VALUES (
    'event_499',
    'Per Event',
    'AI-designed custom invitation with unlimited guests, SMS + email delivery, and RSVP tracking.',
    499,
    'usd',
    'fixed',
    1,
    999,
    '["Unlimited AI designs (soft cap 10)", "SMS delivery (up to 1,000)", "Email delivery unlimited", "Full RSVP tracking", "Guest management", "Custom RSVP fields", "Calendar links (ICS, Google, Outlook)"]',
    true,
    1
  )
  ON CONFLICT (name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    price_cents = EXCLUDED.price_cents,
    billing_type = EXCLUDED.billing_type,
    max_events = EXCLUDED.max_events,
    max_generations = EXCLUDED.max_generations,
    features = EXCLUDED.features,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'plans table does not exist yet — skipping plan insert';
END $$;

-- 6. Data migration for existing events — CRITICAL: protect existing users
-- Order matters: published events first, then subscriptions, then free tier
-- This is a one-time data migration — run manually and verify

-- 6a. GRANDFATHER: All already-published events are marked 'paid'
-- These events were created and published under the old pricing model.
-- Blocking them now would break existing users' live events.
UPDATE events SET payment_status = 'paid', paid_at = COALESCE(published_at, updated_at, created_at), sms_limit = 1000
WHERE status = 'published' AND payment_status = 'unpaid';

-- 6b. Mark events with an active subscription as paid (safe: no-op if subscriptions table doesn't exist)
DO $$ BEGIN
  UPDATE events e SET payment_status = 'paid', paid_at = s.created_at
  FROM subscriptions s
  WHERE s.user_id = e.user_id
    AND s.status = 'active'
    AND e.payment_status = 'unpaid';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'subscriptions table does not exist — skipping subscription-based migration';
END $$;

-- 6c. Mark the first event per user as free (if not already paid/published)
WITH first_events AS (
  SELECT DISTINCT ON (user_id) id
  FROM events
  WHERE payment_status = 'unpaid'
  ORDER BY user_id, created_at ASC
)
UPDATE events SET payment_status = 'free', sms_limit = 0
WHERE id IN (SELECT id FROM first_events);

-- 6d. Remaining unpaid events keep payment_status = 'unpaid', sms_limit = 1000
-- They will need payment ($4.99) before publishing or sending SMS
