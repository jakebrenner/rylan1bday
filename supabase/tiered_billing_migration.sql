-- Tiered Billing Migration
-- Adds support for dynamic billing thresholds based on payment history,
-- usage credits from coupons, and monthly sweep tracking.

-- 1. Add billing_threshold_cents to profiles (dynamic per-user threshold)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS billing_threshold_cents integer DEFAULT 500;

-- 2. Usage credits table — tracks coupon/promo credits that offset usage charges
CREATE TABLE IF NOT EXISTS usage_credits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  amount_cents integer NOT NULL,
  remaining_cents integer NOT NULL,
  source text NOT NULL DEFAULT 'coupon', -- 'coupon', 'promo', 'refund', 'admin'
  coupon_id uuid REFERENCES coupons(id),
  description text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_credits_user ON usage_credits(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_credits_remaining ON usage_credits(user_id, remaining_cents) WHERE remaining_cents > 0;

-- 3. Add successful_charges_count to profiles for tier calculation
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS successful_charges_count integer DEFAULT 0;

-- 4. Add last_monthly_sweep_at to profiles to track sweep timing
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_monthly_sweep_at timestamptz;

-- 5. RPC to increment successful charge count and recalculate threshold
CREATE OR REPLACE FUNCTION increment_successful_charges(p_user_id uuid)
RETURNS integer AS $$
DECLARE
  new_count integer;
  new_threshold integer;
BEGIN
  UPDATE profiles
  SET successful_charges_count = COALESCE(successful_charges_count, 0) + 1
  WHERE id = p_user_id
  RETURNING successful_charges_count INTO new_count;

  -- Tiered threshold: 0 charges = $5, 1-2 = $15, 3+ = $25
  IF new_count >= 3 THEN
    new_threshold := 2500;
  ELSIF new_count >= 1 THEN
    new_threshold := 1500;
  ELSE
    new_threshold := 500;
  END IF;

  UPDATE profiles
  SET billing_threshold_cents = new_threshold
  WHERE id = p_user_id;

  RETURN new_threshold;
END;
$$ LANGUAGE plpgsql;

-- 6. RPC to apply usage credits (deducts from oldest non-expired credits first)
CREATE OR REPLACE FUNCTION apply_usage_credits(p_user_id uuid, p_amount_cents integer)
RETURNS integer AS $$
DECLARE
  credit_row RECORD;
  remaining_to_deduct integer;
  deducted integer;
BEGIN
  remaining_to_deduct := p_amount_cents;

  FOR credit_row IN
    SELECT id, remaining_cents
    FROM usage_credits
    WHERE user_id = p_user_id
      AND remaining_cents > 0
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at ASC
  LOOP
    IF remaining_to_deduct <= 0 THEN
      EXIT;
    END IF;

    IF credit_row.remaining_cents >= remaining_to_deduct THEN
      deducted := remaining_to_deduct;
    ELSE
      deducted := credit_row.remaining_cents;
    END IF;

    UPDATE usage_credits
    SET remaining_cents = remaining_cents - deducted
    WHERE id = credit_row.id;

    remaining_to_deduct := remaining_to_deduct - deducted;
  END LOOP;

  -- Return total credits applied
  RETURN GREATEST(0, p_amount_cents - remaining_to_deduct);
END;
$$ LANGUAGE plpgsql;

-- Note: apply_usage_credits returns the total credits applied.
-- The caller should charge: original_amount - credits_applied

-- Enable RLS
ALTER TABLE usage_credits ENABLE ROW LEVEL SECURITY;

-- Users can read their own credits
CREATE POLICY "Users read own credits" ON usage_credits
  FOR SELECT USING (auth.uid() = user_id);
