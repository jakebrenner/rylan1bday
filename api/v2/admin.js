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
        'claude-sonnet-4-6':   { input: 3.00, output: 15.00 },
        'claude-opus-4-6':     { input: 15.00, output: 75.00 },
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
          themeModel: config.theme_model || 'claude-sonnet-4-6',
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

    // ---- GET STYLE LIBRARY ----
    if (action === 'getStyleLibrary') {
      const { data, error } = await supabaseAdmin
        .from('style_library')
        .select('*')
        .order('created_at', { ascending: false });

      const library = (data || []).map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        html: row.html,
        tags: row.tags || [],
        eventTypes: row.event_types || [],
        designNotes: row.design_notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        addedBy: row.added_by
      }));

      return res.status(200).json({ success: true, library });
    }

    // ---- SAVE STYLE LIBRARY ITEM ----
    if (action === 'saveStyleItem') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { id, name, description, html, tags, eventTypes, designNotes } = req.body;
      if (!name || !html) return res.status(400).json({ error: 'name and html are required' });

      const row = {
        name,
        description: description || '',
        html,
        tags: tags || [],
        event_types: eventTypes || [],
        design_notes: designNotes || '',
      };

      if (id) {
        // Update existing item
        const { error } = await supabaseAdmin
          .from('style_library')
          .update(row)
          .eq('id', id);
        if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
      } else {
        // Insert new item
        row.id = 'style_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        row.added_by = admin.email;
        const { error } = await supabaseAdmin
          .from('style_library')
          .insert(row);
        if (error) return res.status(500).json({ error: 'Failed to insert: ' + error.message });
      }

      // Return updated library
      const { data } = await supabaseAdmin
        .from('style_library')
        .select('*')
        .order('created_at', { ascending: false });

      const library = (data || []).map(r => ({
        id: r.id, name: r.name, description: r.description, html: r.html,
        tags: r.tags || [], eventTypes: r.event_types || [], designNotes: r.design_notes,
        createdAt: r.created_at, updatedAt: r.updated_at, addedBy: r.added_by
      }));

      return res.status(200).json({ success: true, library });
    }

    // ---- DELETE STYLE LIBRARY ITEM ----
    if (action === 'deleteStyleItem') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { error } = await supabaseAdmin
        .from('style_library')
        .delete()
        .eq('id', id);
      if (error) return res.status(500).json({ error: 'Failed to delete: ' + error.message });

      // Return updated library
      const { data } = await supabaseAdmin
        .from('style_library')
        .select('*')
        .order('created_at', { ascending: false });

      const library = (data || []).map(r => ({
        id: r.id, name: r.name, description: r.description, html: r.html,
        tags: r.tags || [], eventTypes: r.event_types || [], designNotes: r.design_notes,
        createdAt: r.created_at, updatedAt: r.updated_at, addedBy: r.added_by
      }));

      return res.status(200).json({ success: true, library });
    }

    // ---- GET PROMPTS (for admin prompt viewer) ----
    if (action === 'getPrompts') {
      return res.status(200).json({
        success: true,
        prompts: {
          themeSystemPrompt: 'See the Prompt Lab tab for the full system prompt used in theme generation.',
          note: 'The system prompt and DESIGN_DNA are defined in api/v2/generate-theme.js'
        }
      });
    }

    // ---- LIST COUPONS ----
    if (action === 'coupons') {
      const { data: coupons, error } = await supabaseAdmin
        .from('coupons')
        .select('*')
        .order('created_at', { ascending: false });

    // ---- LIST PROMPT VERSIONS ----
    if (action === 'listPromptVersions') {
      const { data, error } = await supabaseAdmin
        .from('prompt_versions')
        .select('id, version, name, description, is_active, created_by, created_at, updated_at')
        .order('version', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        success: true,
        coupons: (coupons || []).map(c => ({
          id: c.id,
          code: c.code,
          description: c.description,
          discountType: c.discount_type,
          discountValue: Number(c.discount_value),
          minPurchaseCents: c.min_purchase_cents,
          maxUses: c.max_uses,
          timesUsed: c.times_used,
          maxUsesPerUser: c.max_uses_per_user,
          validFrom: c.valid_from,
          validUntil: c.valid_until,
          allowedPlans: c.allowed_plans,
          allowedEmails: c.allowed_emails,
          isActive: c.is_active,
          createdAt: c.created_at
        }))
      });
    }

    // ---- CREATE COUPON ----
    if (action === 'createCoupon') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const {
        code, description, discountType, discountValue,
        minPurchaseCents, maxUses, maxUsesPerUser,
        validFrom, validUntil, allowedPlans, allowedEmails, isActive
      } = req.body;

      if (!code || !discountType || discountValue === undefined) {
        return res.status(400).json({ error: 'code, discountType, and discountValue are required' });
      }

      if (!['percent', 'fixed'].includes(discountType)) {
        return res.status(400).json({ error: 'discountType must be "percent" or "fixed"' });
      }

      if (discountType === 'percent' && (discountValue < 0 || discountValue > 100)) {
        return res.status(400).json({ error: 'Percent discount must be between 0 and 100' });
      }

      const { data, error } = await supabaseAdmin
        .from('coupons')
        .insert({
          code: code.toUpperCase().trim(),
          description: description || null,
          discount_type: discountType,
          discount_value: discountValue,
          min_purchase_cents: minPurchaseCents || 0,
          max_uses: maxUses || null,
          max_uses_per_user: maxUsesPerUser || 1,
          valid_from: validFrom || new Date().toISOString(),
          valid_until: validUntil || null,
          allowed_plans: allowedPlans && allowedPlans.length > 0 ? allowedPlans : null,
          allowed_emails: allowedEmails && allowedEmails.length > 0 ? allowedEmails : null,
          is_active: isActive !== false,
          created_by: admin.id
        })
        .select()

        versions: data || []
      });
    }

    // ---- GET PROMPT VERSION (full content) ----
    if (action === 'getPromptVersion') {
      const versionId = req.query.versionId;
      if (!versionId) return res.status(400).json({ error: 'versionId required' });

      const { data, error } = await supabaseAdmin
        .from('prompt_versions')
        .select('*')
        .eq('id', versionId)
        .single();

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, coupon: data });
    }

    // ---- UPDATE COUPON ----
    if (action === 'updateCoupon') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { couponId, ...updates } = req.body;
      if (!couponId) return res.status(400).json({ error: 'couponId required' });

      const dbUpdates = {};
      if (updates.code !== undefined) dbUpdates.code = updates.code.toUpperCase().trim();
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.discountType !== undefined) dbUpdates.discount_type = updates.discountType;
      if (updates.discountValue !== undefined) dbUpdates.discount_value = updates.discountValue;
      if (updates.minPurchaseCents !== undefined) dbUpdates.min_purchase_cents = updates.minPurchaseCents;
      if (updates.maxUses !== undefined) dbUpdates.max_uses = updates.maxUses;
      if (updates.maxUsesPerUser !== undefined) dbUpdates.max_uses_per_user = updates.maxUsesPerUser;
      if (updates.validFrom !== undefined) dbUpdates.valid_from = updates.validFrom;
      if (updates.validUntil !== undefined) dbUpdates.valid_until = updates.validUntil;
      if (updates.allowedPlans !== undefined) dbUpdates.allowed_plans = updates.allowedPlans && updates.allowedPlans.length > 0 ? updates.allowedPlans : null;
      if (updates.allowedEmails !== undefined) dbUpdates.allowed_emails = updates.allowedEmails && updates.allowedEmails.length > 0 ? updates.allowedEmails : null;
      if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;

      const { error } = await supabaseAdmin
        .from('coupons')
        .update(dbUpdates)
        .eq('id', couponId);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true });
    }

    // ---- DELETE COUPON ----
    if (action === 'deleteCoupon') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { couponId } = req.body;
      if (!couponId) return res.status(400).json({ error: 'couponId required' });

      // Soft delete — just deactivate
      const { error } = await supabaseAdmin
        .from('coupons')
        .update({ is_active: false })
        .eq('id', couponId);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true });
    }

    // ---- SMS STATS (admin overview) ----
    if (action === 'smsStats') {
      const { count: totalSent } = await supabaseAdmin
        .from('sms_messages')
        .select('id', { count: 'exact', head: true });

      const { data: costData } = await supabaseAdmin
        .from('sms_messages')
        .select('cost_cents');

      const totalCostCents = (costData || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      return res.status(200).json({
        success: true,
        totalSent: totalSent || 0,
        totalCostCents,
        totalRevenueCents: totalCostCents // revenue = cost to user (we charge $0.05, ClickSend costs us less)
      });
    }

    // ---- LIST ALL SUBSCRIPTIONS (admin) ----
    if (action === 'subscriptions') {
      const { data: subs, error } = await supabaseAdmin
        .from('subscriptions')
        .select(`
          *,
          profiles:user_id (email, display_name),
          plans:plan_id (name, display_name, price_cents)
        `)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      // Get SMS counts per user
      const userIds = [...new Set((subs || []).map(s => s.user_id))];
      const smsCountsByUser = {};
      if (userIds.length > 0) {
        const { data: smsCounts } = await supabaseAdmin
          .from('sms_messages')
          .select('user_id, cost_cents');
        for (const msg of (smsCounts || [])) {
          if (!smsCountsByUser[msg.user_id]) smsCountsByUser[msg.user_id] = { count: 0, costCents: 0 };
          smsCountsByUser[msg.user_id].count++;
          smsCountsByUser[msg.user_id].costCents += msg.cost_cents || 0;
        }
      }

      return res.status(200).json({
        success: true,
        subscriptions: (subs || []).map(s => ({
          id: s.id,
          userId: s.user_id,
          userEmail: s.profiles?.email,
          userName: s.profiles?.display_name,
          planName: s.plans?.display_name,
          planPriceCents: s.plans?.price_cents,
          status: s.status,
          amountPaidCents: s.amount_paid_cents,
          discountCents: s.discount_cents,
          eventsUsed: s.events_used,
          generationsUsed: s.generations_used,
          smsSent: smsCountsByUser[s.user_id]?.count || 0,
          smsCostCents: smsCountsByUser[s.user_id]?.costCents || 0,
          createdAt: s.created_at
        }))
      });
    }

    // ---- UPDATE USER PLAN (admin) ----
    if (action === 'updateUserPlan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { userId, planId, status } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      if (status) {
        // Update existing subscription status
        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({ status })
          .eq('user_id', userId)
          .eq('status', 'active');

        if (error) return res.status(400).json({ error: error.message });
      }

      if (planId) {
        // Create a new complimentary subscription
        const { error } = await supabaseAdmin
          .from('subscriptions')
          .insert({
            user_id: userId,
            plan_id: planId,
            status: 'active',
            amount_paid_cents: 0,
            discount_cents: 0,
            events_used: 0,
            generations_used: 0
          });

        if (error) return res.status(400).json({ error: error.message });
      }

      return res.status(200).json({ success: true });
    }


      return res.status(200).json({ success: true, version: data });
    }

    // ---- GET ACTIVE PROMPT VERSION ----
    if (action === 'getActivePromptVersion') {
      const { data, error } = await supabaseAdmin
        .from('prompt_versions')
        .select('*')
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, version: data || null });
    }

    // ---- SAVE PROMPT VERSION (create or update) ----
    if (action === 'savePromptVersion') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { id, name, description, creativeDirection, designDna } = req.body;
      if (!name || !creativeDirection) return res.status(400).json({ error: 'name and creativeDirection are required' });

      if (id) {
        // Update existing version
        const { error } = await supabaseAdmin
          .from('prompt_versions')
          .update({
            name,
            description: description || '',
            creative_direction: creativeDirection,
            design_dna: designDna || {}
          })
          .eq('id', id);

        if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
      } else {
        // Get next version number
        const { data: latest } = await supabaseAdmin
          .from('prompt_versions')
          .select('version')
          .order('version', { ascending: false })
          .limit(1);

        const nextVersion = (latest && latest.length > 0) ? latest[0].version + 1 : 1;

        const { error } = await supabaseAdmin
          .from('prompt_versions')
          .insert({
            version: nextVersion,
            name,
            description: description || '',
            creative_direction: creativeDirection,
            design_dna: designDna || {},
            is_active: false,
            created_by: admin.email
          });

        if (error) return res.status(500).json({ error: 'Failed to create: ' + error.message });
      }

      // Return updated list
      const { data } = await supabaseAdmin
        .from('prompt_versions')
        .select('id, version, name, description, is_active, created_by, created_at, updated_at')
        .order('version', { ascending: false });

      return res.status(200).json({ success: true, versions: data || [] });
    }

    // ---- ACTIVATE PROMPT VERSION ----
    if (action === 'activatePromptVersion') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { versionId } = req.body;
      if (!versionId) return res.status(400).json({ error: 'versionId required' });

      // Deactivate all
      await supabaseAdmin
        .from('prompt_versions')
        .update({ is_active: false })
        .eq('is_active', true);

      // Activate selected
      const { error } = await supabaseAdmin
        .from('prompt_versions')
        .update({ is_active: true })
        .eq('id', versionId);

      if (error) return res.status(500).json({ error: 'Failed to activate: ' + error.message });

      return res.status(200).json({ success: true });
    }

    // ---- DELETE PROMPT VERSION ----
    if (action === 'deletePromptVersion') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { versionId } = req.body;
      if (!versionId) return res.status(400).json({ error: 'versionId required' });

      // Don't allow deleting the active version
      const { data: check } = await supabaseAdmin
        .from('prompt_versions')
        .select('is_active')
        .eq('id', versionId)
        .single();

      if (check?.is_active) {
        return res.status(400).json({ error: 'Cannot delete the active prompt version. Activate a different version first.' });
      }

      const { error } = await supabaseAdmin
        .from('prompt_versions')
        .delete()
        .eq('id', versionId);

      if (error) return res.status(500).json({ error: 'Failed to delete: ' + error.message });

      return res.status(200).json({ success: true });
    }

    // ---- SAVE PROMPT TEST RUN ----
    if (action === 'saveTestRun') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { promptVersionId, model, eventType, eventDetails: testEventDetails, resultHtml, resultCss, resultConfig, inputTokens, outputTokens, latencyMs, score, notes } = req.body;

      const { error } = await supabaseAdmin
        .from('prompt_test_runs')
        .insert({
          prompt_version_id: promptVersionId || null,
          model: model || 'unknown',
          event_type: eventType || 'other',
          event_details: testEventDetails || {},
          result_html: resultHtml || '',
          result_css: resultCss || '',
          result_config: resultConfig || {},
          input_tokens: inputTokens || 0,
          output_tokens: outputTokens || 0,
          latency_ms: latencyMs || 0,
          score: score || null,
          notes: notes || '',
          created_by: admin.email
        });

      if (error) return res.status(500).json({ error: 'Failed to save test run: ' + error.message });

      return res.status(200).json({ success: true });
    }

    // ---- LIST TEST RUNS FOR A PROMPT VERSION ----
    if (action === 'listTestRuns') {
      const promptVersionId = req.query.promptVersionId;
      let query = supabaseAdmin
        .from('prompt_test_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (promptVersionId) {
        query = query.eq('prompt_version_id', promptVersionId);
      }

      const { data, error } = await query;
      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, testRuns: data || [] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
