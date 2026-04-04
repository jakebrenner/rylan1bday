import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Founder — always has admin access
const FOUNDER_EMAIL = 'jake@getmrkt.com';

// Helper: verify admin auth (matches admin.js pattern)
async function verifyAdmin(req) {
  // Skip auth on Vercel preview deployments
  if (process.env.VERCEL_ENV === 'preview') {
    return { id: 'preview', email: 'preview-admin@localhost' };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const email = (user.email || '').toLowerCase();

  // Founder always passes
  if (email === FOUNDER_EMAIL) return user;

  // Check DB admin list
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();

  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return user;
  }

  return null;
}

// Generate a short unique creative ID
function generateCreativeId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'fb-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Auto-generate a consistent campaign name from event type + current month
function generateCampaignName(eventType) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const type = eventType || 'general';
  return `ryvite_${type}_${year}-${month}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

  // All actions require admin auth
  const user = await verifyAdmin(req);
  if (!user) return res.status(401).json({ success: false, error: 'Admin access required' });

  // ── CREATE: Register a new ad creative with auto-generated UTM link ──
  if (action === 'create' && req.method === 'POST') {
    const { campaignName, campaignLabel, sourceType, sourceId, eventType, format, videoTheme, promptText,
            destinationUrl, inviteHtml, inviteCss, inviteConfig } = req.body || {};

    if (!sourceType || !sourceId || !format) {
      return res.status(400).json({ success: false, error: 'sourceType, sourceId, and format are required' });
    }

    const creativeId = generateCreativeId();
    // Auto-generate campaign name if not provided (legacy support)
    const campaign = campaignName || generateCampaignName(eventType);
    // Use provided destination URL or default to landing page
    const baseUrl = destinationUrl || 'https://ryvite.com/lp/';
    const separator = baseUrl.includes('?') ? '&' : '?';
    // utm_content = creativeId (e.g. 'fb-abc123') for attribution — must match ad_creatives.creative_id
    const utmUrl = `${baseUrl}${separator}utm_source=facebook&utm_medium=paid&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(creativeId)}&utm_term=${encodeURIComponent(eventType || '')}`;

    const row = {
      creative_id: creativeId,
      campaign_name: campaign,
      source_type: sourceType,
      source_id: sourceId,
      event_type: eventType || null,
      format,
      video_theme: videoTheme || 'dark_gradient',
      prompt_text: promptText || null,
      utm_url: utmUrl,
      invite_html: inviteHtml || null,
      invite_css: inviteCss || null,
      invite_config: inviteConfig || null,
      created_by: user.id
    };
    if (campaignLabel) row.campaign_label = campaignLabel;

    let { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .insert(row)
      .select()
      .single();

    // If campaign_label column doesn't exist yet, retry without it
    if (error && error.message && error.message.includes('campaign_label')) {
      delete row.campaign_label;
      ({ data, error } = await supabaseAdmin
        .from('ad_creatives')
        .insert(row)
        .select()
        .single());
    }

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, creative: data });
  }

  // ── LIST: Get all ad creatives with optional filters ──
  if (action === 'list' && req.method === 'GET') {
    const { campaign, format, eventType, page, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 50, 200);
    const offset = ((parseInt(page) || 1) - 1) * limit;

    let query = supabaseAdmin
      .from('ad_creatives')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (campaign) query = query.eq('campaign_name', campaign);
    if (format) query = query.eq('format', format);
    if (eventType) query = query.eq('event_type', eventType);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, creatives: data || [], total: count || 0 });
  }

  // ── STATS: Get performance stats (uses the ad_creative_performance view) ──
  if (action === 'stats' && req.method === 'GET') {
    const { since, until } = req.query;
    const hasDateFilter = since || until;

    // Try to use the view; fall back to basic data if view doesn't exist
    const { data: creativeStats, error: viewError } = await supabaseAdmin
      .from('ad_creative_performance')
      .select('*')
      .order('created_at', { ascending: false });

    if (viewError) {
      // View may not exist yet — return basic creative data
      const { data: basics } = await supabaseAdmin
        .from('ad_creatives')
        .select('*')
        .order('created_at', { ascending: false });
      return res.status(200).json({ success: true, creatives: basics || [], source: 'basic' });
    }

    let campaignStats;
    if (hasDateFilter) {
      // Date-filtered: aggregate from fb_ad_metrics directly
      let metricsQuery = supabaseAdmin
        .from('fb_ad_metrics')
        .select('fb_campaign_name, fb_campaign_id, creative_id, impressions, clicks, spend_cents');
      if (since) metricsQuery = metricsQuery.gte('date', since);
      if (until) metricsQuery = metricsQuery.lte('date', until);

      const { data: metrics } = await metricsQuery;
      // Aggregate by campaign
      const campMap = {};
      for (const m of (metrics || [])) {
        if (!m.fb_campaign_name) continue;
        if (!campMap[m.fb_campaign_name]) {
          campMap[m.fb_campaign_name] = {
            campaign_name: m.fb_campaign_name,
            fb_campaign_id: m.fb_campaign_id,
            creative_count: 0,
            total_impressions: 0,
            total_clicks: 0,
            total_spend_cents: 0,
            total_visits: 0,
            total_signups: 0,
            total_events: 0,
            total_publishes: 0,
            avg_signup_rate: 0,
            avg_cost_per_signup: null,
            avg_cost_per_publish: null,
            source: 'fb_only',
            _creativeIds: new Set()
          };
        }
        const c = campMap[m.fb_campaign_name];
        c.total_impressions += m.impressions || 0;
        c.total_clicks += m.clicks || 0;
        c.total_spend_cents += m.spend_cents || 0;
        if (m.creative_id) {
          c._creativeIds.add(m.creative_id);
          c.source = 'ryvite';
        }
      }

      // Get conversion data from utm_visits for campaigns in range
      const campNames = Object.keys(campMap);
      if (campNames.length > 0) {
        let uvQuery = supabaseAdmin
          .from('utm_visits')
          .select('utm_campaign, converted_signup, converted_event, converted_publish');
        if (since) uvQuery = uvQuery.gte('created_at', since + 'T00:00:00Z');
        if (until) uvQuery = uvQuery.lte('created_at', until + 'T23:59:59Z');
        uvQuery = uvQuery.in('utm_campaign', campNames);

        const { data: visits } = await uvQuery;
        for (const v of (visits || [])) {
          const c = campMap[v.utm_campaign];
          if (!c) continue;
          c.total_visits++;
          if (v.converted_signup) c.total_signups++;
          if (v.converted_event) c.total_events++;
          if (v.converted_publish) c.total_publishes++;
        }
      }

      // Finalize calculated fields
      campaignStats = Object.values(campMap).map(c => {
        c.creative_count = c._creativeIds.size;
        delete c._creativeIds;
        c.avg_signup_rate = c.total_clicks > 0
          ? Math.round(c.total_signups / c.total_clicks * 10000) / 100 : 0;
        c.avg_cost_per_signup = c.total_signups > 0
          ? Math.round(c.total_spend_cents / c.total_signups) / 100 : null;
        c.avg_cost_per_publish = c.total_publishes > 0
          ? Math.round(c.total_spend_cents / c.total_publishes) / 100 : null;
        return c;
      });
    } else {
      // No date filter: use the view
      const { data } = await supabaseAdmin
        .from('all_campaign_performance')
        .select('*');
      campaignStats = data;
    }

    return res.status(200).json({
      success: true,
      creatives: creativeStats || [],
      campaigns: campaignStats || [],
      source: 'view'
    });
  }

  // ── CAMPAIGNS: List distinct campaign names ──
  if (action === 'campaigns' && req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .select('campaign_name')
      .order('campaign_name');

    if (error) return res.status(500).json({ success: false, error: error.message });

    const unique = [...new Set((data || []).map(d => d.campaign_name))];
    return res.status(200).json({ success: true, campaigns: unique });
  }

  // ── DELETE: Remove an ad creative ──
  if (action === 'delete' && req.method === 'POST') {
    const { creativeId } = req.body || {};
    if (!creativeId) return res.status(400).json({ success: false, error: 'creativeId required' });

    const { error } = await supabaseAdmin
      .from('ad_creatives')
      .delete()
      .eq('creative_id', creativeId);

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true });
  }

  // ── GENERATE AI PROMPT TEXT for ad video typing animation ──
  if (action === 'generatePrompt' && req.method === 'POST') {
    const { html, eventTitle, eventType, config } = req.body || {};

    // Extract text content from HTML to understand the invite
    const textContent = (html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

    const etLabel = eventType || 'event';
    const mood = config?.mood || '';
    const colors = [config?.primaryColor, config?.secondaryColor].filter(Boolean).join(', ');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `You write ultra-concise ad copy for Ryvite, an AI invitation platform. Generate a short, punchy prompt text (10-20 words max) that would look great as a "typing animation" in a Facebook/Instagram ad video showcasing this invite design.

The text should feel like a real user typing a request to create this invite — casual, specific, and exciting. NOT generic. Reference the actual event details.

Event: ${eventTitle || 'Unknown'}
Type: ${etLabel}
Mood: ${mood}
Invite text: ${textContent.slice(0, 300)}

Reply with ONLY the prompt text, nothing else. No quotes.`
        }]
      });
      const promptText = msg.content[0]?.text?.trim() || '';
      return res.status(200).json({ success: true, promptText });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'AI generation failed: ' + err.message });
    }
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
