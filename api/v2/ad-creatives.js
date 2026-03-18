import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: verify admin auth
async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (error || !user) return null;
  const { data: profile } = await supabase.from('profiles').select('is_global_admin').eq('id', user.id).single();
  if (!profile?.is_global_admin) return null;
  return user;
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
            inviteHtml, inviteCss, inviteConfig } = req.body || {};

    if (!sourceType || !sourceId || !format) {
      return res.status(400).json({ success: false, error: 'sourceType, sourceId, and format are required' });
    }

    const creativeId = generateCreativeId();
    // Auto-generate campaign name if not provided (legacy support)
    const campaign = campaignName || generateCampaignName(eventType);
    const utmUrl = `https://ryvite.com/v2/create/?utm_source=facebook&utm_medium=paid&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${creativeId}&utm_term=${encodeURIComponent(eventType || '')}`;

    const { data, error } = await supabase
      .from('ad_creatives')
      .insert({
        creative_id: creativeId,
        campaign_name: campaign,
        campaign_label: campaignLabel || null,
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
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, creative: data });
  }

  // ── LIST: Get all ad creatives with optional filters ──
  if (action === 'list' && req.method === 'GET') {
    const { campaign, format, eventType, page, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 50, 200);
    const offset = ((parseInt(page) || 1) - 1) * limit;

    let query = supabase
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
    // Try to use the view; fall back to basic data if view doesn't exist
    const { data: creativeStats, error: viewError } = await supabase
      .from('ad_creative_performance')
      .select('*')
      .order('created_at', { ascending: false });

    if (viewError) {
      // View may not exist yet — return basic creative data
      const { data: basics } = await supabase
        .from('ad_creatives')
        .select('*')
        .order('created_at', { ascending: false });
      return res.status(200).json({ success: true, creatives: basics || [], source: 'basic' });
    }

    // Also fetch campaign-level stats
    const { data: campaignStats } = await supabase
      .from('campaign_performance')
      .select('*');

    return res.status(200).json({
      success: true,
      creatives: creativeStats || [],
      campaigns: campaignStats || [],
      source: 'view'
    });
  }

  // ── CAMPAIGNS: List distinct campaign names ──
  if (action === 'campaigns' && req.method === 'GET') {
    const { data, error } = await supabase
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

    const { error } = await supabase
      .from('ad_creatives')
      .delete()
      .eq('creative_id', creativeId);

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
