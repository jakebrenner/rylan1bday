import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * ClickSend delivery receipt webhook handler.
 *
 * ClickSend sends delivery receipts as POST requests when a message
 * is delivered, fails, or bounces. This updates our tracking tables.
 *
 * ClickSend receipt payload fields:
 * - message_id: The ClickSend message ID (matches our provider_id)
 * - status: Delivery status (Delivered, Undelivered, etc.)
 * - status_code: Numeric status code
 * - custom_string: Any custom string we attached
 * - timestamp_send: When the message was sent
 * - timestamp: When the receipt was generated
 */

// Map ClickSend status to our internal status
function mapClickSendStatus(csStatus) {
  const statusLower = (csStatus || '').toLowerCase();
  if (statusLower === 'delivered' || statusLower === 'success') return 'delivered';
  if (statusLower === 'undelivered' || statusLower === 'soft-bounce') return 'failed';
  if (statusLower === 'hard-bounce') return 'bounced';
  return 'failed';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    // ClickSend may send a single receipt or an array
    const receipts = Array.isArray(req.body) ? req.body : [req.body];

    let updated = 0;

    for (const receipt of receipts) {
      const providerId = receipt.message_id;
      if (!providerId) continue;

      const newStatus = mapClickSendStatus(receipt.status);

      // Update sms_messages
      const { data: smsUpdate } = await supabaseAdmin
        .from('sms_messages')
        .update({ status: newStatus })
        .eq('provider_id', providerId)
        .select('id')
        .single();

      // Update notification_log
      await supabaseAdmin
        .from('notification_log')
        .update({
          status: newStatus,
          error: newStatus !== 'delivered' ? (receipt.status || null) : null
        })
        .eq('provider_id', providerId);

      if (smsUpdate) updated++;
    }

    return res.status(200).json({ success: true, updated });
  } catch (err) {
    console.error('SMS webhook error:', err);
    return res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
}
