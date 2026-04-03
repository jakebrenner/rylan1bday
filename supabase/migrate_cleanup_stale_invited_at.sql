-- Cleanup: Clear stale invited_at on guests who were never actually sent an SMS/email
--
-- The old addGuests code set invited_at immediately when adding guests to an event,
-- even though no SMS or email was sent. This caused the "SMS sent" badge to show
-- incorrectly. This migration clears invited_at for any guest who has no corresponding
-- entry in the notification_log table (meaning no SMS/email was ever actually sent).
--
-- Safe to run multiple times (idempotent).

UPDATE guests
SET invited_at = NULL
WHERE invited_at IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT guest_id
    FROM notification_log
    WHERE guest_id IS NOT NULL
      AND channel IN ('sms', 'email')
  );
