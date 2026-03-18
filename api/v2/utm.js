import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

  // ── TRACK: Record a UTM visit (no auth required — called from landing pages) ──
  if (action === 'track' && req.method === 'POST') {
    const { utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingPage, sessionId } = req.body || {};

    if (!utmSource && !utmCampaign && !utmContent) {
      return res.status(400).json({ success: false, error: 'At least one UTM parameter required' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || '';
    const ua = req.headers['user-agent'] || '';

    const { data, error } = await supabase
      .from('utm_visits')
      .insert({
        utm_source: utmSource || null,
        utm_medium: utmMedium || null,
        utm_campaign: utmCampaign || null,
        utm_content: utmContent || null,
        utm_term: utmTerm || null,
        landing_page: landingPage || null,
        session_id: sessionId || null,
        ip_address: ip,
        user_agent: ua
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, visitId: data.id });
  }

  // ── CONVERT: Update conversion flags on a UTM visit (called server-side) ──
  if (action === 'convert' && req.method === 'POST') {
    const { sessionId, userId, eventId, conversionType } = req.body || {};

    if (!sessionId && !userId) {
      return res.status(400).json({ success: false, error: 'sessionId or userId required' });
    }
    if (!conversionType || !['signup', 'event', 'publish'].includes(conversionType)) {
      return res.status(400).json({ success: false, error: 'conversionType must be signup, event, or publish' });
    }

    // Find the UTM visit to update
    let query = supabase.from('utm_visits').select('id').order('created_at', { ascending: false }).limit(1);
    if (sessionId) query = query.eq('session_id', sessionId);
    if (userId) query = query.eq('user_id', userId);

    let { data: visit } = await query.maybeSingle();
    if (!visit) {
      // Try to find by session_id if we have userId but no direct match
      if (userId && sessionId) {
        const { data: sessionVisit } = await supabase
          .from('utm_visits')
          .select('id')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!sessionVisit) return res.status(200).json({ success: true, updated: false, reason: 'no_utm_visit' });
        visit = sessionVisit;
      } else {
        return res.status(200).json({ success: true, updated: false, reason: 'no_utm_visit' });
      }
    }

    const updates = {};
    if (conversionType === 'signup') {
      updates.converted_signup = true;
      updates.converted_signup_at = new Date().toISOString();
      if (userId) updates.user_id = userId;
    } else if (conversionType === 'event') {
      updates.converted_event = true;
      updates.converted_event_at = new Date().toISOString();
      if (eventId) updates.event_id = eventId;
    } else if (conversionType === 'publish') {
      updates.converted_publish = true;
      updates.converted_publish_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('utm_visits')
      .update(updates)
      .eq('id', visit.id);

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, updated: true, visitId: visit.id });
  }

  // ── LINK: Associate a user_id with their UTM visit by session_id ──
  if (action === 'link' && req.method === 'POST') {
    const { sessionId, userId } = req.body || {};
    if (!sessionId || !userId) {
      return res.status(400).json({ success: false, error: 'sessionId and userId required' });
    }

    const { data, error } = await supabase
      .from('utm_visits')
      .update({ user_id: userId })
      .eq('session_id', sessionId)
      .is('user_id', null)
      .select('id');

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, linked: (data || []).length });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
