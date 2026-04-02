import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Resend Webhook Handler
 * Receives email events (delivered, opened, clicked, bounced, complained)
 * and updates notification_log with engagement data.
 *
 * Resend webhook payload:
 * { type: "email.delivered", created_at: "...", data: { email_id: "...", to: [...], ... } }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-id, svix-timestamp, svix-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify webhook signature if secret is configured
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];

    if (!svixId || !svixTimestamp || !svixSignature) {
      return res.status(401).json({ error: 'Missing webhook signature headers' });
    }

    // Timestamp validation: reject events older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(svixTimestamp, 10);
    if (Math.abs(now - ts) > 300) {
      return res.status(401).json({ error: 'Webhook timestamp too old' });
    }

    // HMAC signature verification
    try {
      const crypto = await import('crypto');
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const signedContent = `${svixId}.${svixTimestamp}.${body}`;
      // Resend uses base64-encoded secret prefixed with "whsec_"
      const secretBytes = Buffer.from(webhookSecret.replace('whsec_', ''), 'base64');
      const expectedSig = crypto.createHmac('sha256', secretBytes)
        .update(signedContent)
        .digest('base64');

      const signatures = svixSignature.split(' ').map(s => s.replace('v1,', ''));
      const valid = signatures.some(sig => {
        try {
          return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
        } catch { return false; }
      });

      if (!valid) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } catch (err) {
      console.error('Webhook signature verification error:', err);
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  try {
    const { type, data } = req.body;
    if (!type || !data) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const emailId = data.email_id;
    if (!emailId) {
      // Some events may not have email_id — acknowledge but skip
      return res.status(200).json({ received: true });
    }

    const now = new Date().toISOString();

    switch (type) {
      case 'email.delivered': {
        await supabase
          .from('notification_log')
          .update({ delivered_at: now, status: 'delivered' })
          .eq('provider_id', emailId)
          .is('delivered_at', null);
        break;
      }

      case 'email.opened': {
        // First open: set opened_at. Always increment open_count.
        const { data: existing } = await supabase
          .from('notification_log')
          .select('id, open_count')
          .eq('provider_id', emailId)
          .single();

        if (existing) {
          const updates = { open_count: (existing.open_count || 0) + 1 };
          if (!(existing.open_count > 0)) {
            updates.opened_at = now;
          }
          await supabase
            .from('notification_log')
            .update(updates)
            .eq('id', existing.id);
        }
        break;
      }

      case 'email.clicked': {
        const { data: existing } = await supabase
          .from('notification_log')
          .select('id, click_count')
          .eq('provider_id', emailId)
          .single();

        if (existing) {
          const updates = { click_count: (existing.click_count || 0) + 1 };
          if (!(existing.click_count > 0)) {
            updates.clicked_at = now;
          }
          await supabase
            .from('notification_log')
            .update(updates)
            .eq('id', existing.id);
        }
        break;
      }

      case 'email.bounced': {
        await supabase
          .from('notification_log')
          .update({
            bounced_at: now,
            status: 'bounced',
            bounce_type: 'hard',
            error: data.bounce?.message || 'Bounced'
          })
          .eq('provider_id', emailId);
        break;
      }

      case 'email.complained': {
        await supabase
          .from('notification_log')
          .update({
            bounced_at: now,
            status: 'bounced',
            bounce_type: 'complaint',
            error: 'Spam complaint'
          })
          .eq('provider_id', emailId);
        break;
      }

      case 'email.delivery_delayed': {
        // Just log, don't change status
        break;
      }

      default:
        // Unknown event type — acknowledge
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Email webhook error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
