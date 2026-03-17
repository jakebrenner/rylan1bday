import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// AI model pricing per 1M tokens — must match billing.js, generate-theme.js, chat.js, admin.js
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

// Max 1-star ratings per event that qualify for a credit-back
const MAX_ONE_STAR_CREDITS = 2;

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

      // Handle 1-star credit-back for the fallback insert path too
      if (Math.round(rating) === 1 && (raterType === 'host' || !raterType)) {
        const creditResult = await handleOneStarCredit(eventId, eventThemeId);
        const healResult = await triggerSyncSelfHeal(eventId, eventThemeId, rating, feedback);
        return res.status(200).json({ success: true, rating: inserted, ...creditResult, healResult });
      }
      if (Math.round(rating) <= 2 && (raterType === 'host' || !raterType)) {
        const healResult = await triggerSyncSelfHeal(eventId, eventThemeId, rating, feedback);
        return res.status(200).json({ success: true, rating: inserted, healResult });
      }
      return res.status(200).json({ success: true, rating: inserted });
    }

    // Handle 1-star credit-back: waive generation cost for up to MAX_ONE_STAR_CREDITS per event
    if (Math.round(rating) === 1 && (raterType === 'host' || !raterType)) {
      const creditResult = await handleOneStarCredit(eventId, eventThemeId);
      // Trigger synchronous self-heal for 1-2 star ratings
      const healResult = await triggerSyncSelfHeal(eventId, eventThemeId, rating, feedback);
      return res.status(200).json({ success: true, rating: data, ...creditResult, healResult });
    }

    // Trigger self-heal for 2-star ratings too (no credit-back, but still worth fixing)
    if (Math.round(rating) <= 2 && (raterType === 'host' || !raterType)) {
      const healResult = await triggerSyncSelfHeal(eventId, eventThemeId, rating, feedback);
      return res.status(200).json({ success: true, rating: data, healResult });
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

// ── SYNCHRONOUS SELF-HEAL TRIGGER ──
// Called inline during rating submission so the user can see the fix in real-time
async function triggerSyncSelfHeal(eventId, eventThemeId, rating, feedback) {
  try {
    // Check cooldown: max 1 heal attempt per theme per 24 hours
    const { count } = await supabase
      .from('self_heal_log')
      .select('id', { count: 'exact', head: true })
      .eq('original_theme_id', eventThemeId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (count > 0) return null; // cooldown active

    // Create heal log entry
    const { data: healLog } = await supabase
      .from('self_heal_log')
      .insert({
        event_id: eventId,
        original_theme_id: eventThemeId,
        trigger_type: 'low_rating',
        trigger_details: { rating, feedback: (feedback || '').substring(0, 500) },
        status: 'pending'
      })
      .select('id')
      .single();

    if (!healLog) return null;

    // Call self-heal synchronously
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://www.ryvite.com';

    const healRes = await fetch(`${baseUrl}/api/v2/self-heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        healLogId: healLog.id,
        eventThemeId,
        eventId,
        triggerType: 'low_rating',
        triggerDetails: { rating, feedback },
        feedback,
        sync: true
      })
    });

    const healData = await healRes.json();
    if (healData.success) {
      return {
        healed: true,
        newThemeId: healData.newThemeId,
        newHtml: healData.newHtml,
        newCss: healData.newCss,
        newConfig: healData.newConfig,
        diagnosis: healData.diagnosis,
        fixTier: healData.fixTier
      };
    }
    return { healed: false, reason: healData.reason || healData.status || 'fix_failed' };
  } catch (err) {
    console.error('[ratings] Self-heal trigger error:', err);
    return null;
  }
}

// ── 1-STAR CREDIT-BACK LOGIC ──
// When a host gives 1 star, we waive that generation's cost (up to MAX_ONE_STAR_CREDITS per event).
// After that, we suggest contacting support to prevent abuse.
async function handleOneStarCredit(eventId, eventThemeId) {
  try {
    // Count total 1-star host ratings for this event (including the one just submitted)
    const { count: oneStarCount } = await supabase
      .from('invite_ratings')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .eq('rating', 1)
      .eq('rater_type', 'host');

    if (oneStarCount > MAX_ONE_STAR_CREDITS) {
      return {
        oneStarCredit: false,
        oneStarCount,
        supportRequired: true
      };
    }

    // Check if we already issued a credit for this theme (prevent duplicates on re-rating)
    const creditReason = '1-star waiver: theme ' + eventThemeId;
    const { data: existingCredit } = await supabase
      .from('usage_credits')
      .select('id')
      .eq('source', 'one_star_waiver')
      .eq('reason', creditReason)
      .limit(1);
    if (existingCredit?.length > 0) {
      return { oneStarCredit: false, oneStarCount, reason: 'already_credited' };
    }

    // Look up the theme to get model + token usage for cost calculation
    const { data: theme } = await supabase
      .from('event_themes')
      .select('model, input_tokens, output_tokens, event_id')
      .eq('id', eventThemeId)
      .single();

    if (!theme) return { oneStarCredit: false, oneStarCount, reason: 'theme_not_found' };

    // Look up event owner
    const { data: event } = await supabase
      .from('events')
      .select('user_id')
      .eq('id', eventId)
      .single();

    if (!event?.user_id) return { oneStarCredit: false, oneStarCount, reason: 'no_event_owner' };

    // Calculate the generation cost with markup
    const pricing = AI_MODEL_PRICING[theme.model] || { input: 3.00, output: 15.00 };
    const rawCost = ((theme.input_tokens || 0) * pricing.input + (theme.output_tokens || 0) * pricing.output) / 1_000_000;

    // Get markup from user's active usage plan
    let markupPct = 50;
    const { data: usageSubs } = await supabase
      .from('subscriptions')
      .select('plans:plan_id (ai_markup_pct)')
      .eq('user_id', event.user_id)
      .eq('status', 'active')
      .limit(1);
    if (usageSubs?.length > 0 && usageSubs[0].plans?.ai_markup_pct) {
      markupPct = usageSubs[0].plans.ai_markup_pct;
    }

    const creditCents = Math.round(rawCost * (1 + markupPct / 100) * 100);
    if (creditCents <= 0) return { oneStarCredit: false, oneStarCount, reason: 'zero_cost' };

    // Issue a usage credit for the waived generation
    await supabase.from('usage_credits').insert({
      user_id: event.user_id,
      amount_cents: creditCents,
      remaining_cents: creditCents,
      reason: creditReason,
      source: 'one_star_waiver'
    });

    return {
      oneStarCredit: true,
      creditCents,
      oneStarCount
    };
  } catch (err) {
    console.error('1-star credit error:', err);
    return { oneStarCredit: false, reason: 'error' };
  }
}
