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

  // ── GET FEATURED REVIEWS (public, cached) ──
  if (action === 'featured' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    const { data: reviews, error } = await supabase
      .from('reviews')
      .select(`
        id, rating, headline, body, reviewer_name, is_anonymous, event_type, created_at,
        event_themes!inner(html, css, config)
      `)
      .in('status', ['featured'])
      .order('created_at', { ascending: false })
      .limit(12);

    if (error) return res.status(500).json({ success: false, error: error.message });

    const formatted = (reviews || []).map(r => ({
      id: r.id,
      rating: r.rating,
      headline: r.headline,
      body: r.body,
      reviewerName: r.is_anonymous ? 'Anonymous' : r.reviewer_name,
      eventType: r.event_type,
      themeHtml: r.event_themes?.html || null,
      themeCss: r.event_themes?.css || null,
      themeConfig: r.event_themes?.config || null,
      createdAt: r.created_at
    }));

    return res.status(200).json({ success: true, reviews: formatted });
  }

  // ── GET REVIEW FORM DATA BY TOKEN ──
  if (action === 'get' && req.method === 'GET') {
    const token = req.query.token;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });

    const { data: request, error } = await supabase
      .from('review_requests')
      .select(`
        id, user_id, event_id, status,
        events!inner(id, title, event_type, event_date),
        profiles!inner(display_name, email)
      `)
      .eq('token', token)
      .single();

    if (error || !request) {
      return res.status(404).json({ success: false, error: 'Invalid or expired review link' });
    }

    if (request.status === 'completed') {
      return res.status(400).json({ success: false, error: 'Review already submitted', alreadyCompleted: true });
    }

    // Get active theme for this event
    const { data: theme } = await supabase
      .from('event_themes')
      .select('id, html, css, config')
      .eq('event_id', request.event_id)
      .eq('is_active', true)
      .single();

    return res.status(200).json({
      success: true,
      reviewData: {
        requestId: request.id,
        eventId: request.event_id,
        eventTitle: request.events.title,
        eventType: request.events.event_type,
        eventDate: request.events.event_date,
        reviewerName: request.profiles.display_name || '',
        reviewerEmail: request.profiles.email,
        themeId: theme?.id || null,
        themeHtml: theme?.html || null,
        themeCss: theme?.css || null,
        themeConfig: theme?.config || null
      }
    });
  }

  // ── SUBMIT REVIEW ──
  if (action === 'submit' && req.method === 'POST') {
    const { token, rating, headline, body, reviewerName, isAnonymous } = req.body;

    if (!token || !rating) {
      return res.status(400).json({ success: false, error: 'Token and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'Rating must be 1-5' });
    }

    // Validate token
    const { data: request, error: reqErr } = await supabase
      .from('review_requests')
      .select('id, user_id, event_id, status')
      .eq('token', token)
      .single();

    if (reqErr || !request) {
      return res.status(404).json({ success: false, error: 'Invalid review link' });
    }
    if (request.status === 'completed') {
      return res.status(400).json({ success: false, error: 'Review already submitted' });
    }

    // Get event info for denormalized fields
    const { data: event } = await supabase
      .from('events')
      .select('event_type')
      .eq('id', request.event_id)
      .single();

    // Get active theme ID
    const { data: theme } = await supabase
      .from('event_themes')
      .select('id')
      .eq('event_id', request.event_id)
      .eq('is_active', true)
      .single();

    // Insert review
    const { data: review, error: insertErr } = await supabase
      .from('reviews')
      .insert({
        user_id: request.user_id,
        event_id: request.event_id,
        event_theme_id: theme?.id || null,
        rating: Math.round(rating),
        headline: (headline || '').substring(0, 120) || null,
        body: (body || '').substring(0, 2000) || null,
        reviewer_name: (reviewerName || 'Anonymous').substring(0, 100),
        is_anonymous: !!isAnonymous,
        status: 'pending',
        event_type: event?.event_type || null
      })
      .select('id, rating, headline')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        return res.status(400).json({ success: false, error: 'You have already submitted a review for this event' });
      }
      return res.status(500).json({ success: false, error: insertErr.message });
    }

    // Mark request as completed
    await supabase
      .from('review_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', request.id);

    return res.status(200).json({ success: true, review });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
