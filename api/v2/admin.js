import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Founder — always has admin access, cannot be removed
const FOUNDER_EMAIL = 'jake@getmrkt.com';

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'no_token' };

  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: 'invalid_token' };

  const email = user.email.toLowerCase();

  // Founder always passes
  if (email === FOUNDER_EMAIL) return { user };

  // Check DB admin list
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();

  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return { user };
  }

  return { error: 'not_admin' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const authResult = await verifyAdmin(req);
    if (authResult.error === 'no_token' || authResult.error === 'invalid_token') {
      return res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    }
    if (authResult.error === 'not_admin') {
      return res.status(403).json({ error: 'Forbidden — admin access required' });
    }
    const admin = authResult.user;

    const action = req.query.action || req.body?.action;
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

    // ---- GET COMPREHENSIVE USER DETAIL ----
    if (action === 'userDetail') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      // Fetch all data in parallel — only use tables/columns that actually exist
      const [profileRes, eventsRes, subsRes, billingRes, generationsRes, smsRes, chatRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
        supabaseAdmin.from('events').select('id, title, event_type, event_date, status, slug, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('subscriptions').select('*, plans:plan_id (name, display_name, price_cents, max_events, max_generations)').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('billing_history').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, prompt, status, latency_ms, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('sms_messages').select('id, event_id, recipient_phone, recipient_name, message_type, status, cost_cents, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('chat_messages').select('id, session_id, role, content, model, input_tokens, output_tokens, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(200)
      ]);

      const profile = profileRes.data;
      if (!profile) return res.status(404).json({ error: 'User not found' });

      const events = eventsRes.data || [];
      const eventIds = events.map(e => e.id);

      // Get RSVP counts + event themes in parallel
      const [guestsResult, themesResult] = await Promise.all([
        eventIds.length > 0
          ? supabaseAdmin.from('guests').select('event_id, status').in('event_id', eventIds)
          : Promise.resolve({ data: [] }),
        eventIds.length > 0
          ? supabaseAdmin.from('event_themes').select('id, event_id, version, is_active, model, input_tokens, output_tokens, latency_ms, created_at').in('event_id', eventIds).order('created_at', { ascending: false })
          : Promise.resolve({ data: [] })
      ]);

      const rsvpCounts = {};
      (guestsResult.data || []).forEach(g => {
        if (!rsvpCounts[g.event_id]) rsvpCounts[g.event_id] = { total: 0, attending: 0, declined: 0, maybe: 0 };
        rsvpCounts[g.event_id].total++;
        if (g.status === 'attending') rsvpCounts[g.event_id].attending++;
        else if (g.status === 'declined') rsvpCounts[g.event_id].declined++;
        else if (g.status === 'maybe') rsvpCounts[g.event_id].maybe++;
      });

      // Track which events have active themes
      const eventThemeMap = {};
      (themesResult.data || []).forEach(t => {
        if (!eventThemeMap[t.event_id]) eventThemeMap[t.event_id] = { hasTheme: false, versions: 0 };
        eventThemeMap[t.event_id].versions++;
        if (t.is_active) eventThemeMap[t.event_id].hasTheme = true;
      });

      // Cost calculations — must match generate-theme.js, chat.js, billing.js, ratings.js
      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
        'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
        'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
        'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
        'claude-opus-4-6':           { input: 15.00, output: 75.00 },
      };

      const markupRes = await supabaseAdmin.from('app_config').select('value').eq('key', 'cost_markup_pct').single();
      const markupPct = parseFloat(markupRes.data?.value) || 100;
      const markupMultiplier = 1 + markupPct / 100;

      let totalAiCost = 0;
      let chatAiCost = 0;
      let themeAiCost = 0;
      const costByEvent = {};

      // generation_log: event_id=null means chat, event_id=X means theme generation
      const allGenerations = generationsRes.data || [];
      const chatGenerations = []; // chat AI calls (event_id is null)
      const themeGenerations = []; // theme AI calls (event_id is set)

      const generations = allGenerations.map(g => {
        const pricing = MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
        const cost = ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
        totalAiCost += cost;
        const isChat = !g.event_id;
        if (isChat) {
          chatAiCost += cost;
          chatGenerations.push(g);
        } else {
          themeAiCost += cost;
          themeGenerations.push(g);
          if (!costByEvent[g.event_id]) costByEvent[g.event_id] = { aiCost: 0, smsCost: 0 };
          costByEvent[g.event_id].aiCost += cost;
        }
        return {
          id: g.id,
          eventId: g.event_id,
          model: g.model,
          inputTokens: g.input_tokens,
          outputTokens: g.output_tokens,
          promptType: g.event_id ? 'theme' : 'chat',
          cost,
          latencyMs: g.latency_ms,
          createdAt: g.created_at
        };
      });

      // Also add event_themes generation costs (themes table tracks its own tokens)
      (themesResult.data || []).forEach(t => {
        if (t.input_tokens || t.output_tokens) {
          const pricing = MODEL_PRICING[t.model] || { input: 3.00, output: 15.00 };
          const themeCost = ((t.input_tokens || 0) * pricing.input + (t.output_tokens || 0) * pricing.output) / 1_000_000;
          // Only add if not already counted via generation_log (avoid double-counting)
          // Theme gen writes to BOTH event_themes AND generation_log, so skip this
        }
      });

      // SMS costs by event
      let totalSmsCost = 0;
      const smsMessages = (smsRes.data || []).map(s => {
        const costDollars = (s.cost_cents || 0) / 100;
        totalSmsCost += costDollars;
        if (s.event_id) {
          if (!costByEvent[s.event_id]) costByEvent[s.event_id] = { aiCost: 0, smsCost: 0 };
          costByEvent[s.event_id].smsCost += costDollars;
        }
        return {
          id: s.id,
          eventId: s.event_id,
          recipientPhone: s.recipient_phone,
          recipientName: s.recipient_name,
          messageType: s.message_type,
          status: s.status,
          costCents: s.cost_cents,
          createdAt: s.created_at
        };
      });

      // Revenue from subscriptions
      const subscriptions = (subsRes.data || []);
      const totalRevenue = subscriptions.reduce((sum, s) => sum + (s.amount_paid_cents || 0), 0) / 100;
      const totalDiscount = subscriptions.reduce((sum, s) => sum + (s.discount_cents || 0), 0) / 100;

      // Stripe payment info (PCI compliant - only last4, brand, expiry)
      let stripePayment = null;
      if (profile.stripe_customer_id) {
        try {
          const stripeClient = getStripe();

          // Fetch all payment method types: card, link, us_bank_account
          const [cardMethods, linkMethods] = await Promise.all([
            stripeClient.paymentMethods.list({ customer: profile.stripe_customer_id, type: 'card', limit: 5 }),
            stripeClient.paymentMethods.list({ customer: profile.stripe_customer_id, type: 'link', limit: 5 })
          ]);

          const allMethods = [];

          // Card payment methods
          cardMethods.data.forEach(pm => {
            allMethods.push({
              id: pm.id,
              type: 'card',
              brand: pm.card.brand,
              last4: pm.card.last4,
              expMonth: pm.card.exp_month,
              expYear: pm.card.exp_year
            });
          });

          // Link payment methods
          linkMethods.data.forEach(pm => {
            allMethods.push({
              id: pm.id,
              type: 'link',
              email: pm.link?.email || null
            });
          });

          // Fetch recent charges to show last payment info regardless of saved methods
          let lastCharge = null;
          try {
            const charges = await stripeClient.charges.list({
              customer: profile.stripe_customer_id,
              limit: 3
            });
            if (charges.data.length > 0) {
              const c = charges.data[0];
              lastCharge = {
                id: c.id,
                amount: c.amount,
                currency: c.currency,
                status: c.status,
                created: c.created,
                paymentMethodType: c.payment_method_details?.type || null,
                cardBrand: c.payment_method_details?.card?.brand || null,
                cardLast4: c.payment_method_details?.card?.last4 || null,
                linkEmail: c.payment_method_details?.link?.email || null,
                receiptUrl: c.receipt_url
              };
            }
          } catch (e) { /* non-fatal */ }

          stripePayment = {
            customerId: profile.stripe_customer_id,
            cards: allMethods.filter(m => m.type === 'card'),
            paymentMethods: allMethods,
            lastCharge
          };
        } catch (e) {
          stripePayment = { customerId: profile.stripe_customer_id, cards: [], paymentMethods: [], lastCharge: null, error: 'Could not fetch from Stripe' };
        }
      }

      // Billing history
      const billing = (billingRes.data || []).map(b => ({
        id: b.id,
        amountCents: b.amount_cents,
        status: b.status,
        description: b.description,
        receiptUrl: b.receipt_url,
        stripePaymentIntentId: b.stripe_payment_intent_id,
        createdAt: b.created_at
      }));

      const totalPlatformCost = totalAiCost + totalSmsCost;

      return res.status(200).json({
        success: true,
        user: {
          id: profile.id,
          email: profile.email,
          displayName: profile.display_name,
          phone: profile.phone,
          tier: profile.tier,
          referralSource: profile.referral_source,
          stripeCustomerId: profile.stripe_customer_id,
          createdAt: profile.created_at,
          updatedAt: profile.updated_at
        },
        financials: {
          totalRevenue,
          totalDiscount,
          totalPlatformCost,
          totalAiCost,
          chatAiCost,
          themeAiCost,
          totalSmsCost,
          smsSentCount: smsMessages.length,
          generationCount: generations.length,
          chatCount: chatGenerations.length,
          themeCount: themeGenerations.length,
          markupPct,
          revenueAfterMarkup: totalAiCost * markupMultiplier,
          netMargin: totalRevenue - totalPlatformCost,
          costByEvent
        },
        events: events.map(e => ({
          id: e.id,
          title: e.title,
          eventType: e.event_type,
          eventDate: e.event_date,
          status: e.status,
          slug: e.slug,
          createdAt: e.created_at,
          hasTheme: !!(eventThemeMap[e.id] && eventThemeMap[e.id].hasTheme),
          themeVersions: eventThemeMap[e.id] ? eventThemeMap[e.id].versions : 0,
          rsvps: rsvpCounts[e.id] || { total: 0, attending: 0, declined: 0, maybe: 0 },
          costs: costByEvent[e.id] || { aiCost: 0, smsCost: 0 }
        })),
        subscriptions: subscriptions.map(s => ({
          id: s.id,
          planName: s.plans?.display_name || s.plans?.name,
          planPriceCents: s.plans?.price_cents,
          maxEvents: s.plans?.max_events,
          maxGenerations: s.plans?.max_generations,
          status: s.status,
          amountPaidCents: s.amount_paid_cents,
          discountCents: s.discount_cents,
          eventsUsed: s.events_used,
          generationsUsed: s.generations_used,
          couponId: s.coupon_id,
          createdAt: s.created_at
        })),
        billing,
        stripePayment,
        generations,
        smsMessages,
        // Full chat conversation history from chat_messages table
        chatHistory: (chatRes.data || []).map(c => ({
          id: c.id,
          sessionId: c.session_id,
          role: c.role,
          content: c.content,
          model: c.model,
          inputTokens: c.input_tokens,
          outputTokens: c.output_tokens,
          createdAt: c.created_at
        })),
        // Theme generation history from event_themes table
        themeHistory: (themesResult.data || []).map(t => ({
          id: t.id,
          eventId: t.event_id,
          version: t.version,
          isActive: t.is_active,
          model: t.model,
          inputTokens: t.input_tokens,
          outputTokens: t.output_tokens,
          latencyMs: t.latency_ms,
          createdAt: t.created_at
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
        supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, created_at, prompt', { count: 'exact' }),
        supabaseAdmin.from('app_config').select('value').eq('key', 'cost_markup_pct').single()
      ]);

      const events = eventsRes.data || [];
      const published = events.filter(e => e.status === 'published').length;
      const markupPct = parseFloat(markupRes.data?.value) || 100; // default 100% markup

      // AI model pricing per 1M tokens — must match generate-theme.js, chat.js, billing.js, ratings.js
      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
        'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
        'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
        'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
        'claude-opus-4-6':           { input: 15.00, output: 75.00 },
      };

      // Token usage + costs by model
      const tokensByModel = {};
      let totalApiCost = 0;
      let chatApiCost = 0;
      let themeApiCost = 0;
      let testApiCost = 0;
      let chatCount = 0;
      let themeCount = 0;
      let testCount = 0;

      // Cost by time period (last 7 days, last 30 days, all time)
      const now = Date.now();
      const day7 = now - 7 * 86400000;
      const day30 = now - 30 * 86400000;
      let cost7d = 0, cost30d = 0;

      (logsRes.data || []).forEach(l => {
        const model = l.model || 'unknown';
        if (!tokensByModel[model]) tokensByModel[model] = { generations: 0, inputTokens: 0, outputTokens: 0, cost: 0, chatCount: 0, themeCount: 0, testCount: 0 };
        tokensByModel[model].generations++;
        tokensByModel[model].inputTokens += l.input_tokens || 0;
        tokensByModel[model].outputTokens += l.output_tokens || 0;

        // Compute cost
        const pricing = MODEL_PRICING[model] || { input: 3.00, output: 15.00 }; // default to Sonnet pricing
        const cost = ((l.input_tokens || 0) * pricing.input + (l.output_tokens || 0) * pricing.output) / 1_000_000;
        tokensByModel[model].cost += cost;
        totalApiCost += cost;

        // Categorize: prompt_test (admin lab), chat (event planning), or theme (generation/tweak)
        const isTest = l.prompt && l.prompt.startsWith('prompt_test');
        const isChat = !l.event_id && !isTest;
        if (isTest) { testApiCost += cost; testCount++; tokensByModel[model].testCount++; }
        else if (isChat) { chatApiCost += cost; chatCount++; tokensByModel[model].chatCount++; }
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
            apiCostTest: testApiCost,
            apiCost7d: cost7d,
            apiCost30d: cost30d,
            chatCount,
            themeCount,
            testCount,
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

    // ---- ARCHIVE A STYLE LIBRARY ITEM ----
    if (action === 'archiveStyle') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { styleId, undo } = req.body;
      if (!styleId) return res.status(400).json({ error: 'styleId required' });

      const updateData = undo
        ? { archived_at: null, archived_by: null }
        : { archived_at: new Date().toISOString(), archived_by: admin.email };

      const { error } = await supabaseAdmin
        .from('style_library')
        .update(updateData)
        .eq('id', styleId);
      if (error) return res.status(500).json({ error: 'Failed to archive: ' + error.message });
      return res.status(200).json({ success: true });
    }

    // ---- GET STYLE LIBRARY ----
    if (action === 'getStyleLibrary') {
      const includeArchived = req.query.includeArchived === 'true';
      let query = supabaseAdmin
        .from('style_library')
        .select('*')
        .order('created_at', { ascending: false });
      if (!includeArchived) {
        query = query.is('archived_at', null);
      }
      const { data, error } = await query;

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
        addedBy: row.added_by,
        adminRating: row.admin_rating || 0,
        adminNotes: row.admin_notes || '',
        ratedBy: row.rated_by || '',
        ratedAt: row.rated_at || null,
        timesUsed: row.times_used || 0,
        archivedAt: row.archived_at || null,
        archivedBy: row.archived_by || null
      }));

      return res.status(200).json({ success: true, library });
    }

    // ---- SAVE STYLE LIBRARY ITEM ----
    if (action === 'saveStyleItem') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { id, name, description, html, tags, eventTypes, designNotes, adminRating } = req.body;
      if (!name || !html) return res.status(400).json({ error: 'name and html are required' });

      const row = {
        name,
        description: description || '',
        html,
        tags: tags || [],
        event_types: eventTypes || [],
        design_notes: designNotes || '',
      };

      // Carry over admin rating if provided (e.g. from prompt lab test run)
      if (adminRating && adminRating >= 1 && adminRating <= 5) {
        row.admin_rating = adminRating;
        row.rated_by = admin.email;
        row.rated_at = new Date().toISOString();
      }

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

    // ---- LIST PROMPT VERSIONS ----
    if (action === 'listPromptVersions') {
      const { data, error } = await supabaseAdmin
        .from('prompt_versions')
        .select('id, version, name, description, is_active, created_by, created_at, updated_at')
        .order('version', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        success: true,
        versions: data || []
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
        .single();

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, coupon: data });
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

      return res.status(200).json({ success: true, version: data });
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

      const { promptVersionId, model, eventType, eventDetails: testEventDetails, resultHtml, resultCss, resultConfig, resultThankyouHtml, styleLibraryIds, testSessionId, sessionPosition, inputTokens, outputTokens, latencyMs, score, notes } = req.body;

      const insertData = {
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
      };

      // Add metadata fields (gracefully skip if columns don't exist yet)
      if (Array.isArray(styleLibraryIds) && styleLibraryIds.length > 0) {
        insertData.style_library_ids = styleLibraryIds;
      }
      if (resultThankyouHtml) {
        insertData.result_thankyou_html = resultThankyouHtml;
      }
      if (testSessionId) {
        insertData.test_session_id = testSessionId;
      }
      if (sessionPosition !== undefined) {
        insertData.session_position = sessionPosition;
      }

      let { data: insertedRun, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .insert(insertData)
        .select('id')
        .single();

      // Retry without new columns if migration hasn't been run
      if (error && (error.message?.includes('style_library_ids') || error.message?.includes('result_thankyou_html') || error.message?.includes('test_session_id') || error.message?.includes('session_position'))) {
        delete insertData.style_library_ids;
        delete insertData.result_thankyou_html;
        delete insertData.test_session_id;
        delete insertData.session_position;
        ({ data: insertedRun, error } = await supabaseAdmin
          .from('prompt_test_runs')
          .insert(insertData)
          .select('id')
          .single());
      }

      if (error) return res.status(500).json({ error: 'Failed to save test run: ' + error.message });

      return res.status(200).json({ success: true, testRunId: insertedRun?.id || null });
    }

    // ---- LIST TEST RUNS FOR A PROMPT VERSION ----
    if (action === 'listTestRuns') {
      const promptVersionId = req.query.promptVersionId;
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = (page - 1) * limit;
      const modelFilter = req.query.model;
      const eventTypeFilter = req.query.eventType;
      const scoreFilter = req.query.scoreFilter; // 'unrated', 'rated', '1'-'5'
      const sortBy = req.query.sortBy || 'created_at';
      const sortDir = req.query.sortDir === 'asc' ? true : false;

      let query = supabaseAdmin
        .from('prompt_test_runs')
        .select('*', { count: 'exact' })
        .order(sortBy, { ascending: sortDir });

      if (promptVersionId) query = query.eq('prompt_version_id', promptVersionId);
      if (modelFilter) query = query.eq('model', modelFilter);
      if (eventTypeFilter) query = query.eq('event_type', eventTypeFilter);
      if (scoreFilter === 'unrated') query = query.is('score', null);
      else if (scoreFilter === 'rated') query = query.not('score', 'is', null);
      else if (['1','2','3','4','5'].includes(scoreFilter)) query = query.eq('score', parseInt(scoreFilter));

      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) return res.status(400).json({ error: error.message });

      // Get prompt version names
      const pvIds = [...new Set((data || []).map(r => r.prompt_version_id).filter(Boolean))];
      let pvMap = {};
      if (pvIds.length > 0) {
        const { data: pvs } = await supabaseAdmin.from('prompt_versions').select('id, version, name').in('id', pvIds);
        (pvs || []).forEach(v => { pvMap[v.id] = `v${v.version} – ${v.name}`; });
      }

      const LAB_MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
        'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
        'claude-opus-4-6': { input: 15.00, output: 75.00 },
      };

      const testRuns = (data || []).map(r => {
        const pricing = LAB_MODEL_PRICING[r.model] || { input: 3.00, output: 15.00 };
        const cost = ((r.input_tokens || 0) * pricing.input + (r.output_tokens || 0) * pricing.output) / 1_000_000;
        return {
          ...r,
          cost: Math.round(cost * 1_000_000) / 1_000_000,
          promptVersionLabel: r.prompt_version_id ? (pvMap[r.prompt_version_id] || 'Unknown') : 'Default',
        };
      });

      return res.status(200).json({ success: true, testRuns, total: count || 0, page, limit });
    }

    // ---- GET TEST SESSION (all runs in one session) ----
    if (action === 'getTestSession') {
      const sessionId = req.query.sessionId;
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

      const { data: runs, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .select('*')
        .eq('test_session_id', sessionId)
        .order('session_position', { ascending: true });

      if (error) return res.status(400).json({ error: error.message });

      // Get prompt version names
      const pvIds = [...new Set((runs || []).map(r => r.prompt_version_id).filter(Boolean))];
      let versionMap = {};
      if (pvIds.length > 0) {
        const { data: versions } = await supabaseAdmin.from('prompt_versions').select('id, version, name').in('id', pvIds);
        (versions || []).forEach(v => { versionMap[v.id] = { version: v.version, name: v.name }; });
      }

      // Build comparison summary
      const scoredRuns = (runs || []).filter(r => r.score != null);
      const bestRun = scoredRuns.length > 0 ? scoredRuns.reduce((best, r) => r.score > best.score ? r : best, scoredRuns[0]) : null;
      const worstRun = scoredRuns.length > 0 ? scoredRuns.reduce((worst, r) => r.score < worst.score ? r : worst, scoredRuns[0]) : null;

      return res.status(200).json({
        success: true,
        sessionId,
        totalRuns: (runs || []).length,
        ratedRuns: scoredRuns.length,
        runs: (runs || []).map(r => {
          const pv = versionMap[r.prompt_version_id] || { version: 0, name: 'Default' };
          return {
            id: r.id,
            model: r.model,
            promptVersionId: r.prompt_version_id,
            promptLabel: r.prompt_version_id ? `v${pv.version} – ${pv.name}` : 'Hardcoded Default',
            eventType: r.event_type,
            score: r.score,
            notes: r.notes,
            latencyMs: r.latency_ms,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            position: r.session_position,
            isBest: bestRun ? r.id === bestRun.id : false,
            isWorst: worstRun ? r.id === worstRun.id : false
          };
        }),
        comparison: scoredRuns.length >= 2 ? {
          scoreSpread: (bestRun?.score || 0) - (worstRun?.score || 0),
          avgScore: Math.round(scoredRuns.reduce((a, r) => a + r.score, 0) / scoredRuns.length * 100) / 100,
          bestModel: bestRun?.model,
          worstModel: worstRun?.model
        } : null
      });
    }

    // ---- SESSION INSIGHTS — aggregate session-level analytics ----
    if (action === 'sessionInsights') {
      // Fetch all sessions with at least 2 scored runs
      const { data: allRuns, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .select('test_session_id, model, prompt_version_id, score, latency_ms, event_type')
        .not('test_session_id', 'is', null)
        .not('score', 'is', null)
        .order('test_session_id');

      if (error) return res.status(400).json({ error: error.message });

      // Group by session
      const sessions = {};
      (allRuns || []).forEach(r => {
        if (!sessions[r.test_session_id]) sessions[r.test_session_id] = [];
        sessions[r.test_session_id].push(r);
      });

      // Only sessions with 2+ scored runs
      const validSessions = Object.entries(sessions).filter(([, runs]) => runs.length >= 2);

      // Model head-to-head wins
      const modelWins = {};
      const modelAppearances = {};
      const modelScores = {};

      validSessions.forEach(([, runs]) => {
        const sorted = [...runs].sort((a, b) => b.score - a.score);
        const winner = sorted[0];
        runs.forEach(r => {
          if (!modelWins[r.model]) modelWins[r.model] = 0;
          if (!modelAppearances[r.model]) modelAppearances[r.model] = 0;
          if (!modelScores[r.model]) modelScores[r.model] = [];
          modelAppearances[r.model]++;
          modelScores[r.model].push(r.score);
        });
        modelWins[winner.model] = (modelWins[winner.model] || 0) + 1;
      });

      const headToHead = Object.keys(modelAppearances).map(model => ({
        model,
        wins: modelWins[model] || 0,
        appearances: modelAppearances[model],
        winRate: Math.round(100 * (modelWins[model] || 0) / modelAppearances[model]) / 100,
        avgScore: Math.round(modelScores[model].reduce((a, b) => a + b, 0) / modelScores[model].length * 100) / 100
      })).sort((a, b) => b.winRate - a.winRate);

      // Common patterns: sessions with big score spreads
      const bigSpreadSessions = validSessions
        .map(([sessionId, runs]) => {
          const scores = runs.map(r => r.score);
          const spread = Math.max(...scores) - Math.min(...scores);
          const best = runs.reduce((b, r) => r.score > b.score ? r : b, runs[0]);
          const worst = runs.reduce((w, r) => r.score < w.score ? r : w, runs[0]);
          return { sessionId, spread, eventType: runs[0].event_type, bestModel: best.model, worstModel: worst.model, bestScore: best.score, worstScore: worst.score, runCount: runs.length };
        })
        .filter(s => s.spread >= 2)
        .sort((a, b) => b.spread - a.spread)
        .slice(0, 20);

      return res.status(200).json({
        success: true,
        insights: {
          totalSessions: validSessions.length,
          totalComparisons: validSessions.reduce((a, [, r]) => a + r.length, 0),
          headToHead,
          bigSpreadSessions
        }
      });
    }

    // ---- UPDATE TEST RUN SCORE ----
    if (action === 'updateTestRunScore') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { testRunId, score, notes } = req.body;
      if (!testRunId) return res.status(400).json({ error: 'testRunId required' });

      const updates = {};
      if (score !== undefined) updates.score = score;
      if (notes !== undefined) updates.notes = notes;

      const { error } = await supabaseAdmin
        .from('prompt_test_runs')
        .update(updates)
        .eq('id', testRunId);

      if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });

      return res.status(200).json({ success: true });
    }

    // ---- TEST RUN STATS / REPORTING ----
    if (action === 'testRunStats') {
      // Get all scored test runs with prompt version info
      const { data: runs, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .select('id, prompt_version_id, model, event_type, score, input_tokens, output_tokens, latency_ms, style_library_ids, test_session_id, created_at')
        .not('score', 'is', null)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      // Get prompt version names for mapping
      const { data: versions } = await supabaseAdmin
        .from('prompt_versions')
        .select('id, version, name');

      const versionMap = {};
      (versions || []).forEach(v => { versionMap[v.id] = { version: v.version, name: v.name }; });

      // Aggregate stats
      const scoredRuns = runs || [];
      const totalTests = scoredRuns.length;

      // By prompt version
      const byPrompt = {};
      scoredRuns.forEach(r => {
        const key = r.prompt_version_id || 'default';
        if (!byPrompt[key]) byPrompt[key] = { scores: [], totalLatency: 0, totalCost: 0, count: 0 };
        byPrompt[key].scores.push(r.score);
        byPrompt[key].totalLatency += r.latency_ms || 0;
        byPrompt[key].count++;
      });

      const promptStats = Object.entries(byPrompt).map(([id, data]) => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        const info = versionMap[id] || { version: 0, name: 'Hardcoded Default' };
        return {
          promptVersionId: id === 'default' ? null : id,
          promptLabel: id === 'default' ? 'Hardcoded Default' : `v${info.version} – ${info.name}`,
          avgScore: Math.round(avg * 100) / 100,
          count: data.count,
          avgLatency: Math.round(data.totalLatency / data.count)
        };
      }).sort((a, b) => b.avgScore - a.avgScore);

      // By model
      const byModel = {};
      scoredRuns.forEach(r => {
        if (!byModel[r.model]) byModel[r.model] = { scores: [], totalLatency: 0, count: 0 };
        byModel[r.model].scores.push(r.score);
        byModel[r.model].totalLatency += r.latency_ms || 0;
        byModel[r.model].count++;
      });

      const modelStats = Object.entries(byModel).map(([model, data]) => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        return {
          model,
          avgScore: Math.round(avg * 100) / 100,
          count: data.count,
          avgLatency: Math.round(data.totalLatency / data.count)
        };
      }).sort((a, b) => b.avgScore - a.avgScore);

      // By prompt × model combo (the leaderboard)
      const byCombo = {};
      scoredRuns.forEach(r => {
        const pvKey = r.prompt_version_id || 'default';
        const key = `${pvKey}::${r.model}`;
        if (!byCombo[key]) byCombo[key] = { promptVersionId: pvKey, model: r.model, scores: [], totalLatency: 0, count: 0 };
        byCombo[key].scores.push(r.score);
        byCombo[key].totalLatency += r.latency_ms || 0;
        byCombo[key].count++;
      });

      const comboStats = Object.values(byCombo).map(data => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        const info = versionMap[data.promptVersionId] || { version: 0, name: 'Hardcoded Default' };
        return {
          promptLabel: data.promptVersionId === 'default' ? 'Hardcoded Default' : `v${info.version} – ${info.name}`,
          model: data.model,
          avgScore: Math.round(avg * 100) / 100,
          count: data.count,
          avgLatency: Math.round(data.totalLatency / data.count)
        };
      }).sort((a, b) => b.avgScore - a.avgScore);

      // By event type
      const byEventType = {};
      scoredRuns.forEach(r => {
        if (!byEventType[r.event_type]) byEventType[r.event_type] = { scores: [], count: 0 };
        byEventType[r.event_type].scores.push(r.score);
        byEventType[r.event_type].count++;
      });

      const eventTypeStats = Object.entries(byEventType).map(([type, data]) => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        return { eventType: type, avgScore: Math.round(avg * 100) / 100, count: data.count };
      }).sort((a, b) => b.avgScore - a.avgScore);

      // Score distribution
      const distribution = [0, 0, 0, 0, 0]; // index 0=1star, 4=5star
      scoredRuns.forEach(r => { if (r.score >= 1 && r.score <= 5) distribution[r.score - 1]++; });

      // By style library item — which reference styles correlate with higher scores
      const byStyle = {};
      scoredRuns.forEach(r => {
        const ids = r.style_library_ids;
        if (!Array.isArray(ids)) return;
        ids.forEach(styleId => {
          if (!byStyle[styleId]) byStyle[styleId] = { scores: [], count: 0 };
          byStyle[styleId].scores.push(r.score);
          byStyle[styleId].count++;
        });
      });

      // Fetch style names for mapping
      const styleIds = Object.keys(byStyle);
      let styleNameMap = {};
      if (styleIds.length > 0) {
        const { data: styles } = await supabaseAdmin
          .from('style_library')
          .select('id, name')
          .in('id', styleIds);
        (styles || []).forEach(s => { styleNameMap[s.id] = s.name; });
      }

      const styleStats = Object.entries(byStyle).map(([id, data]) => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        return {
          styleId: id,
          styleName: styleNameMap[id] || id,
          avgScore: Math.round(avg * 100) / 100,
          count: data.count,
          highQuality: data.scores.filter(s => s >= 4).length,
          lowQuality: data.scores.filter(s => s <= 2).length
        };
      }).sort((a, b) => b.avgScore - a.avgScore);

      return res.status(200).json({
        success: true,
        stats: {
          totalTests,
          overallAvg: totalTests > 0 ? Math.round(scoredRuns.reduce((a, r) => a + r.score, 0) / totalTests * 100) / 100 : 0,
          distribution,
          byPrompt: promptStats,
          byModel: modelStats,
          byCombo: comboStats,
          byEventType: eventTypeStats,
          byStyle: styleStats
        }
      });
    }

    // ════════════════════════════════════════════════
    // ADMIN RATINGS — Style Library + Event Themes
    // ════════════════════════════════════════════════

    // ---- RATE A STYLE LIBRARY ITEM ----
    if (action === 'rateStyle') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { styleId, rating, notes } = req.body;
      if (!styleId) return res.status(400).json({ error: 'styleId required' });
      if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });

      const { error } = await supabaseAdmin
        .from('style_library')
        .update({ admin_rating: rating, admin_notes: notes || '', rated_by: admin.email, rated_at: new Date().toISOString() })
        .eq('id', styleId);

      if (error) return res.status(500).json({ error: 'Failed to rate: ' + error.message });
      return res.status(200).json({ success: true });
    }

    // ---- BROWSE ALL EVENT THEMES (with pagination + filters) ----
    if (action === 'listThemes') {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = (page - 1) * limit;
      const ratingFilter = req.query.ratingFilter; // 'unrated', 'rated', '1', '2', '3', '4', '5'
      const modelFilter = req.query.model;
      const eventTypeFilter = req.query.eventType;
      const promptVersionFilter = req.query.promptVersionId;
      const sortBy = req.query.sortBy || 'created_at'; // 'created_at', 'admin_rating', 'latency_ms'
      const sortDir = req.query.sortDir === 'asc' ? true : false;

      let query = supabaseAdmin
        .from('event_themes')
        .select('id, event_id, version, is_active, html, css, config, model, input_tokens, output_tokens, latency_ms, admin_rating, admin_notes, rated_by, rated_at, prompt_version_id, created_at, events!inner(title, event_type, slug, user_id)', { count: 'exact' });

      if (ratingFilter === 'unrated') query = query.is('admin_rating', null);
      else if (ratingFilter === 'rated') query = query.not('admin_rating', 'is', null);
      else if (['1','2','3','4','5'].includes(ratingFilter)) query = query.eq('admin_rating', parseInt(ratingFilter));

      if (modelFilter) query = query.eq('model', modelFilter);
      if (promptVersionFilter) query = query.eq('prompt_version_id', promptVersionFilter);
      if (eventTypeFilter) query = query.eq('events.event_type', eventTypeFilter);

      query = query.order(sortBy, { ascending: sortDir }).range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) return res.status(400).json({ error: error.message });

      // Get prompt version names for display
      const pvIds = [...new Set((data || []).map(t => t.prompt_version_id).filter(Boolean))];
      let pvMap = {};
      if (pvIds.length > 0) {
        const { data: pvs } = await supabaseAdmin.from('prompt_versions').select('id, version, name').in('id', pvIds);
        (pvs || []).forEach(v => { pvMap[v.id] = `v${v.version} – ${v.name}`; });
      }

      // Look up user profiles for all event owners
      const userIds = [...new Set((data || []).map(t => t.events?.user_id).filter(Boolean))];
      let userMap = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabaseAdmin.from('profiles').select('id, display_name, email').in('id', userIds);
        (profiles || []).forEach(p => { userMap[p.id] = { displayName: p.display_name, email: p.email }; });
      }

      const THEME_MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
        'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
        'claude-opus-4-6': { input: 15.00, output: 75.00 },
      };

      const themes = (data || []).map(t => {
        const pricing = THEME_MODEL_PRICING[t.model] || { input: 3.00, output: 15.00 };
        const cost = ((t.input_tokens || 0) * pricing.input + (t.output_tokens || 0) * pricing.output) / 1_000_000;
        const userId = t.events?.user_id;
        const userProfile = userId ? userMap[userId] : null;
        return {
          ...t,
          eventTitle: t.events?.title || '',
          eventType: t.events?.event_type || '',
          eventSlug: t.events?.slug || '',
          userId: userId || null,
          userDisplayName: userProfile?.displayName || '',
          userEmail: userProfile?.email || '',
          cost: Math.round(cost * 1_000_000) / 1_000_000,
          promptVersionLabel: t.prompt_version_id ? (pvMap[t.prompt_version_id] || 'Unknown') : 'Default',
          events: undefined
        };
      });

      return res.status(200).json({ success: true, themes, total: count || 0, page, limit });
    }

    // ---- RATE AN EVENT THEME ----
    if (action === 'rateTheme') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { themeId, rating, notes } = req.body;
      if (!themeId) return res.status(400).json({ error: 'themeId required' });
      if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });

      const { error } = await supabaseAdmin
        .from('event_themes')
        .update({ admin_rating: rating, admin_notes: notes || '', rated_by: admin.email, rated_at: new Date().toISOString() })
        .eq('id', themeId);

      if (error) return res.status(500).json({ error: 'Failed to rate: ' + error.message });
      return res.status(200).json({ success: true });
    }

    // ---- THEME QUALITY STATS (across all real generations) ----
    if (action === 'themeQualityStats') {
      const { data: themes, error } = await supabaseAdmin
        .from('event_themes')
        .select('id, model, admin_rating, prompt_version_id, latency_ms, input_tokens, output_tokens, created_at')
        .not('admin_rating', 'is', null);

      if (error) return res.status(400).json({ error: error.message });

      const rated = themes || [];
      const totalRated = rated.length;

      // Get prompt version names
      const { data: versions } = await supabaseAdmin.from('prompt_versions').select('id, version, name');
      const vMap = {};
      (versions || []).forEach(v => { vMap[v.id] = `v${v.version} – ${v.name}`; });

      // By model
      const byModel = {};
      rated.forEach(t => {
        const m = t.model || 'unknown';
        if (!byModel[m]) byModel[m] = { scores: [], count: 0 };
        byModel[m].scores.push(t.admin_rating);
        byModel[m].count++;
      });
      const modelStats = Object.entries(byModel).map(([model, d]) => ({
        model, avgScore: Math.round(d.scores.reduce((a,b) => a+b, 0) / d.scores.length * 100) / 100, count: d.count
      })).sort((a,b) => b.avgScore - a.avgScore);

      // By prompt version
      const byPv = {};
      rated.forEach(t => {
        const k = t.prompt_version_id || 'default';
        if (!byPv[k]) byPv[k] = { scores: [], count: 0 };
        byPv[k].scores.push(t.admin_rating);
        byPv[k].count++;
      });
      const pvStats = Object.entries(byPv).map(([id, d]) => ({
        promptLabel: id === 'default' ? 'Hardcoded Default' : (vMap[id] || 'Unknown'),
        avgScore: Math.round(d.scores.reduce((a,b) => a+b, 0) / d.scores.length * 100) / 100, count: d.count
      })).sort((a,b) => b.avgScore - a.avgScore);

      // Distribution
      const distribution = [0, 0, 0, 0, 0];
      rated.forEach(t => { if (t.admin_rating >= 1 && t.admin_rating <= 5) distribution[t.admin_rating - 1]++; });

      return res.status(200).json({
        success: true,
        stats: {
          totalRated,
          overallAvg: totalRated > 0 ? Math.round(rated.reduce((a,t) => a + t.admin_rating, 0) / totalRated * 100) / 100 : 0,
          distribution,
          byModel: modelStats,
          byPrompt: pvStats
        }
      });
    }

    // ---- LIST PLANS (admin) ----
    if (action === 'listPlans') {
      const { data: plans, error } = await supabaseAdmin
        .from('plans')
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        success: true,
        plans: (plans || []).map(p => ({
          id: p.id,
          name: p.name,
          displayName: p.display_name,
          description: p.description,
          priceCents: p.price_cents,
          currency: p.currency,
          stripePriceId: p.stripe_price_id,
          stripeProductId: p.stripe_product_id,
          maxEvents: p.max_events,
          maxGenerations: p.max_generations,
          maxSmsPerEvent: p.max_sms_per_event,
          smsPriceCents: p.sms_price_cents,
          billingType: p.billing_type || 'fixed',
          aiMarkupPct: p.ai_markup_pct || 50,
          smsBaseCostCents: p.sms_base_cost_cents || 3,
          features: p.features,
          isActive: p.is_active,
          isHidden: p.is_hidden || false,
          sortOrder: p.sort_order,
          createdAt: p.created_at,
          updatedAt: p.updated_at
        }))
      });
    }

    // ---- CREATE PLAN (admin) ----
    if (action === 'createPlan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { name, displayName, description, priceCents, maxEvents, maxGenerations, maxSmsPerEvent, smsPriceCents, features, sortOrder, createStripeProduct } = req.body;

      if (!name || !displayName || priceCents === undefined) {
        return res.status(400).json({ error: 'name, displayName, and priceCents are required' });
      }

      // Validate slug format
      const slug = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

      let stripeProductId = null;
      let stripePriceId = null;

      // Optionally create Stripe Product + Price
      if (createStripeProduct && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripeClient = getStripe();
          const product = await stripeClient.products.create({
            name: displayName,
            description: description || undefined,
            metadata: { ryvite_plan_slug: slug }
          });
          stripeProductId = product.id;

          const price = await stripeClient.prices.create({
            product: product.id,
            unit_amount: priceCents,
            currency: 'usd',
            metadata: { ryvite_plan_slug: slug }
          });
          stripePriceId = price.id;
        } catch (e) {
          return res.status(400).json({ error: 'Stripe error: ' + e.message });
        }
      }

      const { data, error } = await supabaseAdmin
        .from('plans')
        .insert({
          name: slug,
          display_name: displayName,
          description: description || null,
          price_cents: priceCents,
          max_events: maxEvents || 1,
          max_generations: maxGenerations || 20,
          max_sms_per_event: maxSmsPerEvent || null,
          sms_price_cents: smsPriceCents || 10,
          billing_type: req.body.billingType || 'fixed',
          ai_markup_pct: req.body.aiMarkupPct || 50,
          sms_base_cost_cents: req.body.smsBaseCostCents || 3,
          features: features || [],
          sort_order: sortOrder || 0,
          stripe_product_id: stripeProductId,
          stripe_price_id: stripePriceId,
          is_active: true,
          is_hidden: req.body.isHidden || false
        })
        .select()
        .single();

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, plan: data });
    }

    // ---- UPDATE PLAN (admin) ----
    if (action === 'updatePlan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { planId, ...updates } = req.body;
      if (!planId) return res.status(400).json({ error: 'planId required' });

      const dbUpdates = {};
      if (updates.displayName !== undefined) dbUpdates.display_name = updates.displayName;
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.priceCents !== undefined) dbUpdates.price_cents = updates.priceCents;
      if (updates.maxEvents !== undefined) dbUpdates.max_events = updates.maxEvents;
      if (updates.maxGenerations !== undefined) dbUpdates.max_generations = updates.maxGenerations;
      if (updates.maxSmsPerEvent !== undefined) dbUpdates.max_sms_per_event = updates.maxSmsPerEvent;
      if (updates.smsPriceCents !== undefined) dbUpdates.sms_price_cents = updates.smsPriceCents;
      if (updates.features !== undefined) dbUpdates.features = updates.features;
      if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
      if (updates.isHidden !== undefined) dbUpdates.is_hidden = updates.isHidden;
      if (updates.billingType !== undefined) dbUpdates.billing_type = updates.billingType;
      if (updates.aiMarkupPct !== undefined) dbUpdates.ai_markup_pct = updates.aiMarkupPct;
      if (updates.smsBaseCostCents !== undefined) dbUpdates.sms_base_cost_cents = updates.smsBaseCostCents;
      if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
      if (updates.stripePriceId !== undefined) dbUpdates.stripe_price_id = updates.stripePriceId;
      if (updates.stripeProductId !== undefined) dbUpdates.stripe_product_id = updates.stripeProductId;

      // If price changed and Stripe product exists, create a new Stripe Price
      if (updates.priceCents !== undefined && updates.syncStripe && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripeClient = getStripe();
          const { data: plan } = await supabaseAdmin.from('plans').select('stripe_product_id, name').eq('id', planId).single();
          if (plan?.stripe_product_id) {
            const price = await stripeClient.prices.create({
              product: plan.stripe_product_id,
              unit_amount: updates.priceCents,
              currency: 'usd',
              metadata: { ryvite_plan_slug: plan.name }
            });
            dbUpdates.stripe_price_id = price.id;
          }
        } catch (e) {
          return res.status(400).json({ error: 'Stripe price update error: ' + e.message });
        }
      }

      const { error } = await supabaseAdmin
        .from('plans')
        .update(dbUpdates)
        .eq('id', planId);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true });
    }

    // ---- DELETE PLAN (soft delete) ----
    if (action === 'deletePlan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { planId } = req.body;
      if (!planId) return res.status(400).json({ error: 'planId required' });

      // Check no active subscriptions use this plan
      const { count } = await supabaseAdmin
        .from('subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', planId)
        .eq('status', 'active');

      if (count > 0) {
        return res.status(400).json({ error: `Cannot delete — ${count} active subscription(s) use this plan. Deactivate them first.` });
      }

      const { error } = await supabaseAdmin
        .from('plans')
        .update({ is_active: false })
        .eq('id', planId);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true });
    }

    // ---- UPDATE USER PROFILE (admin) ----
    if (action === 'updateUser') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { userId, fields } = req.body;
      if (!userId || !fields || typeof fields !== 'object') {
        return res.status(400).json({ error: 'userId and fields object required' });
      }

      // Only allow safe, non-ID fields to be edited
      const ALLOWED_FIELDS = ['display_name', 'phone', 'tier', 'referral_source'];
      const updateData = {};
      for (const [key, value] of Object.entries(fields)) {
        if (ALLOWED_FIELDS.includes(key)) {
          updateData[key] = value;
        }
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update. Allowed: ' + ALLOWED_FIELDS.join(', ') });
      }

      // If tier is changing, validate it matches a real plan and sync Stripe
      let tierSyncResult = null;
      if (updateData.tier) {
        const newTier = updateData.tier;

        // 'free' is always valid (no plan needed)
        if (newTier !== 'free') {
          const { data: plan } = await supabaseAdmin
            .from('plans')
            .select('id, name, display_name, stripe_price_id, stripe_product_id, price_cents')
            .eq('name', newTier)
            .eq('is_active', true)
            .single();

          if (!plan) {
            return res.status(400).json({ error: 'Invalid tier: no active plan named "' + newTier + '"' });
          }

          // Get user profile for Stripe customer ID
          const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('stripe_customer_id, tier')
            .eq('id', userId)
            .single();

          // Create/update subscription record in DB
          // Cancel any existing active subscriptions first
          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('user_id', userId)
            .eq('status', 'active');

          // Create new admin-granted subscription (amount_paid = 0 since admin is assigning)
          const { error: subError } = await supabaseAdmin
            .from('subscriptions')
            .insert({
              user_id: userId,
              plan_id: plan.id,
              status: 'active',
              amount_paid_cents: 0,
              discount_cents: 0,
              events_used: 0,
              generations_used: 0,
              stripe_customer_id: profile?.stripe_customer_id || null
            });

          if (subError) {
            return res.status(400).json({ error: 'Failed to create subscription: ' + subError.message });
          }

          // Sync to Stripe metadata if customer exists
          if (profile?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
            try {
              const stripeClient = getStripe();
              await stripeClient.customers.update(profile.stripe_customer_id, {
                metadata: {
                  ryvite_tier: newTier,
                  ryvite_plan_name: plan.display_name,
                  tier_updated_by: 'admin',
                  tier_updated_at: new Date().toISOString()
                }
              });
              tierSyncResult = { stripeSync: true, planName: plan.display_name };
            } catch (e) {
              tierSyncResult = { stripeSync: false, error: e.message };
            }
          }
        } else {
          // Switching to free — cancel active subscriptions
          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('user_id', userId)
            .eq('status', 'active');

          // Update Stripe metadata
          const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

          if (profile?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
            try {
              const stripeClient = getStripe();
              await stripeClient.customers.update(profile.stripe_customer_id, {
                metadata: {
                  ryvite_tier: 'free',
                  ryvite_plan_name: 'Free',
                  tier_updated_by: 'admin',
                  tier_updated_at: new Date().toISOString()
                }
              });
            } catch (e) { /* non-fatal */ }
          }
        }
      }

      updateData.updated_at = new Date().toISOString();

      const { error } = await supabaseAdmin
        .from('profiles')
        .update(updateData)
        .eq('id', userId);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({
        success: true,
        updated: Object.keys(updateData).filter(k => k !== 'updated_at'),
        tierSync: tierSyncResult
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
