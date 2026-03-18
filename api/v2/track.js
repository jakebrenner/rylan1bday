import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_TYPES = ['page_view', 'footer_click', 'rsvp_cta_click'];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, eventId, metadata } = req.body || {};

  if (!type || !ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  try {
    await supabaseAdmin.from('viral_events').insert({
      event_type: type,
      event_id: eventId || null,
      metadata: {
        ...(metadata || {}),
        referrer: req.headers.referer || null,
        user_agent: req.headers['user-agent'] || null
      }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Track error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
