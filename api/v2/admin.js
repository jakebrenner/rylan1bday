import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Founder — always has admin access, cannot be removed
const FOUNDER_EMAIL = 'jake@getmrkt.com';

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const email = user.email.toLowerCase();

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden — admin access required' });

  const action = req.query.action || req.body?.action;

  try {
    // ---- LIST ALL USERS ----
    if (action === 'users') {
      const { data: profiles, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, display_name, phone, tier, created_at')
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      // Get event counts per user
      const { data: events } = await supabaseAdmin
        .from('events')
        .select('user_id, status');

      const userStats = {};
      (events || []).forEach(e => {
        if (!userStats[e.user_id]) userStats[e.user_id] = { total: 0, published: 0, draft: 0 };
        userStats[e.user_id].total++;
        if (e.status === 'published') userStats[e.user_id].published++;
        else if (e.status === 'draft') userStats[e.user_id].draft++;
      });

      // Get RSVP counts per user
      const { data: guests } = await supabaseAdmin
        .from('guests')
        .select('event_id, status');

      const eventOwner = {};
      (events || []).forEach(e => { eventOwner[e.user_id] = eventOwner[e.user_id] || []; eventOwner[e.user_id].push(e); });

      // Build event-to-user map
      const eventToUser = {};
      (events || []).forEach(e => { eventToUser[e.user_id] = true; });

      return res.status(200).json({
        success: true,
        users: (profiles || []).map(p => ({
          id: p.id,
          email: p.email,
          displayName: p.display_name,
          phone: p.phone,
          tier: p.tier,
          createdAt: p.created_at,
          events: userStats[p.id] || { total: 0, published: 0, draft: 0 }
        }))
      });
    }

    // ---- GET USER'S EVENTS ----
    if (action === 'userEvents') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const { data: events, error } = await supabaseAdmin
        .from('events')
        .select('id, title, event_type, event_date, status, slug, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      // Get RSVP counts per event
      const eventIds = (events || []).map(e => e.id);
      const { data: guests } = eventIds.length > 0
        ? await supabaseAdmin
            .from('guests')
            .select('event_id, status')
            .in('event_id', eventIds)
        : { data: [] };

      const rsvpCounts = {};
      (guests || []).forEach(g => {
        if (!rsvpCounts[g.event_id]) rsvpCounts[g.event_id] = { total: 0, attending: 0, declined: 0, maybe: 0 };
        rsvpCounts[g.event_id].total++;
        if (g.status === 'attending') rsvpCounts[g.event_id].attending++;
        else if (g.status === 'declined') rsvpCounts[g.event_id].declined++;
        else if (g.status === 'maybe') rsvpCounts[g.event_id].maybe++;
      });

      return res.status(200).json({
        success: true,
        events: (events || []).map(e => ({
          id: e.id,
          title: e.title,
          eventType: e.event_type,
          eventDate: e.event_date,
          status: e.status,
          slug: e.slug,
          createdAt: e.created_at,
          rsvps: rsvpCounts[e.id] || { total: 0, attending: 0, declined: 0, maybe: 0 }
        }))
      });
    }

    // ---- GET EVENT RSVPS ----
    if (action === 'eventRsvps') {
      const eventId = req.query.eventId;
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      const { data: guests, error } = await supabaseAdmin
        .from('guests')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        success: true,
        rsvps: (guests || []).map(g => ({
          id: g.id,
          name: g.name,
          email: g.email,
          phone: g.phone,
          status: g.status,
          responseData: g.response_data,
          plusOnes: g.plus_ones,
          notes: g.notes,
          respondedAt: g.responded_at,
          createdAt: g.created_at
        }))
      });
    }

    // ---- PLATFORM STATS ----
    if (action === 'stats') {
      const [usersRes, eventsRes, guestsRes, logsRes, markupRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('events').select('id, status', { count: 'exact' }),
        supabaseAdmin.from('guests').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, created_at', { count: 'exact' }),
        supabaseAdmin.from('app_config').select('value').eq('key', 'cost_markup_pct').single()
      ]);

      const events = eventsRes.data || [];
      const published = events.filter(e => e.status === 'published').length;
      const markupPct = parseFloat(markupRes.data?.value) || 100; // default 100% markup

      // Pricing per 1M tokens (input / output) by model
      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001':  { input: 0.80, output: 4.00 },
        'claude-sonnet-4-20250514':   { input: 3.00, output: 15.00 },
        'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },
      };

      // Token usage + costs by model
      const tokensByModel = {};
      let totalApiCost = 0;
      let chatApiCost = 0;
      let themeApiCost = 0;
      let chatCount = 0;
      let themeCount = 0;

      // Cost by time period (last 7 days, last 30 days, all time)
      const now = Date.now();
      const day7 = now - 7 * 86400000;
      const day30 = now - 30 * 86400000;
      let cost7d = 0, cost30d = 0;

      (logsRes.data || []).forEach(l => {
        const model = l.model || 'unknown';
        if (!tokensByModel[model]) tokensByModel[model] = { generations: 0, inputTokens: 0, outputTokens: 0, cost: 0, chatCount: 0, themeCount: 0 };
        tokensByModel[model].generations++;
        tokensByModel[model].inputTokens += l.input_tokens || 0;
        tokensByModel[model].outputTokens += l.output_tokens || 0;

        // Compute cost
        const pricing = MODEL_PRICING[model] || { input: 3.00, output: 15.00 }; // default to Sonnet pricing
        const cost = ((l.input_tokens || 0) * pricing.input + (l.output_tokens || 0) * pricing.output) / 1_000_000;
        tokensByModel[model].cost += cost;
        totalApiCost += cost;

        const isChat = !l.event_id;
        if (isChat) { chatApiCost += cost; chatCount++; tokensByModel[model].chatCount++; }
        else { themeApiCost += cost; themeCount++; tokensByModel[model].themeCount++; }

        const ts = new Date(l.created_at).getTime();
        if (ts >= day7) cost7d += cost;
        if (ts >= day30) cost30d += cost;
      });

      const markupMultiplier = 1 + markupPct / 100;

      return res.status(200).json({
        success: true,
        stats: {
          totalUsers: usersRes.count || 0,
          totalEvents: eventsRes.count || 0,
          publishedEvents: published,
          totalRsvps: guestsRes.count || 0,
          totalGenerations: logsRes.count || 0,
          tokensByModel,
          costs: {
            apiCostTotal: totalApiCost,
            apiCostChat: chatApiCost,
            apiCostTheme: themeApiCost,
            apiCost7d: cost7d,
            apiCost30d: cost30d,
            chatCount,
            themeCount,
            markupPct,
            revenueTotal: totalApiCost * markupMultiplier,
            revenue7d: cost7d * markupMultiplier,
            revenue30d: cost30d * markupMultiplier
          }
        }
      });
    }

    // ---- GET MODEL CONFIG ----
    if (action === 'getConfig') {
      // Read from app_config table if exists, otherwise return defaults
      const { data } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', ['chat_model', 'theme_model', 'cost_markup_pct']);

      const config = {};
      (data || []).forEach(row => { config[row.key] = row.value; });

      return res.status(200).json({
        success: true,
        config: {
          chatModel: config.chat_model || 'claude-haiku-4-5-20251001',
          themeModel: config.theme_model || 'claude-sonnet-4-20250514',
          costMarkupPct: parseFloat(config.cost_markup_pct) || 100
        }
      });
    }

    // ---- SAVE MODEL CONFIG ----
    if (action === 'saveConfig') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { chatModel, themeModel, costMarkupPct } = req.body;

      const upserts = [];
      if (chatModel) upserts.push({ key: 'chat_model', value: chatModel, updated_by: admin.id, updated_at: new Date().toISOString() });
      if (themeModel) upserts.push({ key: 'theme_model', value: themeModel, updated_by: admin.id, updated_at: new Date().toISOString() });
      if (costMarkupPct !== undefined) upserts.push({ key: 'cost_markup_pct', value: String(costMarkupPct), updated_by: admin.id, updated_at: new Date().toISOString() });

      if (upserts.length > 0) {
        const { error } = await supabaseAdmin
          .from('app_config')
          .upsert(upserts, { onConflict: 'key' });

        if (error) return res.status(400).json({ error: error.message });
      }

      return res.status(200).json({ success: true });
    }

    // ---- LIST ADMINS ----
    if (action === 'listAdmins') {
      const { data } = await supabaseAdmin
        .from('app_config')
        .select('value')
        .eq('key', 'admin_emails')
        .single();

      const adminList = data?.value
        ? data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        : [];

      // Always include founder
      if (!adminList.includes(FOUNDER_EMAIL)) {
        adminList.unshift(FOUNDER_EMAIL);
      }

      return res.status(200).json({
        success: true,
        admins: adminList.map(email => ({
          email,
          isFounder: email === FOUNDER_EMAIL
        }))
      });
    }

    // ---- ADD ADMIN ----
    if (action === 'addAdmin') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const newEmail = (req.body.email || '').trim().toLowerCase();
      if (!newEmail || !newEmail.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
      }

      const { data } = await supabaseAdmin
        .from('app_config')
        .select('value')
        .eq('key', 'admin_emails')
        .single();

      const currentList = data?.value
        ? data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        : [];

      if (currentList.includes(newEmail) || newEmail === FOUNDER_EMAIL) {
        return res.status(400).json({ error: 'Already an admin' });
      }

      currentList.push(newEmail);

      await supabaseAdmin
        .from('app_config')
        .upsert({ key: 'admin_emails', value: currentList.join(','), updated_by: admin.id, updated_at: new Date().toISOString() }, { onConflict: 'key' });

      return res.status(200).json({ success: true });
    }

    // ---- REMOVE ADMIN ----
    if (action === 'removeAdmin') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const removeEmail = (req.body.email || '').trim().toLowerCase();
      if (removeEmail === FOUNDER_EMAIL) {
        return res.status(400).json({ error: 'Cannot remove the founder' });
      }

      const { data } = await supabaseAdmin
        .from('app_config')
        .select('value')
        .eq('key', 'admin_emails')
        .single();

      const currentList = data?.value
        ? data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        : [];

      const updated = currentList.filter(e => e !== removeEmail);

      await supabaseAdmin
        .from('app_config')
        .upsert({ key: 'admin_emails', value: updated.join(','), updated_by: admin.id, updated_at: new Date().toISOString() }, { onConflict: 'key' });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
