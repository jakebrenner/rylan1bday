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

  // ── SUBMIT RATING (no auth required — hosts, guests, anonymous) ──
  if (action === 'submit' && req.method === 'POST') {
    const { eventId, eventThemeId, rating, feedback, raterType, guestId, fingerprint } = req.body;

    if (!eventId || !eventThemeId || !rating) {
      return res.status(400).json({ success: false, error: 'eventId, eventThemeId, and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'Rating must be 1-5' });
    }

    const insertData = {
      event_id: eventId,
      event_theme_id: eventThemeId,
      rating: Math.round(rating),
      feedback: (feedback || '').substring(0, 1000),
      rater_type: raterType || 'host',
      guest_id: guestId || null,
      fingerprint: fingerprint || null
    };

    // Upsert: if this rater already rated this theme, update their rating
    const { data, error } = await supabase
      .from('invite_ratings')
      .upsert(insertData, {
        onConflict: guestId ? 'event_theme_id,guest_id' : 'event_theme_id,fingerprint'
      })
      .select('id, rating, feedback')
      .single();

    if (error) {
      // Upsert conflict handling may fail — try plain insert
      const { data: inserted, error: insertErr } = await supabase
        .from('invite_ratings')
        .insert(insertData)
        .select('id, rating, feedback')
        .single();
      if (insertErr) return res.status(400).json({ success: false, error: insertErr.message });
      return res.status(200).json({ success: true, rating: inserted });
    }

    return res.status(200).json({ success: true, rating: data });
  }

  // ── GET RATING SUMMARY for a theme ──
  if (action === 'summary' && req.method === 'GET') {
    const eventThemeId = req.query.eventThemeId;
    if (!eventThemeId) return res.status(400).json({ success: false, error: 'eventThemeId required' });

    const { data, error } = await supabase
      .from('invite_ratings')
      .select('rating, feedback, rater_type, created_at')
      .eq('event_theme_id', eventThemeId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const ratings = data || [];
    const total = ratings.length;
    const avg = total > 0 ? Math.round(ratings.reduce((a, r) => a + r.rating, 0) / total * 100) / 100 : 0;

    return res.status(200).json({
      success: true,
      summary: {
        totalRatings: total,
        avgRating: avg,
        ratings
      }
    });
  }

  // ── GET HOST'S EXISTING RATING for a theme (check if already rated) ──
  if (action === 'check' && req.method === 'GET') {
    const { eventThemeId, fingerprint } = req.query;
    if (!eventThemeId) return res.status(400).json({ success: false, error: 'eventThemeId required' });

    let query = supabase
      .from('invite_ratings')
      .select('id, rating, feedback, rater_type')
      .eq('event_theme_id', eventThemeId)
      .eq('rater_type', 'host');

    if (fingerprint) {
      query = query.eq('fingerprint', fingerprint);
    }

    const { data, error } = await query.maybeSingle();
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, existingRating: data || null });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
