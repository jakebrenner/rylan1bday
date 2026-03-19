-- Add campaign_label column to ad_creatives for user-friendly notes
-- campaign_name is auto-generated for UTM consistency (e.g. ryvite_wedding_2026-03)
-- campaign_label is optional user text for their own reference
ALTER TABLE ad_creatives ADD COLUMN IF NOT EXISTS campaign_label TEXT;
