import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FB_GRAPH_URL = 'https://graph.facebook.com/v19.0';

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

// Get FB credentials from app_config
async function getFbConfig() {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'fb_ads_config')
    .single();
  return data?.value || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

  const user = await verifyAdmin(req);
  if (!user) return res.status(401).json({ success: false, error: 'Admin access required' });

  // ── SAVE CONFIG: Store FB Ad Account ID + Access Token ──
  if (action === 'saveConfig' && req.method === 'POST') {
    const { adAccountId, accessToken } = req.body || {};
    if (!adAccountId || !accessToken) {
      return res.status(400).json({ success: false, error: 'adAccountId and accessToken required' });
    }

    const { error } = await supabase
      .from('app_config')
      .upsert({
        key: 'fb_ads_config',
        value: { adAccountId, accessToken, updatedAt: new Date().toISOString() }
      }, { onConflict: 'key' });

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true });
  }

  // ── GET CONFIG: Retrieve FB settings (masked token) ──
  if (action === 'getConfig' && req.method === 'GET') {
    const config = await getFbConfig();
    if (!config) return res.status(200).json({ success: true, config: null });

    return res.status(200).json({
      success: true,
      config: {
        adAccountId: config.adAccountId,
        accessToken: config.accessToken ? '****' + config.accessToken.slice(-6) : null,
        updatedAt: config.updatedAt
      }
    });
  }

  // ── TEST CONNECTION: Verify FB API credentials ──
  if (action === 'testConnection' && req.method === 'POST') {
    const config = await getFbConfig();
    if (!config?.adAccountId || !config?.accessToken) {
      return res.status(400).json({ success: false, error: 'Facebook Ads not configured' });
    }

    try {
      const url = `${FB_GRAPH_URL}/act_${config.adAccountId}?fields=name,account_status&access_token=${config.accessToken}`;
      const fbRes = await fetch(url);
      const data = await fbRes.json();

      if (data.error) {
        return res.status(400).json({ success: false, error: data.error.message });
      }

      return res.status(200).json({
        success: true,
        account: { name: data.name, status: data.account_status }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to connect: ' + err.message });
    }
  }

  // ── SYNC: Pull ad metrics from Facebook Marketing API ──
  if (action === 'sync' && req.method === 'POST') {
    const config = await getFbConfig();
    if (!config?.adAccountId || !config?.accessToken) {
      return res.status(400).json({ success: false, error: 'Facebook Ads not configured' });
    }

    const { since, until } = req.body || {};
    const sinceDate = since || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const untilDate = until || new Date().toISOString().split('T')[0];

    try {
      // Fetch ad-level insights
      const insightsUrl = `${FB_GRAPH_URL}/act_${config.adAccountId}/insights`
        + `?fields=ad_id,ad_name,campaign_id,campaign_name,adset_id,impressions,clicks,spend,cpc,ctr,reach,frequency,actions`
        + `&level=ad`
        + `&time_range=${encodeURIComponent(JSON.stringify({ since: sinceDate, until: untilDate }))}`
        + `&time_increment=1`
        + `&limit=500`
        + `&access_token=${config.accessToken}`;

      const fbRes = await fetch(insightsUrl);
      const fbData = await fbRes.json();

      if (fbData.error) {
        return res.status(400).json({ success: false, error: fbData.error.message });
      }

      const insights = fbData.data || [];
      let synced = 0;
      let matched = 0;

      // Get all our creative IDs for matching
      const { data: ourCreatives } = await supabase
        .from('ad_creatives')
        .select('creative_id');
      const creativeIds = new Set((ourCreatives || []).map(c => c.creative_id));

      // Also fetch ad creative URLs to match utm_content
      for (const insight of insights) {
        // Try to match by fetching the ad's tracking URL
        let matchedCreativeId = null;

        // Fetch ad details to find UTM params in the URL
        try {
          const adUrl = `${FB_GRAPH_URL}/${insight.ad_id}?fields=tracking_specs,creative{url_tags}&access_token=${config.accessToken}`;
          const adRes = await fetch(adUrl);
          const adData = await adRes.json();

          // Parse utm_content from url_tags or creative URL
          const urlTags = adData?.creative?.url_tags || '';
          const utmMatch = urlTags.match(/utm_content=([^&]+)/);
          if (utmMatch && creativeIds.has(utmMatch[1])) {
            matchedCreativeId = utmMatch[1];
          }
        } catch (e) {
          // Skip URL matching for this ad
        }

        const row = {
          creative_id: matchedCreativeId,
          fb_campaign_id: insight.campaign_id || null,
          fb_campaign_name: insight.campaign_name || null,
          fb_adset_id: insight.adset_id || null,
          fb_ad_id: insight.ad_id,
          fb_ad_name: insight.ad_name || null,
          date: insight.date_start,
          impressions: parseInt(insight.impressions) || 0,
          clicks: parseInt(insight.clicks) || 0,
          spend_cents: Math.round(parseFloat(insight.spend || 0) * 100),
          cpc_cents: Math.round(parseFloat(insight.cpc || 0) * 100),
          ctr: parseFloat(insight.ctr || 0),
          reach: parseInt(insight.reach) || 0,
          frequency: parseFloat(insight.frequency || 0),
          actions: insight.actions || null,
          synced_at: new Date().toISOString()
        };

        const { error: upsertErr } = await supabase
          .from('fb_ad_metrics')
          .upsert(row, { onConflict: 'fb_ad_id,date' });

        if (!upsertErr) synced++;
        if (matchedCreativeId) matched++;
      }

      return res.status(200).json({
        success: true,
        synced,
        matched,
        total: insights.length,
        dateRange: { since: sinceDate, until: untilDate }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Sync failed: ' + err.message });
    }
  }

  // ── METRICS: Get FB metrics for a specific creative or all ──
  if (action === 'metrics' && req.method === 'GET') {
    const { creativeId, since, until } = req.query;

    let query = supabase
      .from('fb_ad_metrics')
      .select('*')
      .order('date', { ascending: false });

    if (creativeId) query = query.eq('creative_id', creativeId);
    if (since) query = query.gte('date', since);
    if (until) query = query.lte('date', until);

    const { data, error } = await query.limit(500);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, metrics: data || [] });
  }

  // ── SUGGESTIONS: AI-powered ad recommendations based on performance data ──
  if (action === 'suggestions' && req.method === 'POST') {
    try {
      // Gather performance data
      const { data: perfData } = await supabase
        .from('ad_creative_performance')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      const { data: campaignData } = await supabase
        .from('campaign_performance')
        .select('*');

      if (!perfData?.length) {
        return res.status(200).json({
          success: true,
          suggestions: [{
            suggestion_type: 'general',
            title: 'Start generating ad creatives',
            description: 'Generate your first ad creatives from the Generations tab to begin collecting performance data. Once you have data, AI will analyze it and provide optimization recommendations.',
            confidence: 1.0
          }]
        });
      }

      // Call Claude to analyze performance and generate suggestions
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const analysisPrompt = `You are an expert Facebook ads analyst for Ryvite, an AI-powered event invite platform. Analyze the following ad performance data and provide 3-5 specific, actionable recommendations.

## Performance Data (per creative)
${JSON.stringify(perfData.map(p => ({
  creative_id: p.creative_id,
  campaign: p.campaign_name,
  event_type: p.event_type,
  format: p.format,
  theme: p.video_theme,
  prompt: p.prompt_text,
  impressions: p.impressions,
  clicks: p.fb_clicks,
  ctr: p.ctr,
  spend: '$' + ((p.spend_cents || 0) / 100).toFixed(2),
  signups: p.signups,
  events_created: p.events_created,
  events_published: p.events_published,
  cost_per_signup: p.cost_per_signup ? '$' + p.cost_per_signup : 'N/A',
  signup_rate: p.click_to_signup_rate + '%'
})), null, 2)}

## Campaign Summary
${JSON.stringify(campaignData, null, 2)}

Return a JSON array of suggestions. Each suggestion should have:
- suggestion_type: "copy" | "creative" | "targeting" | "general"
- title: short title (under 60 chars)
- description: detailed recommendation (2-3 sentences)
- data: { recommended_event_types: [], recommended_themes: [], recommended_prompt_style: "", estimated_improvement: "" }
- confidence: 0.0 to 1.0

Focus on:
1. Which event types convert best
2. Which video themes/formats perform better
3. What prompt styles drive more engagement
4. Budget allocation recommendations
5. New creative ideas based on what's working

Return ONLY the JSON array, no other text.`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: analysisPrompt }]
      });

      let suggestions = [];
      try {
        const content = response.content[0].text.trim();
        const cleaned = content.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
        suggestions = JSON.parse(cleaned);
      } catch (parseErr) {
        suggestions = [{
          suggestion_type: 'general',
          title: 'Analysis in progress',
          description: 'The AI analysis returned unexpected format. Please try again.',
          confidence: 0.5
        }];
      }

      // Store suggestions in database
      for (const s of suggestions) {
        await supabase.from('ad_suggestions').insert({
          suggestion_type: s.suggestion_type || 'general',
          title: s.title,
          description: s.description,
          data: s.data || null,
          confidence: s.confidence || 0.5,
          based_on: { creative_count: perfData.length, campaign_count: (campaignData || []).length }
        });
      }

      return res.status(200).json({ success: true, suggestions });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'AI analysis failed: ' + err.message });
    }
  }

  // ── LIST SUGGESTIONS: Get stored suggestions ──
  if (action === 'listSuggestions' && req.method === 'GET') {
    const { status } = req.query;
    let query = supabase
      .from('ad_suggestions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, suggestions: data || [] });
  }

  // ── UPDATE SUGGESTION STATUS ──
  if (action === 'updateSuggestion' && req.method === 'POST') {
    const { suggestionId, status, appliedCreativeId } = req.body || {};
    if (!suggestionId || !status) {
      return res.status(400).json({ success: false, error: 'suggestionId and status required' });
    }

    const updates = { status };
    if (appliedCreativeId) updates.applied_creative_id = appliedCreativeId;

    const { error } = await supabase
      .from('ad_suggestions')
      .update(updates)
      .eq('id', suggestionId);

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}
