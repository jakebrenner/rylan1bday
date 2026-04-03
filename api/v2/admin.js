import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { reportApiError } from './lib/error-reporter.js';

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
      // Fetch profiles, events, revenue, and auth users in parallel
      const [profilesRes, eventsRes, billingRes, authUsersRes] = await Promise.all([
        supabaseAdmin
          .from('profiles')
          .select('id, email, display_name, phone, tier, free_event_credits, purchased_event_credits, created_at')
          .order('created_at', { ascending: false }),
        supabaseAdmin
          .from('events')
          .select('user_id, status'),
        supabaseAdmin
          .from('billing_history')
          .select('user_id, amount_cents')
          .eq('status', 'succeeded'),
        // Fetch all auth users to check banned status
        (async () => {
          let allAuthUsers = [];
          let page = 1;
          while (true) {
            const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
            if (error || !users || users.length === 0) break;
            allAuthUsers = allAuthUsers.concat(users);
            if (users.length < 1000) break;
            page++;
          }
          return allAuthUsers;
        })()
      ]);

      const { data: profiles, error } = profilesRes;
      if (error) return res.status(400).json({ error: error.message });

      const events = eventsRes.data || [];

      // Event counts per user
      const userStats = {};
      events.forEach(e => {
        if (!userStats[e.user_id]) userStats[e.user_id] = { total: 0, published: 0, draft: 0 };
        userStats[e.user_id].total++;
        if (e.status === 'published') userStats[e.user_id].published++;
        else if (e.status === 'draft') userStats[e.user_id].draft++;
      });

      // Revenue per user (from billing_history)
      const revenueByUser = {};
      (billingRes.data || []).forEach(b => {
        revenueByUser[b.user_id] = (revenueByUser[b.user_id] || 0) + (b.amount_cents || 0);
      });

      // Banned status from auth users
      const bannedMap = {};
      const now = new Date();
      (authUsersRes || []).forEach(u => {
        if (u.banned_until && new Date(u.banned_until) > now) {
          bannedMap[u.id] = true;
        }
      });

      return res.status(200).json({
        success: true,
        users: (profiles || []).map(p => ({
          id: p.id,
          email: p.email,
          displayName: p.display_name,
          phone: p.phone,
          tier: p.tier,
          freeEventCredits: p.free_event_credits || 0,
          purchasedEventCredits: p.purchased_event_credits || 0,
          createdAt: p.created_at,
          events: userStats[p.id] || { total: 0, published: 0, draft: 0 },
          revenue: (revenueByUser[p.id] || 0) / 100,
          isActive: !bannedMap[p.id]
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
      const [profileRes, authUserRes, eventsRes, subsRes, billingRes, generationsRes, smsRes, chatRes, creditLedgerRes, notifRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
        supabaseAdmin.auth.admin.getUserById(userId).catch(() => ({ data: { user: null } })),
        supabaseAdmin.from('events').select('id, title, event_type, event_date, status, slug, payment_status, paid_at, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('subscriptions').select('*, plans:plan_id (name, display_name, price_cents, max_events, max_generations)').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('billing_history').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, prompt, status, latency_ms, created_at').eq('user_id', userId).eq('status', 'success').order('created_at', { ascending: false }),
        supabaseAdmin.from('sms_messages').select('id, event_id, recipient_phone, recipient_name, message_type, status, cost_cents, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabaseAdmin.from('chat_messages').select('id, session_id, role, content, phase, model, input_tokens, output_tokens, created_at').eq('user_id', userId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200),
        (async () => { try { return await supabaseAdmin.from('credit_ledger').select('entry_type, amount, source, notes, reference_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }); } catch { return { data: [] }; } })(),
        // Fetch notification_log: match by user_id OR recipient email (for pre-migration records)
        (async () => {
          try {
            // First try by user_id
            const byUserId = await supabaseAdmin.from('notification_log')
              .select('id, event_id, channel, recipient, subject, status, email_type, delivered_at, opened_at, clicked_at, bounced_at, sent_at, created_at')
              .eq('user_id', userId)
              .order('sent_at', { ascending: false })
              .limit(100);
            // Also get by email for records that predate user_id column
            const profileData = await supabaseAdmin.from('profiles').select('email').eq('id', userId).single();
            if (profileData.data?.email) {
              const byEmail = await supabaseAdmin.from('notification_log')
                .select('id, event_id, channel, recipient, subject, status, email_type, delivered_at, opened_at, clicked_at, bounced_at, sent_at, created_at')
                .eq('recipient', profileData.data.email)
                .is('user_id', null)
                .order('sent_at', { ascending: false })
                .limit(100);
              // Merge and deduplicate by id
              const allNotifs = [...(byUserId.data || []), ...(byEmail.data || [])];
              const seen = new Set();
              return { data: allNotifs.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; }) };
            }
            return byUserId;
          } catch { return { data: [] }; }
        })()
      ]);

      const profile = profileRes.data;
      if (!profile) return res.status(404).json({ error: 'User not found' });

      const authUser = authUserRes.data?.user;
      const isBanned = authUser?.banned_until ? new Date(authUser.banned_until) > new Date() : false;

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

      // Cost calculations — raw API cost, no markup
      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
        'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
        'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
        'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
        'claude-opus-4-6':           { input: 15.00, output: 75.00 },
      };

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
        const isChat = (g.prompt && g.prompt.startsWith('chat:')) || !g.event_id;
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
          promptType: g.prompt?.startsWith('prompt_test') ? 'test'
            : (g.prompt?.startsWith('QM ') || g.prompt?.startsWith('admin:') || g.prompt?.startsWith('blog:') || g.prompt?.startsWith('publish-verify:')) ? 'internal'
            : g.event_id ? 'theme' : 'chat',
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

      // Revenue from actual payments (billing_history)
      const billingData = billingRes.data || [];
      const succeededPayments = billingData.filter(b => b.status === 'succeeded');
      const totalRevenue = succeededPayments.reduce((sum, b) => sum + (b.amount_cents || 0), 0) / 100;

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

      // Revenue: only actual Stripe payments (billing_history)
      // Credits used: from credit_ledger (event_publish entries)
      const creditLedger = creditLedgerRes.data || [];
      const creditUsedEntries = creditLedger.filter(e => e.entry_type === 'credit_used' && e.source === 'event_publish');
      const creditsUsed = creditUsedEntries.length;
      const creditPaidEventIds = new Set(creditUsedEntries.map(e => e.reference_id).filter(Boolean));
      const paidEventCount = events.filter(e => e.payment_status === 'paid').length;
      const freeEventCount = events.filter(e => e.payment_status === 'free').length;
      // Stripe-paid events = paid events minus those paid via credits
      const stripePaidCount = Math.max(0, paidEventCount - creditsUsed);
      const stripeRevenue = totalRevenue; // billing_history is the source of truth for real cash

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
          freeEventCredits: profile.free_event_credits || 0,
          purchasedEventCredits: profile.purchased_event_credits || 0,
          createdAt: profile.created_at,
          updatedAt: profile.updated_at,
          isBanned
        },
        financials: {
          stripeRevenue,
          creditsUsed,
          totalPlatformCost,
          totalAiCost,
          chatAiCost,
          themeAiCost,
          totalSmsCost,
          smsSentCount: smsMessages.length,
          generationCount: generations.length,
          chatCount: chatGenerations.length,
          themeCount: themeGenerations.length,
          netMargin: stripeRevenue - totalPlatformCost,
          paidEventCount,
          freeEventCount,
          stripePaidCount,
          costByEvent
        },
        events: events.map(e => ({
          id: e.id,
          title: e.title,
          eventType: e.event_type,
          eventDate: e.event_date,
          status: e.status,
          slug: e.slug,
          paymentStatus: e.payment_status || 'unpaid',
          paidVia: e.payment_status === 'paid' ? (creditPaidEventIds.has(e.id) ? 'credit' : 'stripe') : (e.payment_status === 'free' ? 'free' : 'unpaid'),
          paidAt: e.paid_at,
          revenue: (e.payment_status === 'paid' && !creditPaidEventIds.has(e.id)) ? 4.99 : 0,
          createdAt: e.created_at,
          hasTheme: !!(eventThemeMap[e.id] && eventThemeMap[e.id].hasTheme),
          themeVersions: eventThemeMap[e.id] ? eventThemeMap[e.id].versions : 0,
          rsvps: rsvpCounts[e.id] || { total: 0, attending: 0, declined: 0, maybe: 0 },
          costs: costByEvent[e.id] || { aiCost: 0, smsCost: 0 }
        })),
        subscriptions: (subsRes.data || []).map(s => ({
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
          phase: c.phase,
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
        })),
        notifications: (notifRes.data || []).map(n => ({
          id: n.id,
          eventId: n.event_id,
          channel: n.channel,
          recipient: n.recipient,
          subject: n.subject,
          status: n.status,
          emailType: n.email_type,
          deliveredAt: n.delivered_at,
          openedAt: n.opened_at,
          clickedAt: n.clicked_at,
          bouncedAt: n.bounced_at,
          sentAt: n.sent_at || n.created_at
        }))
      });
    }

    // ---- ADMIN EVENT DETAIL ----
    if (action === 'adminEventDetail') {
      const eventId = req.query.eventId;
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      const [eventRes, themesRes, guestsRes, customFieldsRes, generationsRes, chatRes, ratingSummaryRes] = await Promise.all([
        supabaseAdmin.from('events').select('*').eq('id', eventId).single(),
        supabaseAdmin.from('event_themes').select('id, event_id, version, is_active, html, css, config, model, input_tokens, output_tokens, latency_ms, admin_rating, admin_notes, rated_by, rated_at, prompt_version_id, created_at').eq('event_id', eventId).order('version', { ascending: true }),
        supabaseAdmin.from('guests').select('*').eq('event_id', eventId).order('created_at', { ascending: false }),
        supabaseAdmin.from('event_custom_fields').select('*').eq('event_id', eventId).order('sort_order', { ascending: true }),
        supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, prompt, status, latency_ms, created_at').eq('event_id', eventId).eq('status', 'success').order('created_at', { ascending: false }),
        supabaseAdmin.from('chat_messages').select('id, session_id, role, content, phase, model, input_tokens, output_tokens, created_at').eq('event_id', eventId).order('created_at', { ascending: true }).order('id', { ascending: true }),
        supabaseAdmin.from('theme_rating_summary').select('event_theme_id, total_ratings, avg_rating').eq('event_id', eventId)
      ]);

      const event = eventRes.data;
      if (!event) return res.status(404).json({ error: 'Event not found' });

      // Recover any orphaned messages (event_id=NULL) from the same chat session.
      // A race condition in createDraftEvent() caused early messages to be saved
      // with event_id=NULL while later messages got the correct event_id.
      let allChatMessages = chatRes.data || [];
      if (event.user_id && event.created_at) {
        const knownSessionIds = new Set(allChatMessages.map(m => m.session_id).filter(Boolean));
        let orphanedMessages = [];

        if (knownSessionIds.size > 0) {
          // We have some event-linked messages — find orphans from the same session(s)
          for (const sid of knownSessionIds) {
            const { data: orphans } = await supabaseAdmin
              .from('chat_messages')
              .select('id, session_id, role, content, phase, model, input_tokens, output_tokens, created_at')
              .eq('session_id', sid)
              .eq('user_id', event.user_id)
              .is('event_id', null)
              .order('created_at', { ascending: true })
              .order('id', { ascending: true });
            if (orphans && orphans.length > 0) {
              orphanedMessages.push(...orphans);
            }
          }
        } else {
          // No messages linked at all — use time-window heuristic for old events
          const eventCreated = new Date(event.created_at);
          const windowStart = new Date(eventCreated.getTime() - 2 * 60 * 1000).toISOString();
          const windowEnd = new Date(eventCreated.getTime() + 2 * 60 * 1000).toISOString();

          const { data: seedMessages } = await supabaseAdmin
            .from('chat_messages')
            .select('session_id')
            .eq('user_id', event.user_id)
            .is('event_id', null)
            .gte('created_at', windowStart)
            .lte('created_at', windowEnd)
            .limit(5);

          if (seedMessages && seedMessages.length > 0) {
            const sessionCounts = {};
            seedMessages.forEach(m => { sessionCounts[m.session_id] = (sessionCounts[m.session_id] || 0) + 1; });
            const bestSessionId = Object.entries(sessionCounts).sort((a, b) => b[1] - a[1])[0][0];

            const { data: fullSession } = await supabaseAdmin
              .from('chat_messages')
              .select('id, session_id, role, content, phase, model, input_tokens, output_tokens, created_at')
              .eq('session_id', bestSessionId)
              .eq('user_id', event.user_id)
              .order('created_at', { ascending: true })
              .order('id', { ascending: true });

            if (fullSession && fullSession.length > 0) {
              orphanedMessages = fullSession;
            }
          }
        }

        if (orphanedMessages.length > 0) {
          const existingIds = new Set(allChatMessages.map(m => m.id));
          const newMsgs = orphanedMessages
            .filter(m => !existingIds.has(m.id))
            .map(m => ({ ...m, phase: m.phase || 'create' }));
          allChatMessages = [...newMsgs, ...allChatMessages]
            .sort((a, b) => a.id - b.id);
        }
      }

      // Get owner profile
      const { data: ownerProfile } = await supabaseAdmin.from('profiles').select('id, email, display_name, phone').eq('id', event.user_id).single();

      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
        'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
        'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
        'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
        'claude-opus-4-6':           { input: 15.00, output: 75.00 },
      };

      let totalAiCost = 0;
      const generations = (generationsRes.data || []).map(g => {
        const pricing = MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
        const cost = ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
        totalAiCost += cost;
        return {
          id: g.id,
          model: g.model,
          inputTokens: g.input_tokens,
          outputTokens: g.output_tokens,
          promptType: g.prompt?.startsWith('prompt_test') ? 'test'
            : (g.prompt?.startsWith('QM ') || g.prompt?.startsWith('admin:') || g.prompt?.startsWith('blog:') || g.prompt?.startsWith('publish-verify:')) ? 'internal'
            : g.prompt?.startsWith('chat:') ? 'chat' : 'theme',
          cost,
          latencyMs: g.latency_ms,
          createdAt: g.created_at
        };
      });

      // RSVP summary
      const guests = guestsRes.data || [];
      const rsvpSummary = { total: guests.length, attending: 0, declined: 0, maybe: 0, noResponse: 0 };
      guests.forEach(g => {
        if (g.status === 'attending') rsvpSummary.attending++;
        else if (g.status === 'declined') rsvpSummary.declined++;
        else if (g.status === 'maybe') rsvpSummary.maybe++;
        else rsvpSummary.noResponse++;
      });

      return res.status(200).json({
        success: true,
        event: {
          id: event.id,
          userId: event.user_id,
          title: event.title,
          description: event.description,
          eventType: event.event_type,
          eventDate: event.event_date,
          endDate: event.end_date,
          timezone: event.timezone,
          locationName: event.location_name,
          locationAddress: event.location_address,
          locationUrl: event.location_url,
          dressCode: event.dress_code,
          maxGuests: event.max_guests,
          rsvpDeadline: event.rsvp_deadline,
          slug: event.slug,
          status: event.status,
          paymentStatus: event.payment_status,
          paidAt: event.paid_at,
          settings: event.settings,
          createdAt: event.created_at,
          updatedAt: event.updated_at
        },
        owner: ownerProfile ? {
          id: ownerProfile.id,
          email: ownerProfile.email,
          displayName: ownerProfile.display_name,
          phone: ownerProfile.phone
        } : null,
        themes: (themesRes.data || []).map(t => {
          const rs = (ratingSummaryRes.data || []).find(r => r.event_theme_id === t.id);
          return {
          id: t.id,
          version: t.version,
          isActive: t.is_active,
          html: t.html,
          css: t.css,
          config: t.config,
          model: t.model,
          inputTokens: t.input_tokens,
          outputTokens: t.output_tokens,
          latencyMs: t.latency_ms,
          adminRating: t.admin_rating,
          adminNotes: t.admin_notes,
          ratedBy: t.rated_by,
          ratedAt: t.rated_at,
          promptVersionId: t.prompt_version_id,
          createdAt: t.created_at,
          userAvgRating: rs ? parseFloat(rs.avg_rating) : null,
          userTotalRatings: rs ? rs.total_ratings : 0
        }; }),
        customFields: (customFieldsRes.data || []).map(f => ({
          id: f.id,
          key: f.field_key,
          label: f.label,
          type: f.field_type,
          required: f.is_required,
          options: f.options,
          placeholder: f.placeholder,
          sortOrder: f.sort_order
        })),
        rsvpSummary,
        guests: guests.map(g => ({
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
        })),
        generations,
        totalAiCost,
        chatHistory: allChatMessages.map(c => ({
          id: c.id,
          sessionId: c.session_id,
          role: c.role,
          content: c.content,
          phase: c.phase,
          model: c.model,
          inputTokens: c.input_tokens,
          outputTokens: c.output_tokens,
          createdAt: c.created_at
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
      // Optional date range filter for generation_log
      // Date params are full ISO timestamps with timezone (e.g. '2026-03-13T07:00:00.000Z' for midnight Pacific)
      const statsFrom = req.query.from;
      const statsTo = req.query.to;

      let logsQuery = supabaseAdmin
        .from('generation_log')
        .select('id, event_id, model, input_tokens, output_tokens, latency_ms, created_at, prompt', { count: 'exact' })
        .eq('status', 'success');
      if (statsFrom) logsQuery = logsQuery.gte('created_at', statsFrom);
      if (statsTo) logsQuery = logsQuery.lte('created_at', statsTo);

      // Build date-filtered queries for profiles, events, guests
      let filteredProfilesQuery = supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true });
      let filteredEventsQuery = supabaseAdmin.from('events').select('id, status', { count: 'exact' });
      let filteredGuestsQuery = supabaseAdmin.from('guests').select('id', { count: 'exact', head: true });
      if (statsFrom) {
        filteredProfilesQuery = filteredProfilesQuery.gte('created_at', statsFrom);
        filteredEventsQuery = filteredEventsQuery.gte('created_at', statsFrom);
        filteredGuestsQuery = filteredGuestsQuery.gte('created_at', statsFrom);
      }
      if (statsTo) {
        filteredProfilesQuery = filteredProfilesQuery.lte('created_at', statsTo);
        filteredEventsQuery = filteredEventsQuery.lte('created_at', statsTo);
        filteredGuestsQuery = filteredGuestsQuery.lte('created_at', statsTo);
      }

      // Query actual revenue from billing_history (not markup-based)
      let revenueQuery = supabaseAdmin.from('billing_history').select('amount_cents, created_at').eq('status', 'succeeded');
      if (statsFrom) revenueQuery = revenueQuery.gte('created_at', statsFrom);
      if (statsTo) revenueQuery = revenueQuery.lte('created_at', statsTo);

      const [allUsersRes, allEventsRes, allGuestsRes, filteredUsersRes, filteredEventsRes, filteredGuestsRes, logsRes, revenueRes, allRevenueRes] = await Promise.all([
        // All-time totals (never filtered)
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('events').select('id, status', { count: 'exact' }),
        supabaseAdmin.from('guests').select('id', { count: 'exact', head: true }),
        // Date-filtered counts
        filteredProfilesQuery,
        filteredEventsQuery,
        filteredGuestsQuery,
        // Already date-filtered
        logsQuery,
        // Revenue — filtered and all-time
        revenueQuery,
        supabaseAdmin.from('billing_history').select('amount_cents, created_at').eq('status', 'succeeded')
      ]);

      const allEvents = allEventsRes.data || [];
      const allPublished = allEvents.filter(e => e.status === 'published').length;
      const filteredEvents = filteredEventsRes.data || [];
      const filteredPublished = filteredEvents.filter(e => e.status === 'published').length;

      // Actual revenue from billing_history
      const filteredRevenue = (revenueRes.data || []).reduce((sum, p) => sum + (p.amount_cents || 0), 0);
      const allTimeRevenue = (allRevenueRes.data || []).reduce((sum, p) => sum + (p.amount_cents || 0), 0);

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
      let internalApiCost = 0; // admin/system AI calls (QM diagnosis, blog SEO, style auto-prompt, publish-verify, etc.)
      let chatCount = 0;
      let themeCount = 0;
      let testCount = 0;
      let internalCount = 0;

      // Cost by time period (last 7 days, last 30 days, prior 7 days for comparison)
      const now = Date.now();
      const day7 = now - 7 * 86400000;
      const day14 = now - 14 * 86400000;
      const day30 = now - 30 * 86400000;
      const day60 = now - 60 * 86400000;
      let cost7d = 0, cost30d = 0;
      let costPrev7d = 0, costPrev30d = 0; // comparison periods

      // Latency tracking
      let totalLatencyMs = 0, latencyCount = 0;
      let latency7dMs = 0, latency7dCount = 0;
      let latencyPrev7dMs = 0, latencyPrev7dCount = 0;
      let latency30dMs = 0, latency30dCount = 0;
      let latencyPrev30dMs = 0, latencyPrev30dCount = 0;
      // Latency by type (theme only — chat and tests are much faster, don't mix)
      let themeLatencyMs = 0, themeLatencyCount = 0;
      let themeLatency7dMs = 0, themeLatency7dCount = 0;
      let themeLatencyPrev7dMs = 0, themeLatencyPrev7dCount = 0;

      (logsRes.data || []).forEach(l => {
        const model = l.model || 'unknown';
        if (!tokensByModel[model]) tokensByModel[model] = { generations: 0, inputTokens: 0, outputTokens: 0, cost: 0, chatCount: 0, themeCount: 0, testCount: 0, latencyMs: 0, latencyCount: 0 };
        tokensByModel[model].generations++;
        tokensByModel[model].inputTokens += l.input_tokens || 0;
        tokensByModel[model].outputTokens += l.output_tokens || 0;

        // Track latency per model
        if (l.latency_ms && l.latency_ms > 0) {
          tokensByModel[model].latencyMs += l.latency_ms;
          tokensByModel[model].latencyCount++;
        }

        // Compute cost
        const pricing = MODEL_PRICING[model] || { input: 3.00, output: 15.00 }; // default to Sonnet pricing
        const cost = ((l.input_tokens || 0) * pricing.input + (l.output_tokens || 0) * pricing.output) / 1_000_000;
        tokensByModel[model].cost += cost;
        totalApiCost += cost;

        // Categorize: prompt_test (admin lab), internal (admin/system), chat (event planning), or theme (generation/tweak)
        const isTest = l.prompt && l.prompt.startsWith('prompt_test');
        const isInternal = l.prompt && (l.prompt.startsWith('QM ') || l.prompt.startsWith('admin:') || l.prompt.startsWith('blog:') || l.prompt.startsWith('publish-verify:'));
        const isChat = (l.prompt && l.prompt.startsWith('chat:')) || (!l.event_id && !isTest && !isInternal);
        if (isTest) { testApiCost += cost; testCount++; tokensByModel[model].testCount++; }
        else if (isInternal) { internalApiCost += cost; internalCount++; }
        else if (isChat) { chatApiCost += cost; chatCount++; tokensByModel[model].chatCount++; }
        else { themeApiCost += cost; themeCount++; tokensByModel[model].themeCount++; }

        const ts = new Date(l.created_at).getTime();
        const hasLatency = l.latency_ms && l.latency_ms > 0;

        // Overall latency
        if (hasLatency) {
          totalLatencyMs += l.latency_ms;
          latencyCount++;
        }

        // Current 7d window
        if (ts >= day7) {
          cost7d += cost;
          if (hasLatency) { latency7dMs += l.latency_ms; latency7dCount++; }
          if (!isChat && !isTest && hasLatency) { themeLatency7dMs += l.latency_ms; themeLatency7dCount++; }
        }
        // Previous 7d window (7-14 days ago) for comparison
        else if (ts >= day14) {
          costPrev7d += cost;
          if (hasLatency) { latencyPrev7dMs += l.latency_ms; latencyPrev7dCount++; }
          if (!isChat && !isTest && hasLatency) { themeLatencyPrev7dMs += l.latency_ms; themeLatencyPrev7dCount++; }
        }

        // Current 30d window
        if (ts >= day30) {
          cost30d += cost;
          if (hasLatency) { latency30dMs += l.latency_ms; latency30dCount++; }
        }
        // Previous 30d window (30-60 days ago)
        else if (ts >= day60) {
          costPrev30d += cost;
          if (hasLatency) { latencyPrev30dMs += l.latency_ms; latencyPrev30dCount++; }
        }

        // Theme latency all-time
        if (!isChat && !isTest && hasLatency) {
          themeLatencyMs += l.latency_ms;
          themeLatencyCount++;
        }
      });

      // Revenue by time period
      const allRevData = allRevenueRes.data || [];
      let revenue7d = 0, revenue30d = 0;
      allRevData.forEach(p => {
        const ts = new Date(p.created_at).getTime();
        if (ts >= day7) revenue7d += p.amount_cents || 0;
        if (ts >= day30) revenue30d += p.amount_cents || 0;
      });

      // Compute averages safely
      const avg = (total, count) => count > 0 ? Math.round(total / count) : null;
      const pctChange = (current, previous) => {
        if (previous === 0 || previous === null) return null;
        return Math.round((current - previous) / previous * 100);
      };

      const avgLatency7d = avg(latency7dMs, latency7dCount);
      const avgLatencyPrev7d = avg(latencyPrev7dMs, latencyPrev7dCount);
      const avgThemeLatency7d = avg(themeLatency7dMs, themeLatency7dCount);
      const avgThemeLatencyPrev7d = avg(themeLatencyPrev7dMs, themeLatencyPrev7dCount);

      return res.status(200).json({
        success: true,
        dateFilter: { from: statsFrom || null, to: statsTo || null },
        stats: {
          // All-time totals (never filtered)
          allTime: {
            totalUsers: allUsersRes.count || 0,
            totalEvents: allEventsRes.count || 0,
            publishedEvents: allPublished,
            totalRsvps: allGuestsRes.count || 0
          },
          // Date-filtered activity counts
          filtered: {
            newUsers: filteredUsersRes.count || 0,
            newEvents: filteredEventsRes.count || 0,
            newPublishedEvents: filteredPublished,
            newRsvps: filteredGuestsRes.count || 0,
            generations: logsRes.count || 0,
            chatGenerations: chatCount,
            themeGenerations: themeCount
          },
          // Backward compat (deprecated — use allTime/filtered instead)
          totalUsers: allUsersRes.count || 0,
          totalEvents: allEventsRes.count || 0,
          publishedEvents: allPublished,
          totalRsvps: allGuestsRes.count || 0,
          totalGenerations: logsRes.count || 0,
          tokensByModel,
          costs: {
            apiCostTotal: totalApiCost,
            apiCostChat: chatApiCost,
            apiCostTheme: themeApiCost,
            apiCostTest: testApiCost,
            apiCostInternal: internalApiCost,
            apiCost7d: cost7d,
            apiCost30d: cost30d,
            chatCount,
            themeCount,
            testCount,
            internalCount,
            // Actual revenue from billing_history (real payments, not markup estimates)
            revenueTotal: allTimeRevenue / 100, // cents → dollars
            revenueFiltered: filteredRevenue / 100,
            revenue7d: revenue7d / 100,
            revenue30d: revenue30d / 100,
            // Profitability = actual revenue minus raw API cost
            profitTotal: (allTimeRevenue / 100) - totalApiCost,
            profitFiltered: (filteredRevenue / 100) - totalApiCost,
            profit7d: (revenue7d / 100) - cost7d,
            profit30d: (revenue30d / 100) - cost30d,
            paidEventCount: allRevData.length
          },
          latency: {
            avgMs: avg(totalLatencyMs, latencyCount),
            avg7dMs: avgLatency7d,
            avg30dMs: avg(latency30dMs, latency30dCount),
            themeAvgMs: avg(themeLatencyMs, themeLatencyCount),
            themeAvg7dMs: avgThemeLatency7d,
            count: latencyCount
          },
          trends: {
            cost7dChange: pctChange(cost7d, costPrev7d),
            cost30dChange: pctChange(cost30d, costPrev30d),
            latency7dChange: pctChange(avgLatency7d, avgLatencyPrev7d),
            themeLatency7dChange: pctChange(avgThemeLatency7d, avgThemeLatencyPrev7d),
            gen7dCount: (logsRes.data || []).filter(l => new Date(l.created_at).getTime() >= day7).length,
            genPrev7dCount: (logsRes.data || []).filter(l => { const ts = new Date(l.created_at).getTime(); return ts >= day14 && ts < day7; }).length,
          }
        }
      });
    }

    // ---- STATS DRILLDOWN ----
    if (action === 'statsDrilldown') {
      const metric = req.query.metric;
      const drillFrom = req.query.from;
      const drillTo = req.query.to;
      const LIMIT = 500;

      if (!metric || !['users', 'events', 'rsvps', 'chatGenerations', 'themeGenerations', 'sms', 'revenue'].includes(metric)) {
        return res.status(400).json({ error: 'metric must be one of: users, events, rsvps, chatGenerations, themeGenerations, sms, revenue' });
      }

      // Helper to resolve event_ids to titles
      async function resolveEventTitles(ids) {
        if (!ids.length) return {};
        const { data } = await supabaseAdmin.from('events').select('id, title').in('id', ids);
        const map = {};
        (data || []).forEach(e => { map[e.id] = e.title; });
        return map;
      }

      // Helper to resolve user_ids to emails
      async function resolveUserEmails(ids) {
        if (!ids.length) return {};
        const { data } = await supabaseAdmin.from('profiles').select('id, email, display_name').in('id', ids);
        const map = {};
        (data || []).forEach(u => { map[u.id] = { email: u.email, name: u.display_name }; });
        return map;
      }

      if (metric === 'users') {
        let q = supabaseAdmin.from('profiles').select('id, email, created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(LIMIT);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, count, error } = await q;
        if (error) return res.status(400).json({ error: error.message });
        // Batch-fetch generation counts for these users
        const userIds = (data || []).map(u => u.id);
        let genCounts = {};
        if (userIds.length) {
          const { data: genData } = await supabaseAdmin.rpc('count_generations_by_users', { user_ids: userIds }).catch(() => ({ data: null }));
          // Fallback: query generation_log grouped by user_id
          if (!genData) {
            const { data: genLogs } = await supabaseAdmin.from('generation_log').select('user_id').in('user_id', userIds).eq('status', 'success');
            (genLogs || []).forEach(g => { genCounts[g.user_id] = (genCounts[g.user_id] || 0) + 1; });
          } else {
            (genData || []).forEach(g => { genCounts[g.user_id] = g.count; });
          }
        }
        return res.status(200).json({
          success: true, metric, total: count || 0,
          rows: (data || []).map(u => ({ email: u.email, generations: genCounts[u.id] || 0, createdAt: u.created_at }))
        });
      }

      if (metric === 'events') {
        let q = supabaseAdmin.from('events').select('id, title, user_id, event_type, status, created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(LIMIT);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, count, error } = await q;
        if (error) return res.status(400).json({ error: error.message });
        const userIds = [...new Set((data || []).map(e => e.user_id).filter(Boolean))];
        const userMap = await resolveUserEmails(userIds);
        return res.status(200).json({
          success: true, metric, total: count || 0,
          rows: (data || []).map(e => ({
            id: e.id, title: e.title, creatorEmail: userMap[e.user_id]?.email || '—', creatorName: userMap[e.user_id]?.name || '',
            eventType: e.event_type, status: e.status, createdAt: e.created_at
          }))
        });
      }

      if (metric === 'rsvps') {
        let q = supabaseAdmin.from('guests').select('id, name, email, phone, event_id, status, responded_at, created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(LIMIT);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, count, error } = await q;
        if (error) return res.status(400).json({ error: error.message });
        const eventIds = [...new Set((data || []).map(g => g.event_id).filter(Boolean))];
        const eventMap = await resolveEventTitles(eventIds);
        return res.status(200).json({
          success: true, metric, total: count || 0,
          rows: (data || []).map(g => ({
            name: g.name, email: g.email, phone: g.phone,
            eventTitle: eventMap[g.event_id] || '—', eventId: g.event_id,
            status: g.status, respondedAt: g.responded_at, createdAt: g.created_at
          }))
        });
      }

      if (metric === 'chatGenerations' || metric === 'themeGenerations') {
        // Fetch more rows since we filter in JS
        let q = supabaseAdmin.from('generation_log').select('id, event_id, model, input_tokens, output_tokens, latency_ms, created_at, prompt').eq('status', 'success').order('created_at', { ascending: false }).limit(2000);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, error } = await q;
        if (error) return res.status(400).json({ error: error.message });

        // Same categorization logic as stats endpoint
        const MODEL_PRICING_DRILL = {
          'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
          'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
          'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
          'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
          'claude-opus-4-6':           { input: 15.00, output: 75.00 },
        };

        const filtered = (data || []).filter(l => {
          const isTest = l.prompt && l.prompt.startsWith('prompt_test');
          const isInternal = l.prompt && (l.prompt.startsWith('QM ') || l.prompt.startsWith('admin:') || l.prompt.startsWith('blog:') || l.prompt.startsWith('publish-verify:'));
          const isChat = (l.prompt && l.prompt.startsWith('chat:')) || (!l.event_id && !isTest && !isInternal);
          if (metric === 'chatGenerations') return isChat;
          // themeGenerations: not chat, not test, not internal
          return !isChat && !isTest && !isInternal;
        }).slice(0, LIMIT);

        const eventIds = [...new Set(filtered.map(l => l.event_id).filter(Boolean))];
        const eventMap = await resolveEventTitles(eventIds);

        return res.status(200).json({
          success: true, metric, total: filtered.length,
          rows: filtered.map(l => {
            const pricing = MODEL_PRICING_DRILL[l.model] || { input: 3.00, output: 15.00 };
            const cost = ((l.input_tokens || 0) * pricing.input + (l.output_tokens || 0) * pricing.output) / 1_000_000;
            return {
              eventTitle: eventMap[l.event_id] || (l.event_id ? '(unknown)' : '—'), eventId: l.event_id,
              model: l.model, inputTokens: l.input_tokens || 0, outputTokens: l.output_tokens || 0,
              latencyMs: l.latency_ms, cost, createdAt: l.created_at
            };
          })
        });
      }

      if (metric === 'sms') {
        let q = supabaseAdmin.from('sms_messages').select('id, event_id, recipient_name, recipient_phone, message_type, status, cost_cents, created_at', { count: 'exact' }).order('created_at', { ascending: false }).limit(LIMIT);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, count, error } = await q;
        if (error) return res.status(400).json({ error: error.message });
        const eventIds = [...new Set((data || []).map(m => m.event_id).filter(Boolean))];
        const eventMap = await resolveEventTitles(eventIds);
        return res.status(200).json({
          success: true, metric, total: count || 0,
          rows: (data || []).map(m => ({
            recipientName: m.recipient_name, recipientPhone: m.recipient_phone,
            eventTitle: eventMap[m.event_id] || '—', eventId: m.event_id,
            messageType: m.message_type, status: m.status, costCents: m.cost_cents, createdAt: m.created_at
          }))
        });
      }

      if (metric === 'revenue') {
        let q = supabaseAdmin.from('billing_history').select('id, user_id, event_id, amount_cents, status, description, created_at', { count: 'exact' }).eq('status', 'succeeded').order('created_at', { ascending: false }).limit(LIMIT);
        if (drillFrom) q = q.gte('created_at', drillFrom);
        if (drillTo) q = q.lte('created_at', drillTo);
        const { data, count, error } = await q;
        if (error) return res.status(400).json({ error: error.message });
        const userIds = [...new Set((data || []).map(b => b.user_id).filter(Boolean))];
        const eventIds = [...new Set((data || []).map(b => b.event_id).filter(Boolean))];
        const [userMap, eventMap] = await Promise.all([resolveUserEmails(userIds), resolveEventTitles(eventIds)]);
        return res.status(200).json({
          success: true, metric, total: count || 0,
          rows: (data || []).map(b => ({
            userEmail: userMap[b.user_id]?.email || '—',
            eventTitle: eventMap[b.event_id] || '—', eventId: b.event_id,
            amount: (b.amount_cents || 0) / 100,
            description: b.description, createdAt: b.created_at
          }))
        });
      }
    }

    // ---- GET MODEL CONFIG ----
    if (action === 'getConfig') {
      // Read from app_config table if exists, otherwise return defaults
      const { data } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', ['chat_model', 'theme_model', 'cost_markup_pct', 'sms_cost_cents', 'free_ai_generations']);

      const config = {};
      (data || []).forEach(row => { config[row.key] = row.value; });

      return res.status(200).json({
        success: true,
        config: {
          chatModel: config.chat_model || 'claude-haiku-4-5-20251001',
          themeModel: config.theme_model || 'claude-sonnet-4-6',
          costMarkupPct: parseFloat(config.cost_markup_pct) || 100,
          smsCostCents: parseInt(config.sms_cost_cents) || 3,
          freeAiGenerations: parseInt(config.free_ai_generations) || 2
        }
      });
    }

    // ---- SAVE MODEL CONFIG ----
    if (action === 'saveConfig') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { chatModel, themeModel, costMarkupPct, smsCostCents, freeAiGenerations } = req.body;

      const upserts = [];
      if (chatModel) upserts.push({ key: 'chat_model', value: chatModel, updated_by: admin.id, updated_at: new Date().toISOString() });
      if (themeModel) upserts.push({ key: 'theme_model', value: themeModel, updated_by: admin.id, updated_at: new Date().toISOString() });
      if (costMarkupPct !== undefined) upserts.push({ key: 'cost_markup_pct', value: String(costMarkupPct), updated_by: admin.id, updated_at: new Date().toISOString() });
      if (smsCostCents !== undefined) upserts.push({ key: 'sms_cost_cents', value: String(smsCostCents), updated_by: admin.id, updated_at: new Date().toISOString() });
      if (freeAiGenerations !== undefined) upserts.push({ key: 'free_ai_generations', value: String(Math.max(1, Math.min(10, parseInt(freeAiGenerations) || 2))), updated_by: admin.id, updated_at: new Date().toISOString() });

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

      // Send branded invitation email via Resend
      const origin = req.headers.origin;
      const baseUrl = origin || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://ryvite.com');
      const adminUrl = `${baseUrl}/v2/admin/`;
      const signupUrl = `${baseUrl}/v2/login/?redirect=/v2/admin/`;

      // Get inviter's display name
      const { data: inviterProfile } = await supabaseAdmin
        .from('profiles')
        .select('display_name, email')
        .eq('id', admin.id)
        .single();
      const inviterName = inviterProfile?.display_name || inviterProfile?.email || 'A team member';

      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Ryvite <noreply@ryvite.com>',
          to: newEmail,
          subject: `${inviterName} invited you to the Ryvite admin team`,
          html: `
            <div style="font-family: 'Inter', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #FFFAF5; border-radius: 16px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; color: #1A1A2E;">Ryvite</span>
              </div>
              <div style="background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <h2 style="font-size: 20px; color: #1A1A2E; margin: 0 0 16px;">You've been invited to join the team!</h2>
                <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
                  <strong>${inviterName}</strong> has added you as an <strong>Admin</strong> on Ryvite — the AI-powered invitation platform.
                </p>
                <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
                  As an admin, you'll have access to the full dashboard: user management, AI prompt tuning, generation analytics, marketing tools, and more.
                </p>
                <div style="background: #f8f4f0; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                  <div style="font-size: 14px; color: #1A1A2E; font-weight: 600; margin-bottom: 8px;">Getting started:</div>
                  <div style="font-size: 13px; color: #666; line-height: 1.6;">
                    1. Click the button below to create your account<br>
                    2. Sign in with <strong>${newEmail}</strong><br>
                    3. You'll be redirected to the admin dashboard
                  </div>
                </div>
                <div style="text-align: center; margin-bottom: 16px;">
                  <a href="${signupUrl}" style="display: inline-block; background: #E94560; color: white; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; text-decoration: none;">Create Your Admin Account</a>
                </div>
                <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">
                  Already have a Ryvite account? <a href="${adminUrl}" style="color: #E94560;">Go to Admin Dashboard</a>
                </p>
              </div>
              <p style="color: #bbb; font-size: 11px; text-align: center; margin-top: 20px;">
                Ryvite &mdash; Prompt to Party
              </p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('Failed to send admin invitation email:', emailErr);
        // Don't fail the request — the admin was still added
      }

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
        archivedBy: row.archived_by || null,
        exclude_from_gallery: row.exclude_from_gallery || false
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
        // Update existing item (preserve existing design_group_id)
        const { error } = await supabaseAdmin
          .from('style_library')
          .update(row)
          .eq('id', id);
        if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
      } else {
        // Insert new item — each new style starts its own design group
        row.id = 'style_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        row.added_by = admin.email;
        row.design_group_id = row.id;
        let { error } = await supabaseAdmin
          .from('style_library')
          .insert(row);
        // Retry without design_group_id if column doesn't exist yet
        if (error && error.message?.includes('design_group_id')) {
          delete row.design_group_id;
          ({ error } = await supabaseAdmin.from('style_library').insert(row));
        }
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
          couponType: c.coupon_type || 'discount',
          eventCredits: c.event_credits || 0,
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
        code, description, couponType, eventCredits, discountType, discountValue,
        minPurchaseCents, maxUses, maxUsesPerUser,
        validFrom, validUntil, allowedPlans, allowedEmails, isActive
      } = req.body;

      const effectiveCouponType = couponType || 'discount';
      if (!['discount', 'event_credits', 'both'].includes(effectiveCouponType)) {
        return res.status(400).json({ error: 'couponType must be "discount", "event_credits", or "both"' });
      }

      if (!code) {
        return res.status(400).json({ error: 'Code is required' });
      }

      // Validate discount fields for discount/both types
      if (effectiveCouponType === 'discount' || effectiveCouponType === 'both') {
        if (!discountType || discountValue === undefined) {
          return res.status(400).json({ error: 'discountType and discountValue are required for discount coupons' });
        }
        if (!['percent', 'fixed'].includes(discountType)) {
          return res.status(400).json({ error: 'discountType must be "percent" or "fixed"' });
        }
        if (discountType === 'percent' && (discountValue < 0 || discountValue > 100)) {
          return res.status(400).json({ error: 'Percent discount must be between 0 and 100' });
        }
      }

      // Validate event credits for event_credits/both types
      if ((effectiveCouponType === 'event_credits' || effectiveCouponType === 'both') && (!eventCredits || eventCredits < 1)) {
        return res.status(400).json({ error: 'eventCredits must be at least 1 for event credit coupons' });
      }

      const { data, error } = await supabaseAdmin
        .from('coupons')
        .insert({
          code: code.toUpperCase().trim(),
          description: description || null,
          coupon_type: effectiveCouponType,
          event_credits: eventCredits || 0,
          discount_type: effectiveCouponType === 'event_credits' ? 'fixed' : discountType,
          discount_value: effectiveCouponType === 'event_credits' ? 0 : (discountValue || 0),
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
      if (updates.couponType !== undefined) dbUpdates.coupon_type = updates.couponType;
      if (updates.eventCredits !== undefined) dbUpdates.event_credits = updates.eventCredits;
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
      const smsFrom = req.query.from;
      const smsTo = req.query.to;

      // All-time totals
      const [allCountRes, allCostRes] = await Promise.all([
        supabaseAdmin.from('sms_messages').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('sms_messages').select('cost_cents')
      ]);
      const totalSent = allCountRes.count || 0;
      const totalCostCents = (allCostRes.data || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      // Date-filtered totals
      let filteredSent = totalSent;
      let filteredCostCents = totalCostCents;
      if (smsFrom || smsTo) {
        let fq = supabaseAdmin.from('sms_messages').select('id, cost_cents');
        if (smsFrom) fq = fq.gte('created_at', smsFrom);
        if (smsTo) fq = fq.lte('created_at', smsTo);
        const { data: filteredData } = await fq;
        filteredSent = (filteredData || []).length;
        filteredCostCents = (filteredData || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);
      }

      return res.status(200).json({
        success: true,
        totalSent,
        totalCostCents,
        totalRevenueCents: totalCostCents,
        filtered: {
          sent: filteredSent,
          costCents: filteredCostCents,
          revenueCents: filteredCostCents
        }
      });
    }

    // ---- LIST ALL SUBSCRIPTIONS (admin) ----
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
        // Lab tests in the same session are variations — share a design group
        insertData.design_group_id = testSessionId;
      }
      if (sessionPosition !== undefined) {
        insertData.session_position = sessionPosition;
      }

      let { data: insertedRun, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .insert(insertData)
        .select('id')
        .single();

      // If no session, set design_group_id to own id (needs the inserted id)
      if (!error && insertedRun?.id && !testSessionId) {
        await supabaseAdmin.from('prompt_test_runs')
          .update({ design_group_id: insertedRun.id.toString() })
          .eq('id', insertedRun.id);
      }

      // Retry without new columns if migration hasn't been run
      if (error && (error.message?.includes('style_library_ids') || error.message?.includes('result_thankyou_html') || error.message?.includes('test_session_id') || error.message?.includes('session_position') || error.message?.includes('design_group_id'))) {
        delete insertData.style_library_ids;
        delete insertData.result_thankyou_html;
        delete insertData.test_session_id;
        delete insertData.session_position;
        delete insertData.design_group_id;
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
      let { data: runs, error } = await supabaseAdmin
        .from('prompt_test_runs')
        .select('id, prompt_version_id, model, event_type, score, input_tokens, output_tokens, latency_ms, style_library_ids, test_session_id, created_at')
        .not('score', 'is', null)
        .order('created_at', { ascending: false });

      // Retry without optional columns if migrations haven't been run
      if (error && (error.message?.includes('style_library_ids') || error.message?.includes('test_session_id'))) {
        ({ data: runs, error } = await supabaseAdmin
          .from('prompt_test_runs')
          .select('id, prompt_version_id, model, event_type, score, input_tokens, output_tokens, latency_ms, created_at')
          .not('score', 'is', null)
          .order('created_at', { ascending: false }));
      }

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
        .select('id, event_id, version, is_active, html, css, config, model, input_tokens, output_tokens, latency_ms, admin_rating, admin_notes, rated_by, rated_at, prompt_version_id, created_at, exclude_from_gallery, events!inner(title, event_type, slug, user_id)', { count: 'exact' });

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

    // ---- TOGGLE EXCLUDE FROM GALLERY (inspiration page) ----
    if (action === 'toggleExcludeFromGallery') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { id, source, exclude } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (typeof exclude !== 'boolean') return res.status(400).json({ error: 'exclude must be boolean' });

      const table = source === 'lab' ? 'prompt_test_runs'
                  : source === 'style' ? 'style_library'
                  : 'event_themes';

      const { error } = await supabaseAdmin
        .from(table)
        .update({ exclude_from_gallery: exclude })
        .eq('id', id);

      if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
      return res.status(200).json({ success: true, excluded: exclude });
    }

    // ---- SET DESIGN GROUP (link variations together) ----
    if (action === 'setDesignGroup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { id, source, designGroupId } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!designGroupId) return res.status(400).json({ error: 'designGroupId required' });

      const table = source === 'lab' ? 'prompt_test_runs'
                  : source === 'style' ? 'style_library'
                  : 'event_themes';

      const { error } = await supabaseAdmin
        .from(table)
        .update({ design_group_id: designGroupId })
        .eq('id', id);

      if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
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

    // ---- GRANT FREE EVENT CREDITS ----
    if (action === 'grantFreeEvents') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { userId, credits, reason } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!credits || credits < 1 || !Number.isInteger(credits)) {
        return res.status(400).json({ error: 'credits must be a positive integer' });
      }

      const { data: profile, error: pErr } = await supabaseAdmin
        .from('profiles')
        .select('free_event_credits')
        .eq('id', userId)
        .single();

      if (pErr || !profile) return res.status(404).json({ error: 'User not found' });

      const newBalance = (profile.free_event_credits || 0) + credits;

      const { error: uErr } = await supabaseAdmin
        .from('profiles')
        .update({ free_event_credits: newBalance, updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (uErr) return res.status(400).json({ error: uErr.message });

      return res.status(200).json({
        success: true,
        previousBalance: profile.free_event_credits || 0,
        creditsAdded: credits,
        newBalance,
        reason: reason || null
      });
    }

    // ---- FEATURED SHOWCASES (homepage demo carousel) ----

    if (action === 'listShowcases') {
      const { data, error } = await supabaseAdmin
        .from('featured_showcases')
        .select('*')
        .order('display_order', { ascending: true });
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ success: true, showcases: data || [] });
    }

    if (action === 'featureShowcase') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { sourceType, eventThemeId, testRunId, promptText, eventTitle, eventType } = req.body;

      if (!sourceType) return res.status(400).json({ error: 'sourceType required' });

      // Fetch source HTML/CSS/config
      let html, css, config;
      if (sourceType === 'user_theme') {
        if (!eventThemeId) return res.status(400).json({ error: 'eventThemeId required for user_theme' });
        const { data: theme, error: tErr } = await supabaseAdmin
          .from('event_themes').select('html, css, config').eq('id', eventThemeId).single();
        if (tErr || !theme) return res.status(404).json({ error: 'Theme not found' });
        html = theme.html; css = theme.css; config = theme.config;
      } else if (sourceType === 'lab_theme') {
        if (!testRunId) return res.status(400).json({ error: 'testRunId required for lab_theme' });
        const { data: run, error: rErr } = await supabaseAdmin
          .from('prompt_test_runs').select('result_html, result_css, result_config').eq('id', testRunId).single();
        if (rErr || !run) return res.status(404).json({ error: 'Test run not found' });
        html = run.result_html; css = run.result_css; config = run.result_config;
      } else {
        return res.status(400).json({ error: 'sourceType must be user_theme or lab_theme' });
      }

      if (!html) return res.status(400).json({ error: 'Source has no HTML content' });

      // Auto-generate prompt text from the invite design using Haiku
      let finalPromptText = promptText || '';
      if (!finalPromptText) {
        try {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          // Send a trimmed version of HTML + CSS (first 3000 chars each to stay small)
          const htmlSnippet = (html || '').substring(0, 3000);
          const cssSnippet = (css || '').substring(0, 2000);
          const colorInfo = config ? `Colors: ${JSON.stringify({ primary: config.primaryColor, secondary: config.secondaryColor, accent: config.accentColor, mood: config.mood })}` : '';

          const aiResponse = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{
              role: 'user',
              content: `You're looking at an AI-generated party invitation. Write a short, natural prompt (1-2 sentences, max 120 chars) that a user might type to request this design. Write it as a casual, first-person request — like what someone would actually type into a chat. Don't use quotes. Don't explain what you're doing. Just output the prompt text.

Event type: ${eventType || 'party'}
Event title: ${eventTitle || 'Party'}
${colorInfo}

HTML (excerpt):
${htmlSnippet}

CSS (excerpt):
${cssSnippet}`
            }]
          });

          finalPromptText = (aiResponse.content[0]?.text || '').trim();
          // Log style auto-prompt AI call to generation_log for cost tracking
          await supabaseAdmin.from('generation_log').insert({
            event_id: null, user_id: admin.id,
            prompt: 'admin: style auto-prompt for ' + (eventType || 'unknown'),
            model: 'claude-haiku-4-5-20251001',
            input_tokens: aiResponse.usage?.input_tokens || 0,
            output_tokens: aiResponse.usage?.output_tokens || 0,
            latency_ms: 0, status: 'success', is_tweak: false
          }).catch(e => console.error('Style auto-prompt generation_log insert failed:', e.message));
        } catch (aiErr) {
          console.error('Auto-prompt generation failed, using fallback:', aiErr.message);
          finalPromptText = eventTitle || 'A beautiful custom invitation';
        }
      }

      // Get next display_order
      const { data: maxRow } = await supabaseAdmin
        .from('featured_showcases')
        .select('display_order')
        .order('display_order', { ascending: false })
        .limit(1);
      const nextOrder = (maxRow && maxRow.length > 0) ? maxRow[0].display_order + 1 : 0;

      const insertData = {
        source_type: sourceType,
        event_theme_id: sourceType === 'user_theme' ? eventThemeId : null,
        test_run_id: sourceType === 'lab_theme' ? testRunId : null,
        prompt_text: finalPromptText,
        display_order: nextOrder,
        html: html,
        css: css || '',
        config: config || {},
        event_title: eventTitle || '',
        event_type: eventType || 'other',
        created_by: admin.email
      };

      const { data: inserted, error: iErr } = await supabaseAdmin
        .from('featured_showcases').insert(insertData).select('id').single();
      if (iErr) return res.status(500).json({ error: 'Failed to feature: ' + iErr.message });

      return res.status(200).json({ success: true, showcaseId: inserted.id, promptText: finalPromptText });
    }

    if (action === 'removeShowcase') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { showcaseId } = req.body;
      if (!showcaseId) return res.status(400).json({ error: 'showcaseId required' });

      const { error } = await supabaseAdmin.from('featured_showcases').delete().eq('id', showcaseId);
      if (error) return res.status(500).json({ error: 'Failed to remove: ' + error.message });
      return res.status(200).json({ success: true });
    }

    if (action === 'updateShowcase') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { showcaseId, promptText, displayOrder } = req.body;
      if (!showcaseId) return res.status(400).json({ error: 'showcaseId required' });

      const updates = {};
      if (promptText !== undefined) updates.prompt_text = promptText;
      if (displayOrder !== undefined) updates.display_order = displayOrder;

      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

      const { error } = await supabaseAdmin.from('featured_showcases').update(updates).eq('id', showcaseId);
      if (error) return res.status(500).json({ error: 'Failed to update: ' + error.message });
      return res.status(200).json({ success: true });
    }

    // ---- Deactivate / Reactivate User ----

    if (action === 'deactivateUser') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      // Prevent deactivating yourself
      if (userId === admin.id) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }

      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: '876000h' // ~100 years
      });

      if (error) return res.status(500).json({ error: 'Failed to deactivate user: ' + error.message });
      return res.status(200).json({ success: true });
    }

    if (action === 'reactivateUser') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: 'none'
      });

      if (error) return res.status(500).json({ error: 'Failed to reactivate user: ' + error.message });
      return res.status(200).json({ success: true });
    }

    // ---- Admin Notification Preferences ----

    if (action === 'getAdminNotifPrefs') {
      const { data: prefs } = await supabaseAdmin
        .from('admin_notification_prefs')
        .select('phone, new_user_signup')
        .eq('admin_user_id', admin.id)
        .maybeSingle();

      if (prefs) {
        return res.status(200).json({ success: true, prefs });
      }

      // No prefs yet — return defaults, pre-populate phone from profile
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('phone')
        .eq('id', admin.id)
        .single();

      return res.status(200).json({
        success: true,
        prefs: {
          phone: profile?.phone || '',
          new_user_signup: false
        }
      });
    }

    if (action === 'updateAdminNotifPrefs') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { phone, new_user_signup } = req.body || {};

      // Validate phone
      if (!phone || typeof phone !== 'string') {
        return res.status(400).json({ error: 'Phone number is required' });
      }
      const digits = phone.replace(/\D/g, '');
      const normalized = digits.length >= 10 ? digits.slice(-10) : null;
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number — must be a 10-digit US number' });
      }

      const { error } = await supabaseAdmin
        .from('admin_notification_prefs')
        .upsert({
          admin_user_id: admin.id,
          phone: normalized,
          new_user_signup: new_user_signup !== false
        }, { onConflict: 'admin_user_id' });

      if (error) {
        return res.status(500).json({ error: 'Failed to save preferences: ' + error.message });
      }

      return res.status(200).json({ success: true });
    }

    if (action === 'sendTestNotification') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      // Check ClickSend credentials
      const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
      const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
      if (!CLICKSEND_USERNAME || !CLICKSEND_API_KEY) {
        return res.status(500).json({
          success: false,
          error: 'ClickSend credentials not configured — CLICKSEND_USERNAME and CLICKSEND_API_KEY environment variables are required'
        });
      }

      // Get admin's notification phone
      const { data: prefs } = await supabaseAdmin
        .from('admin_notification_prefs')
        .select('phone')
        .eq('admin_user_id', admin.id)
        .maybeSingle();

      const phone = prefs?.phone;
      if (!phone) {
        return res.status(400).json({
          success: false,
          error: 'No phone number saved — save your notification preferences first'
        });
      }

      const digits = phone.replace(/\D/g, '');
      const e164 = digits.length >= 10 ? `+1${digits.slice(-10)}` : null;
      if (!e164) {
        return res.status(400).json({
          success: false,
          error: 'Invalid phone number in notification preferences'
        });
      }

      const testBody = `Ryvite test notification — if you're reading this, admin SMS notifications are working!`;
      const credentials = Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64');

      try {
        const csResp = await fetch('https://rest.clicksend.com/v3/sms/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${credentials}`
          },
          body: JSON.stringify({
            messages: [{ to: e164, body: testBody, source: 'ryvite-admin-test' }]
          })
        });

        const csResult = await csResp.json();
        const csMsg = csResult.data?.messages?.[0];

        // Log to notification_log
        await supabaseAdmin.from('notification_log').insert({
          channel: 'sms',
          recipient: digits.slice(-10),
          status: csMsg?.status === 'SUCCESS' ? 'sent' : 'failed',
          provider_id: csMsg?.message_id || null,
          error: csMsg?.status !== 'SUCCESS' ? (csMsg?.status || 'unknown') : null,
          sent_at: new Date().toISOString()
        });

        if (csMsg?.status === 'SUCCESS') {
          return res.status(200).json({ success: true, message: 'Test notification sent!' });
        } else {
          return res.status(500).json({
            success: false,
            error: `ClickSend returned status: ${csMsg?.status || 'unknown'}`,
            detail: csMsg
          });
        }
      } catch (fetchErr) {
        return res.status(500).json({
          success: false,
          error: 'Failed to reach ClickSend API: ' + fetchErr.message
        });
      }
    }

    // ---- QUALITY DASHBOARD ----
    if (action === 'qualityDashboard') {
      const days = parseInt(req.query.days) || 30;
      const since = new Date(Date.now() - days * 86400000).toISOString();

      // Incidents by trigger type
      const { data: incidents } = await supabaseAdmin
        .from('quality_incidents')
        .select('trigger_type, resolution_type, created_at')
        .gte('created_at', since);

      const byTrigger = {};
      const byResolution = {};
      let totalIncidents = 0;
      let autoHealed = 0;
      let unresolved = 0;

      (incidents || []).forEach(i => {
        totalIncidents++;
        byTrigger[i.trigger_type] = (byTrigger[i.trigger_type] || 0) + 1;
        byResolution[i.resolution_type] = (byResolution[i.resolution_type] || 0) + 1;
        if (i.resolution_type === 'auto_healed') autoHealed++;
        if (i.resolution_type === 'unresolved') unresolved++;
      });

      // Top users with incidents
      const { data: userIncidents } = await supabaseAdmin
        .from('quality_incidents')
        .select('user_id')
        .gte('created_at', since)
        .not('user_id', 'is', null);

      const userCounts = {};
      (userIncidents || []).forEach(i => {
        userCounts[i.user_id] = (userCounts[i.user_id] || 0) + 1;
      });
      const topUsers = Object.entries(userCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([userId, count]) => ({ userId, count }));

      // Fetch emails for top users
      if (topUsers.length > 0) {
        const { data: profiles } = await supabaseAdmin
          .from('profiles')
          .select('id, email')
          .in('id', topUsers.map(u => u.userId));
        const emailMap = {};
        (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
        topUsers.forEach(u => { u.email = emailMap[u.userId] || null; });
      }

      return res.status(200).json({
        success: true,
        dashboard: {
          period: days + 'd',
          totalIncidents,
          autoHealed,
          unresolved,
          autoHealRate: totalIncidents > 0 ? Math.round(autoHealed / totalIncidents * 100) : 0,
          byTrigger,
          byResolution,
          topUsers
        }
      });
    }

    // ---- LIST QUALITY INCIDENTS ----
    if (action === 'listQualityIncidents') {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      let query = supabaseAdmin
        .from('quality_incidents')
        .select('id, event_id, event_theme_id, user_id, trigger_type, trigger_data, ai_diagnosis, resolution_type, resolution_data, resolved_at, created_at', { count: 'exact' });

      if (req.query.triggerType) query = query.eq('trigger_type', req.query.triggerType);
      if (req.query.resolutionType) query = query.eq('resolution_type', req.query.resolutionType);
      if (req.query.userId) query = query.eq('user_id', req.query.userId);
      if (req.query.eventId) query = query.eq('event_id', req.query.eventId);

      query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) return res.status(400).json({ error: error.message });

      // Enrich with user emails and event titles
      const userIds = [...new Set((data || []).map(i => i.user_id).filter(Boolean))];
      const eventIds = [...new Set((data || []).map(i => i.event_id).filter(Boolean))];

      let emailMap = {};
      let eventMap = {};

      if (userIds.length > 0) {
        const { data: profiles } = await supabaseAdmin
          .from('profiles')
          .select('id, email')
          .in('id', userIds);
        (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
      }

      if (eventIds.length > 0) {
        const { data: events } = await supabaseAdmin
          .from('events')
          .select('id, title')
          .in('id', eventIds);
        (events || []).forEach(e => { eventMap[e.id] = e.title; });
      }

      const enriched = (data || []).map(i => ({
        ...i,
        userEmail: emailMap[i.user_id] || null,
        eventTitle: eventMap[i.event_id] || null
      }));

      return res.status(200).json({
        success: true,
        incidents: enriched,
        total: count,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
      });
    }

    // ---- GET INCIDENT DETAIL ----
    if (action === 'getIncidentDetail') {
      const incidentId = req.query.incidentId;
      if (!incidentId) return res.status(400).json({ error: 'incidentId required' });

      const { data: incident, error } = await supabaseAdmin
        .from('quality_incidents')
        .select('*')
        .eq('id', incidentId)
        .single();

      if (error) return res.status(404).json({ error: 'Incident not found' });

      // Enrich with user info
      let userInfo = null;
      if (incident.user_id) {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id, email, display_name, tier')
          .eq('id', incident.user_id)
          .single();
        userInfo = profile || null;
      }

      // Enrich with event info
      let eventInfo = null;
      if (incident.event_id) {
        const { data: event } = await supabaseAdmin
          .from('events')
          .select('id, title, event_type, status, created_at')
          .eq('id', incident.event_id)
          .single();
        eventInfo = event || null;
      }

      return res.status(200).json({
        success: true,
        incident: {
          ...incident,
          userInfo,
          eventInfo
        }
      });
    }

    // ---- QUALITY BY BROWSER ----
    if (action === 'resolveIncident') {
      const { incidentId, resolutionType, notes } = req.body;
      if (!incidentId || !resolutionType) return res.status(400).json({ error: 'incidentId and resolutionType required' });
      const validTypes = ['admin_reviewed', 'escalated', 'auto_healed'];
      if (!validTypes.includes(resolutionType)) return res.status(400).json({ error: 'Invalid resolutionType' });

      const { error } = await supabaseAdmin
        .from('quality_incidents')
        .update({
          resolution_type: resolutionType,
          resolution_data: { admin_action: true, notes: notes || null, resolved_by: 'admin', resolved_at: new Date().toISOString() },
          resolved_at: new Date().toISOString()
        })
        .eq('id', incidentId);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    if (action === 'resetIncident') {
      const { incidentId } = req.body;
      if (!incidentId) return res.status(400).json({ error: 'incidentId required' });

      await supabaseAdmin.from('quality_incidents').update({
        resolution_type: 'unresolved',
        resolution_data: null,
        ai_diagnosis: null,
        resolved_at: null
      }).eq('id', incidentId);

      return res.status(200).json({ success: true });
    }

    if (action === 'qualityByBrowser') {
      const { data, error } = await supabaseAdmin
        .from('quality_incidents')
        .select('trigger_type, resolution_type, client_meta')
        .not('client_meta', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString());

      if (error) return res.status(400).json({ error: error.message });

      // Aggregate by browser + device class
      const breakdown = {};
      (data || []).forEach(i => {
        const ua = i.client_meta?.user_agent || '';
        const sw = parseInt(i.client_meta?.screen_width) || 0;
        let browser = 'Other';
        if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
        else if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
        else if (ua.includes('Edg')) browser = 'Edge';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('SamsungBrowser')) browser = 'Samsung';

        let device = 'Desktop';
        if (sw > 0 && sw <= 430) device = 'Mobile';
        else if (sw > 0 && sw <= 1024) device = 'Tablet';

        const key = browser + '|' + device;
        if (!breakdown[key]) breakdown[key] = { browser, device, total: 0, healed: 0, unresolved: 0, byTrigger: {} };
        breakdown[key].total++;
        if (i.resolution_type === 'auto_healed') breakdown[key].healed++;
        if (i.resolution_type === 'unresolved') breakdown[key].unresolved++;
        breakdown[key].byTrigger[i.trigger_type] = (breakdown[key].byTrigger[i.trigger_type] || 0) + 1;
      });

      return res.status(200).json({
        success: true,
        browserBreakdown: Object.values(breakdown).sort((a, b) => b.total - a.total)
      });
    }

    // ---- LIST SUGGESTED RULES ----
    if (action === 'listSuggestedRules') {
      const status = req.query.status || 'pending';
      let query = supabaseAdmin
        .from('suggested_rules')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (status !== 'all') query = query.eq('status', status);

      const { data, error } = await query;
      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ success: true, rules: data || [] });
    }

    // ---- REVIEW SUGGESTED RULE (apply/dismiss/flag) ----
    if (action === 'reviewSuggestedRule' && req.method === 'POST') {
      const { ruleId, status, dismissReason } = req.body;
      if (!ruleId || !status) return res.status(400).json({ error: 'ruleId and status required' });

      const validStatuses = ['applied', 'dismissed', 'needs_deploy'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

      const updates = {
        status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString()
      };
      if (status === 'dismissed' && dismissReason) updates.dismiss_reason = dismissReason;

      // If applying, append the rule to the active prompt version's creative_direction
      if (status === 'applied') {
        // Get the rule text
        const { data: rule } = await supabaseAdmin
          .from('suggested_rules')
          .select('suggested_text')
          .eq('id', ruleId)
          .single();

        if (rule) {
          // Get active prompt version
          const { data: activePrompt } = await supabaseAdmin
            .from('prompt_versions')
            .select('id, creative_direction')
            .eq('is_active', true)
            .single();

          if (activePrompt) {
            const updatedDirection = (activePrompt.creative_direction || '') + '\n\n## Auto-applied quality rule\n' + rule.suggested_text;
            await supabaseAdmin
              .from('prompt_versions')
              .update({ creative_direction: updatedDirection })
              .eq('id', activePrompt.id);
            updates.applied_to_prompt_version = activePrompt.id;
          }
        }
      }

      const { error } = await supabaseAdmin
        .from('suggested_rules')
        .update(updates)
        .eq('id', ruleId);

      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // ---- QUALITY ROOT CAUSE PATTERNS ----
    if (action === 'qualityPatterns') {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: incidents } = await supabaseAdmin
        .from('quality_incidents')
        .select('trigger_type, trigger_data, ai_diagnosis, resolution_type, client_meta, event_id, created_at')
        .not('ai_diagnosis', 'is', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);

      // Group by trigger_type and common patterns
      const patterns = {};
      (incidents || []).forEach(i => {
        const key = i.trigger_type;
        if (!patterns[key]) patterns[key] = { trigger_type: key, count: 0, last_24h: 0, last_7d: 0, events: new Set(), browsers: new Set() };
        patterns[key].count++;
        const age = Date.now() - new Date(i.created_at).getTime();
        if (age < 86400000) patterns[key].last_24h++;
        if (age < 7 * 86400000) patterns[key].last_7d++;
        if (i.event_id) patterns[key].events.add(i.event_id);
        const ua = i.client_meta?.user_agent || '';
        if (ua.includes('Safari') && !ua.includes('Chrome')) patterns[key].browsers.add('Safari');
        else if (ua.includes('Chrome')) patterns[key].browsers.add('Chrome');
        else if (ua.includes('Firefox')) patterns[key].browsers.add('Firefox');
      });

      const patternList = Object.values(patterns).map(p => ({
        ...p,
        events: p.events.size,
        browsers: [...p.browsers]
      })).sort((a, b) => b.last_7d - a.last_7d);

      return res.status(200).json({ success: true, patterns: patternList });
    }

    // ── Viral Loop / Growth Reporting ──
    if (action === 'viralStats') {
      const fromParam = req.query.from || null;
      const toParam = req.query.to || null;
      const from = fromParam ? new Date(fromParam).toISOString() : null;
      const to = toParam ? new Date(toParam).toISOString() : new Date().toISOString();

      // 1. Page views
      let pageViewQuery = supabaseAdmin.from('viral_events').select('*', { count: 'exact', head: true }).eq('event_type', 'page_view');
      if (from) pageViewQuery = pageViewQuery.gte('created_at', from);
      if (to) pageViewQuery = pageViewQuery.lte('created_at', to);
      const pageViewRes = await pageViewQuery;

      // 2. RSVPs submitted
      let rsvpQuery = supabaseAdmin.from('guests').select('*', { count: 'exact', head: true }).in('status', ['attending', 'declined', 'maybe']);
      if (from) rsvpQuery = rsvpQuery.gte('responded_at', from);
      if (to) rsvpQuery = rsvpQuery.lte('responded_at', to);
      const rsvpRes = await rsvpQuery;

      // 3. Footer CTA clicks
      let footerQuery = supabaseAdmin.from('viral_events').select('*', { count: 'exact', head: true }).eq('event_type', 'footer_click');
      if (from) footerQuery = footerQuery.gte('created_at', from);
      if (to) footerQuery = footerQuery.lte('created_at', to);
      const footerRes = await footerQuery;

      // 4. RSVP CTA clicks
      let rsvpCtaQuery = supabaseAdmin.from('viral_events').select('*', { count: 'exact', head: true }).eq('event_type', 'rsvp_cta_click');
      if (from) rsvpCtaQuery = rsvpCtaQuery.gte('created_at', from);
      if (to) rsvpCtaQuery = rsvpCtaQuery.lte('created_at', to);
      const rsvpCtaRes = await rsvpCtaQuery;

      // 5. New signups from invite pages (UTM source = 'invite')
      let signupQuery = supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }).not('signup_utm', 'is', null).filter('signup_utm->>source', 'eq', 'invite');
      if (from) signupQuery = signupQuery.gte('created_at', from);
      if (to) signupQuery = signupQuery.lte('created_at', to);
      const signupRes = await signupQuery;

      // 6. Total hosts (users with published events) in same period
      let hostsQuery = supabaseAdmin.from('events').select('user_id', { count: 'exact' }).eq('status', 'published');
      if (from) hostsQuery = hostsQuery.gte('published_at', from);
      if (to) hostsQuery = hostsQuery.lte('published_at', to);
      const hostsRes = await hostsQuery;
      // Deduplicate host user_ids
      const uniqueHosts = hostsRes.data ? new Set(hostsRes.data.map(e => e.user_id)).size : 0;

      const inviteSignups = signupRes.count || 0;
      const kFactor = uniqueHosts > 0 ? Math.round((inviteSignups / uniqueHosts) * 100) / 100 : 0;

      // 7. Top referring events — events with most page views
      let topEventsQuery = supabaseAdmin.from('viral_events').select('event_id').eq('event_type', 'page_view').not('event_id', 'is', null);
      if (from) topEventsQuery = topEventsQuery.gte('created_at', from);
      if (to) topEventsQuery = topEventsQuery.lte('created_at', to);
      const topEventsRes = await topEventsQuery;

      // Aggregate page views by event_id
      const eventViewCounts = {};
      (topEventsRes.data || []).forEach(row => {
        eventViewCounts[row.event_id] = (eventViewCounts[row.event_id] || 0) + 1;
      });
      const topEventIds = Object.entries(eventViewCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, views]) => ({ id, views }));

      // Fetch event details for top events
      let topReferringEvents = [];
      if (topEventIds.length > 0) {
        const { data: eventDetails } = await supabaseAdmin
          .from('events')
          .select('id, title, user_id, event_type')
          .in('id', topEventIds.map(e => e.id));

        // Fetch host names
        const hostIds = [...new Set((eventDetails || []).map(e => e.user_id))];
        let hostMap = {};
        if (hostIds.length > 0) {
          const { data: hosts } = await supabaseAdmin
            .from('profiles')
            .select('id, email, display_name')
            .in('id', hostIds);
          (hosts || []).forEach(h => { hostMap[h.id] = h.display_name || h.email; });
        }

        topReferringEvents = topEventIds.map(te => {
          const ev = (eventDetails || []).find(e => e.id === te.id);
          return {
            eventId: te.id,
            title: ev ? ev.title : 'Unknown',
            host: ev ? (hostMap[ev.user_id] || 'Unknown') : 'Unknown',
            eventType: ev ? ev.event_type : null,
            pageViews: te.views
          };
        });
      }

      return res.status(200).json({
        success: true,
        stats: {
          pageViews: pageViewRes.count || 0,
          rsvpsSubmitted: rsvpRes.count || 0,
          footerClicks: footerRes.count || 0,
          rsvpCtaClicks: rsvpCtaRes.count || 0,
          inviteSignups,
          activeHosts: uniqueHosts,
          kFactor,
          topReferringEvents
        }
      });
    }

    // ── REVIEW MANAGEMENT ──

    // List reviews with filters
    if (action === 'listReviews') {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const statusFilter = req.query.statusFilter || '';
      const offset = (page - 1) * limit;

      let query = supabaseAdmin
        .from('reviews')
        .select(`
          id, user_id, event_id, event_theme_id, rating, headline, body,
          reviewer_name, is_anonymous, status, event_type, admin_notes,
          moderated_by, moderated_at, created_at, updated_at,
          profiles(email, display_name),
          events(title, event_date, slug),
          event_themes(html, css, config)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (statusFilter && ['pending', 'approved', 'featured', 'rejected'].includes(statusFilter)) {
        query = query.eq('status', statusFilter);
      }

      const { data, error, count } = await query;
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({
        success: true,
        reviews: data || [],
        total: count || 0,
        page,
        limit
      });
    }

    // Moderate a review (change status)
    if (action === 'moderateReview' && req.method === 'POST') {
      const { reviewId, status, notes } = req.body;
      if (!reviewId || !status) return res.status(400).json({ error: 'reviewId and status required' });
      if (!['pending', 'approved', 'featured', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const updateData = {
        status,
        moderated_by: admin.email,
        moderated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (notes !== undefined) updateData.admin_notes = notes;

      const { data, error } = await supabaseAdmin
        .from('reviews')
        .update(updateData)
        .eq('id', reviewId)
        .select('id, status')
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, review: data });
    }

    // Delete a review
    if (action === 'deleteReview' && req.method === 'POST') {
      const { reviewId } = req.body;
      if (!reviewId) return res.status(400).json({ error: 'reviewId required' });

      const { error } = await supabaseAdmin.from('reviews').delete().eq('id', reviewId);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // Review stats
    if (action === 'reviewStats') {
      const { data: reviews } = await supabaseAdmin
        .from('reviews')
        .select('rating, status');

      const { data: requests } = await supabaseAdmin
        .from('review_requests')
        .select('status');

      const all = reviews || [];
      const reqs = requests || [];
      const stats = {
        totalReviews: all.length,
        avgRating: all.length > 0 ? Math.round(all.reduce((a, r) => a + r.rating, 0) / all.length * 100) / 100 : 0,
        pendingCount: all.filter(r => r.status === 'pending').length,
        approvedCount: all.filter(r => r.status === 'approved').length,
        featuredCount: all.filter(r => r.status === 'featured').length,
        rejectedCount: all.filter(r => r.status === 'rejected').length,
        totalRequests: reqs.length,
        completedRequests: reqs.filter(r => r.status === 'completed').length,
        conversionRate: reqs.length > 0
          ? Math.round(reqs.filter(r => r.status === 'completed').length / reqs.length * 100)
          : 0
      };

      return res.status(200).json({ success: true, stats });
    }

    // Manually send a review request for an event
    if (action === 'sendReviewRequest' && req.method === 'POST') {
      const { eventId } = req.body;
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      // Check if request already exists
      const { data: existing } = await supabaseAdmin
        .from('review_requests')
        .select('id, status')
        .eq('event_id', eventId)
        .single();

      if (existing) {
        return res.status(400).json({ error: 'Review request already exists for this event', request: existing });
      }

      // Get event + host info
      const { data: event, error: evErr } = await supabaseAdmin
        .from('events')
        .select('id, title, user_id, event_type')
        .eq('id', eventId)
        .single();

      if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, display_name')
        .eq('id', event.user_id)
        .single();

      if (!profile?.email) return res.status(400).json({ error: 'No email found for event host' });

      const token = crypto.randomUUID();

      // Create request
      await supabaseAdmin.from('review_requests').insert({
        user_id: event.user_id,
        event_id: eventId,
        token,
        status: 'sent',
        sent_at: new Date().toISOString()
      });

      // Send email using configurable template
      const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
      if (resend) {
        const reviewUrl = `https://www.ryvite.com/v2/review/?token=${token}`;
        const firstName = profile.display_name?.split(' ')[0] || 'there';

        // Load configurable settings
        const settingKeys = ['review_email_subject', 'review_email_headline', 'review_email_body', 'review_email_cta_text', 'review_email_footer_note'];
        const { data: configData } = await supabaseAdmin.from('app_config').select('key, value').in('key', settingKeys);
        const cm = {};
        (configData || []).forEach(row => { cm[row.key] = row.value; });

        const replaceVars = (str) => str.replace(/\{\{eventTitle\}\}/g, event.title).replace(/\{\{firstName\}\}/g, firstName);
        const subject = replaceVars(cm.review_email_subject || 'How was {{eventTitle}}? Share your experience!');
        const headline = replaceVars(cm.review_email_headline || 'How was {{eventTitle}}?');
        const bodyText = replaceVars(cm.review_email_body || 'We hope your event was amazing! We\'d love to hear about your experience using Ryvite. Your feedback helps other hosts discover what\'s possible.\n\nIt only takes a minute — just tap below to leave a quick review.');
        const ctaText = replaceVars(cm.review_email_cta_text || 'Leave a Review');
        const footerNote = replaceVars(cm.review_email_footer_note || 'Your review may be featured on our site to help other event planners.');
        const bodyHtml = bodyText.split('\n').filter(p => p.trim()).map(p => `<p style="margin:0 0 16px;font-size:15px;color:#555;line-height:1.6;">${p}</p>`).join('\n    ');

        const emailResult = await resend.emails.send({
          from: 'Ryvite <hello@ryvite.com>',
          to: profile.email,
          subject,
          html: buildReviewEmailFromSettings(firstName, headline, bodyHtml, ctaText, footerNote, reviewUrl)
        });

        // Log to notification_log for engagement tracking
        await supabaseAdmin.from('notification_log').insert({
          event_id: eventId,
          user_id: event.user_id,
          channel: 'email',
          recipient: profile.email,
          subject,
          status: 'sent',
          provider_id: emailResult?.data?.id || null,
          email_type: 'review_request',
          sent_at: new Date().toISOString()
        }).catch(() => {});
      }

      return res.status(200).json({ success: true, token });
    }

    // ── REVIEW EMAIL SETTINGS ──

    // Get review email settings from app_config
    if (action === 'getReviewEmailSettings') {
      const keys = [
        'review_email_enabled',
        'review_email_delay_days',
        'review_reminder_enabled',
        'review_reminder_delay_days',
        'review_email_subject',
        'review_email_headline',
        'review_email_body',
        'review_email_cta_text',
        'review_email_footer_note',
        'review_reminder_subject',
        'review_reminder_headline',
        'review_reminder_body',
        'review_reminder_cta_text',
        'review_reminder_footer_note'
      ];

      const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', keys);

      if (error) return res.status(500).json({ error: error.message });

      // Build settings object with defaults
      const configMap = {};
      (data || []).forEach(row => { configMap[row.key] = row.value; });

      const settings = {
        // Schedule
        emailEnabled: configMap.review_email_enabled !== 'false',
        delayDays: parseInt(configMap.review_email_delay_days) || 1,
        reminderEnabled: configMap.review_reminder_enabled !== 'false',
        reminderDelayDays: parseInt(configMap.review_reminder_delay_days) || 7,
        // Initial email
        emailSubject: configMap.review_email_subject || 'How was {{eventTitle}}? Share your experience!',
        emailHeadline: configMap.review_email_headline || 'How was {{eventTitle}}?',
        emailBody: configMap.review_email_body || 'We hope your event was amazing! We\'d love to hear about your experience using Ryvite. Your feedback helps other hosts discover what\'s possible.\n\nIt only takes a minute — just tap below to leave a quick review.',
        emailCtaText: configMap.review_email_cta_text || 'Tap a star to rate your experience:',
        emailFooterNote: configMap.review_email_footer_note || 'Your review may be featured on our site to help other event planners.',
        // Reminder email
        reminderSubject: configMap.review_reminder_subject || 'We\'d love to hear about {{eventTitle}}!',
        reminderHeadline: configMap.review_reminder_headline || 'We\'d still love to hear from you!',
        reminderBody: configMap.review_reminder_body || 'A little while ago you hosted {{eventTitle}} with Ryvite. We\'d really appreciate hearing about your experience — it helps us improve and helps other hosts discover what\'s possible.\n\nIt only takes a minute!',
        reminderCtaText: configMap.review_reminder_cta_text || 'Tap a star to rate your experience:',
        reminderFooterNote: configMap.review_reminder_footer_note || 'Your review may be featured on our site to help other event planners.'
      };

      return res.status(200).json({ success: true, settings });
    }

    // Save review email settings
    if (action === 'saveReviewEmailSettings' && req.method === 'POST') {
      const s = req.body;
      if (!s) return res.status(400).json({ error: 'Settings body required' });

      const keyMap = {
        emailEnabled: 'review_email_enabled',
        delayDays: 'review_email_delay_days',
        reminderEnabled: 'review_reminder_enabled',
        reminderDelayDays: 'review_reminder_delay_days',
        emailSubject: 'review_email_subject',
        emailHeadline: 'review_email_headline',
        emailBody: 'review_email_body',
        emailCtaText: 'review_email_cta_text',
        emailFooterNote: 'review_email_footer_note',
        reminderSubject: 'review_reminder_subject',
        reminderHeadline: 'review_reminder_headline',
        reminderBody: 'review_reminder_body',
        reminderCtaText: 'review_reminder_cta_text',
        reminderFooterNote: 'review_reminder_footer_note'
      };

      const upserts = [];
      for (const [field, dbKey] of Object.entries(keyMap)) {
        if (s[field] !== undefined) {
          upserts.push({
            key: dbKey,
            value: String(s[field]),
            updated_by: admin.id,
            updated_at: new Date().toISOString()
          });
        }
      }

      if (upserts.length > 0) {
        const { error } = await supabaseAdmin
          .from('app_config')
          .upsert(upserts, { onConflict: 'key' });
        if (error) return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({ success: true });
    }

    // Preview review email — renders template with sample data
    if (action === 'previewReviewEmail') {
      const emailType = req.query.type || 'initial'; // 'initial' or 'reminder'

      // Load settings
      const keys = emailType === 'reminder'
        ? ['review_reminder_subject', 'review_reminder_headline', 'review_reminder_body', 'review_reminder_cta_text', 'review_reminder_footer_note']
        : ['review_email_subject', 'review_email_headline', 'review_email_body', 'review_email_cta_text', 'review_email_footer_note'];

      const { data } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', keys);

      const configMap = {};
      (data || []).forEach(row => { configMap[row.key] = row.value; });

      let headline, body, ctaText, footerNote;
      if (emailType === 'reminder') {
        headline = configMap.review_reminder_headline || 'We\'d still love to hear from you!';
        body = configMap.review_reminder_body || 'A little while ago you hosted {{eventTitle}} with Ryvite. We\'d really appreciate hearing about your experience — it helps us improve and helps other hosts discover what\'s possible.\n\nIt only takes a minute!';
        ctaText = configMap.review_reminder_cta_text || 'Tap a star to rate your experience:';
        footerNote = configMap.review_reminder_footer_note || 'Your review may be featured on our site to help other event planners.';
      } else {
        headline = configMap.review_email_headline || 'How was {{eventTitle}}?';
        body = configMap.review_email_body || 'We hope your event was amazing! We\'d love to hear about your experience using Ryvite. Your feedback helps other hosts discover what\'s possible.\n\nIt only takes a minute — just tap below to leave a quick review.';
        ctaText = configMap.review_email_cta_text || 'Tap a star to rate your experience:';
        footerNote = configMap.review_email_footer_note || 'Your review may be featured on our site to help other event planners.';
      }

      // Replace template vars with sample data
      const sampleEvent = 'Emma\'s 5th Birthday Party';
      const sampleFirst = 'Sarah';
      const sampleUrl = 'https://www.ryvite.com/v2/review/?token=sample-preview';

      const replaceVars = (str) => str
        .replace(/\{\{eventTitle\}\}/g, sampleEvent)
        .replace(/\{\{firstName\}\}/g, sampleFirst)
        .replace(/\{\{reviewUrl\}\}/g, sampleUrl);

      headline = replaceVars(headline);
      const bodyParagraphs = replaceVars(body).split('\n').filter(p => p.trim()).map(
        p => `<p style="margin:0 0 16px;font-size:15px;color:#555;line-height:1.6;">${p}</p>`
      ).join('\n    ');
      ctaText = replaceVars(ctaText);
      footerNote = replaceVars(footerNote);

      const html = buildReviewEmailFromSettings(sampleFirst, headline, bodyParagraphs, ctaText, footerNote, sampleUrl);
      return res.status(200).json({ success: true, html, sampleData: { eventTitle: sampleEvent, firstName: sampleFirst } });
    }

    // ---- FUNNEL ANALYTICS ----
    if (action === 'funnelAnalytics') {
      const from = req.query.from || null;
      const to = req.query.to || null;
      const filterPayment = req.query.paymentStatus || null;   // 'free', 'paid', 'unpaid', 'coupon'
      const filterUtmSource = req.query.utmSource || null;     // e.g. 'facebook', 'google'
      const filterEventType = req.query.eventType || null;     // e.g. 'wedding', 'birthday'
      const filterTier = req.query.tier || null;               // 'free', 'per_event'

      // 1. Funnel stage counts
      let eventsQuery = supabaseAdmin.from('events').select('id, user_id, status, event_type, payment_status, settings, created_at, published_at, first_generation_at, generations_to_publish, updated_at');
      let profilesQuery = supabaseAdmin.from('profiles').select('id, created_at, tier, utm_source, utm_campaign, utm_medium, free_event_credits, purchased_event_credits');
      let guestsQuery = supabaseAdmin.from('guests').select('id, event_id, status, responded_at');

      if (from) {
        eventsQuery = eventsQuery.gte('created_at', from);
        profilesQuery = profilesQuery.gte('created_at', from);
      }
      if (to) {
        eventsQuery = eventsQuery.lte('created_at', to);
        profilesQuery = profilesQuery.lte('created_at', to);
      }
      if (filterPayment) {
        if (filterPayment === 'coupon') {
          // Coupon users: have free_event_credits > 0 — filter on profiles after fetch
        } else {
          eventsQuery = eventsQuery.eq('payment_status', filterPayment);
        }
      }
      if (filterEventType) {
        eventsQuery = eventsQuery.eq('event_type', filterEventType);
      }
      if (filterTier) {
        profilesQuery = profilesQuery.eq('tier', filterTier);
      }

      const [eventsRes, profilesRes, guestsRes, chatMsgsRes] = await Promise.all([
        eventsQuery,
        profilesQuery,
        guestsQuery,
        supabaseAdmin.from('chat_messages').select('id, user_id, session_id, event_id, role, content, phase, created_at').order('created_at', { ascending: true })
      ]);

      let events = eventsRes.data || [];
      let profiles = profilesRes.data || [];
      const guests = guestsRes.data || [];
      const chatMsgs = chatMsgsRes.data || [];

      // Apply cross-table filters
      if (filterTier) {
        // Restrict events to users matching the tier filter
        const tierUserIds = new Set(profiles.map(p => p.id));
        events = events.filter(e => tierUserIds.has(e.user_id));
      }
      if (filterUtmSource) {
        // Restrict to users with matching utm_source
        profiles = profiles.filter(p => p.utm_source && p.utm_source.toLowerCase() === filterUtmSource.toLowerCase());
        const utmUserIds = new Set(profiles.map(p => p.id));
        events = events.filter(e => utmUserIds.has(e.user_id));
      }
      if (filterPayment === 'coupon') {
        // Coupon users have free_event_credits > 0 granted via coupons
        const couponUserIds = new Set(profiles.filter(p => (p.free_event_credits || 0) > 0).map(p => p.id));
        events = events.filter(e => couponUserIds.has(e.user_id));
        profiles = profiles.filter(p => couponUserIds.has(p.id));
      }

      // Collect distinct values for filter dropdowns
      const allEventsForOptions = eventsRes.data || [];
      const allProfilesForOptions = profilesRes.data || [];
      const distinctEventTypes = [...new Set(allEventsForOptions.map(e => e.event_type).filter(Boolean))].sort();
      const distinctUtmSources = [...new Set(allProfilesForOptions.map(p => p.utm_source).filter(Boolean))].sort();
      const distinctPaymentStatuses = [...new Set(allEventsForOptions.map(e => e.payment_status).filter(Boolean))].sort();

      // Stage counts
      const totalSignups = profiles.length;
      const totalEventsCreated = events.length;
      const totalGenerated = events.filter(e => e.first_generation_at).length;
      const totalPublished = events.filter(e => e.status === 'published').length;
      const totalInvitesSent = events.filter(e => e.status === 'published' && e.settings?.invites_sent).length;
      const eventIdsWithRsvps = new Set(guests.filter(g => ['attending', 'declined', 'maybe'].includes(g.status)).map(g => g.event_id));
      const totalWithRsvps = eventIdsWithRsvps.size;

      const funnelStages = [
        { stage: 'Signups', count: totalSignups },
        { stage: 'Events Created', count: totalEventsCreated },
        { stage: 'Design Generated', count: totalGenerated },
        { stage: 'Published', count: totalPublished },
        { stage: 'Invites Sent', count: totalInvitesSent },
        { stage: 'RSVPs Received', count: totalWithRsvps }
      ];

      // 2. Drop-off by creation step (draft events only)
      const draftEvents = events.filter(e => e.status !== 'published');
      const stepDistribution = {};
      const stepLabels = { '0': 'Template Selected', '1': 'Chat / Details', '2': 'Design Preview', '3': 'Guest List' };
      draftEvents.forEach(e => {
        const step = String(e.settings?.creation_step || '0');
        stepDistribution[step] = (stepDistribution[step] || 0) + 1;
      });
      const dropOffByStep = Object.entries(stepLabels).map(([step, label]) => ({
        step, label, count: stepDistribution[step] || 0
      }));

      // 3. Chat engagement analysis
      // Group chat messages by session
      const sessionMap = {};
      chatMsgs.forEach(m => {
        const sid = m.session_id || m.event_id || 'unknown';
        if (!sessionMap[sid]) sessionMap[sid] = { userId: m.user_id, eventId: m.event_id, messages: [], userMessages: 0, phase: m.phase || 'create' };
        sessionMap[sid].messages.push(m);
        if (m.role === 'user') sessionMap[sid].userMessages++;
      });

      // Create a map of user -> published status
      const userPublished = {};
      events.forEach(e => {
        if (e.status === 'published') userPublished[e.user_id] = true;
      });

      // Chat stats for create phase
      const createSessions = Object.values(sessionMap).filter(s => s.phase === 'create' || !s.phase);
      const publishedSessions = createSessions.filter(s => userPublished[s.userId]);
      const droppedSessions = createSessions.filter(s => !userPublished[s.userId]);

      const avgMsgsPublished = publishedSessions.length > 0
        ? Math.round(10 * publishedSessions.reduce((s, x) => s + x.userMessages, 0) / publishedSessions.length) / 10
        : 0;
      const avgMsgsDropped = droppedSessions.length > 0
        ? Math.round(10 * droppedSessions.reduce((s, x) => s + x.userMessages, 0) / droppedSessions.length) / 10
        : 0;

      // Message count distribution (histogram buckets)
      const msgBuckets = { '1': 0, '2': 0, '3': 0, '4-5': 0, '6-10': 0, '11+': 0 };
      createSessions.forEach(s => {
        const n = s.userMessages;
        if (n <= 1) msgBuckets['1']++;
        else if (n === 2) msgBuckets['2']++;
        else if (n === 3) msgBuckets['3']++;
        else if (n <= 5) msgBuckets['4-5']++;
        else if (n <= 10) msgBuckets['6-10']++;
        else msgBuckets['11+']++;
      });

      // 4. Last messages from dropped users (most recent dropped sessions)
      const droppedLastMsgs = droppedSessions
        .filter(s => s.messages.length > 0)
        .map(s => {
          const lastUserMsg = [...s.messages].reverse().find(m => m.role === 'user');
          return {
            userId: s.userId,
            messageCount: s.userMessages,
            lastMessage: lastUserMsg ? lastUserMsg.content.substring(0, 200) : '',
            lastActivityAt: s.messages[s.messages.length - 1].created_at
          };
        })
        .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
        .slice(0, 25);

      // 5. Generations-to-publish distribution
      const gtpEvents = events.filter(e => e.generations_to_publish != null);
      const gtpBuckets = { '1': 0, '2': 0, '3': 0, '4-5': 0, '6-10': 0, '11+': 0 };
      gtpEvents.forEach(e => {
        const n = e.generations_to_publish;
        if (n <= 1) gtpBuckets['1']++;
        else if (n === 2) gtpBuckets['2']++;
        else if (n === 3) gtpBuckets['3']++;
        else if (n <= 5) gtpBuckets['4-5']++;
        else if (n <= 10) gtpBuckets['6-10']++;
        else gtpBuckets['11+']++;
      });
      const avgGtp = gtpEvents.length > 0
        ? Math.round(10 * gtpEvents.reduce((s, e) => s + e.generations_to_publish, 0) / gtpEvents.length) / 10
        : 0;
      const firstTryPct = gtpEvents.length > 0
        ? Math.round(1000 * gtpEvents.filter(e => e.generations_to_publish === 1).length / gtpEvents.length) / 10
        : 0;

      // 6. Time-to-publish stats
      const publishedEvents = events.filter(e => e.published_at && e.created_at);
      let avgMinutesToPublish = 0;
      let medianMinutesToPublish = 0;
      let avgMinutesToFirstGen = 0;
      if (publishedEvents.length > 0) {
        const ttps = publishedEvents.map(e => (new Date(e.published_at) - new Date(e.created_at)) / 60000);
        avgMinutesToPublish = Math.round(10 * ttps.reduce((s, v) => s + v, 0) / ttps.length) / 10;
        const sorted = [...ttps].sort((a, b) => a - b);
        medianMinutesToPublish = Math.round(10 * sorted[Math.floor(sorted.length / 2)]) / 10;

        const genEvents = publishedEvents.filter(e => e.first_generation_at);
        if (genEvents.length > 0) {
          avgMinutesToFirstGen = Math.round(10 * genEvents.reduce((s, e) => s + (new Date(e.first_generation_at) - new Date(e.created_at)) / 60000, 0) / genEvents.length) / 10;
        }
      }

      // 7. Event type breakdown
      const byType = {};
      events.forEach(e => {
        const t = e.event_type || 'unknown';
        if (!byType[t]) byType[t] = { created: 0, generated: 0, published: 0, avgGtp: [] };
        byType[t].created++;
        if (e.first_generation_at) byType[t].generated++;
        if (e.status === 'published') byType[t].published++;
        if (e.generations_to_publish != null) byType[t].avgGtp.push(e.generations_to_publish);
      });
      const eventTypeBreakdown = Object.entries(byType)
        .map(([type, d]) => ({
          eventType: type,
          created: d.created,
          generated: d.generated,
          published: d.published,
          genRate: d.created > 0 ? Math.round(1000 * d.generated / d.created) / 10 : 0,
          publishRate: d.created > 0 ? Math.round(1000 * d.published / d.created) / 10 : 0,
          avgGtp: d.avgGtp.length > 0 ? Math.round(10 * d.avgGtp.reduce((s, v) => s + v, 0) / d.avgGtp.length) / 10 : null
        }))
        .sort((a, b) => b.created - a.created);

      // 8. Weekly trends (last 12 weeks)
      const now = new Date();
      const weeklyTrends = [];
      for (let i = 11; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay() - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const ws = weekStart.toISOString();
        const we = weekEnd.toISOString();

        weeklyTrends.push({
          weekStart: ws,
          label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          signups: profiles.filter(p => p.created_at >= ws && p.created_at < we).length,
          eventsCreated: events.filter(e => e.created_at >= ws && e.created_at < we).length,
          generated: events.filter(e => e.first_generation_at && e.first_generation_at >= ws && e.first_generation_at < we).length,
          published: events.filter(e => e.published_at && e.published_at >= ws && e.published_at < we).length
        });
      }

      // 9. Design chat engagement (tweak analysis)
      const designSessions = Object.values(sessionMap).filter(s => s.phase === 'design');
      const avgDesignMsgs = designSessions.length > 0
        ? Math.round(10 * designSessions.reduce((s, x) => s + x.userMessages, 0) / designSessions.length) / 10
        : 0;

      // 10. Stale/abandoned events (created > 24h ago, still draft, no generation)
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const abandonedCount = events.filter(e => e.status === 'draft' && !e.first_generation_at && e.created_at < oneDayAgo).length;

      return res.status(200).json({
        success: true,
        funnel: {
          stages: funnelStages,
          dropOffByStep,
          chatEngagement: {
            avgMsgsPublished,
            avgMsgsDropped,
            avgDesignMsgs,
            msgDistribution: msgBuckets,
            totalCreateSessions: createSessions.length,
            totalDesignSessions: designSessions.length
          },
          droppedLastMessages: droppedLastMsgs,
          generationsToPublish: {
            distribution: gtpBuckets,
            avgGtp,
            firstTryPct,
            totalWithData: gtpEvents.length
          },
          timeToPublish: {
            avgMinutes: avgMinutesToPublish,
            medianMinutes: medianMinutesToPublish,
            avgMinutesToFirstGen,
            totalPublished: publishedEvents.length
          },
          eventTypeBreakdown,
          weeklyTrends,
          abandonedCount,
          overallConversion: totalSignups > 0
            ? Math.round(1000 * totalPublished / totalSignups) / 10
            : 0,
          filterOptions: {
            eventTypes: distinctEventTypes,
            utmSources: distinctUtmSources,
            paymentStatuses: distinctPaymentStatuses
          }
        }
      });
    }

    // ── CUSTOMER LIFECYCLE / TOUCHPOINT ANALYTICS ──

    // Get funnel metrics for all email touchpoint types
    if (action === 'touchpointAnalytics') {
      // Parse date range from query params
      const startDate = req.query.startDate || null;
      const endDate = req.query.endDate || null;

      // 1. Per-type funnel from notification_log
      let funnelQuery = supabaseAdmin
        .from('notification_log')
        .select('email_type, channel, status, delivered_at, opened_at, clicked_at, bounced_at, sent_at');
      if (startDate) funnelQuery = funnelQuery.gte('sent_at', startDate);
      if (endDate) funnelQuery = funnelQuery.lte('sent_at', endDate + 'T23:59:59.999Z');

      const { data: funnel, error: funnelErr } = await funnelQuery;

      // 2. Review request pipeline
      let reviewReqQuery = supabaseAdmin
        .from('review_requests')
        .select('status, sent_at, reminder_sent_at, completed_at');
      if (startDate) reviewReqQuery = reviewReqQuery.gte('sent_at', startDate);
      if (endDate) reviewReqQuery = reviewReqQuery.lte('sent_at', endDate + 'T23:59:59.999Z');

      const { data: reviewReqs } = await reviewReqQuery;

      // 3. Draft abandonment conversion: did events get published after nudge?
      let abandonQuery = supabaseAdmin
        .from('notification_log')
        .select('event_id, sent_at')
        .eq('email_type', 'abandonment_nudge');
      if (startDate) abandonQuery = abandonQuery.gte('sent_at', startDate);
      if (endDate) abandonQuery = abandonQuery.lte('sent_at', endDate + 'T23:59:59.999Z');

      const { data: abandonmentNudges } = await abandonQuery;

      let abandonmentConversions = 0;
      if (abandonmentNudges && abandonmentNudges.length > 0) {
        const nudgedEventIds = abandonmentNudges.map(n => n.event_id).filter(Boolean);
        if (nudgedEventIds.length > 0) {
          const { count } = await supabaseAdmin
            .from('events')
            .select('id', { count: 'exact', head: true })
            .in('id', nudgedEventIds)
            .eq('status', 'published');
          abandonmentConversions = count || 0;
        }
      }

      // Aggregate funnel by email_type + channel
      const funnelMap = {};
      for (const row of (funnel || [])) {
        const type = row.email_type || (row.channel === 'sms' ? 'sms_other' : 'email_other');
        const key = type + ':' + row.channel;
        if (!funnelMap[key]) {
          funnelMap[key] = { type, channel: row.channel, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 };
        }
        funnelMap[key].sent++;
        if (row.delivered_at) funnelMap[key].delivered++;
        if (row.opened_at) funnelMap[key].opened++;
        if (row.clicked_at) funnelMap[key].clicked++;
        if (row.bounced_at) funnelMap[key].bounced++;
        if (row.status === 'failed') funnelMap[key].failed++;
      }

      // Calculate rates
      const touchpoints = Object.values(funnelMap).map(t => ({
        ...t,
        deliveryRate: t.sent > 0 ? Math.round(t.delivered / t.sent * 1000) / 10 : 0,
        openRate: t.delivered > 0 ? Math.round(t.opened / t.delivered * 1000) / 10 : 0,
        clickRate: t.opened > 0 ? Math.round(t.clicked / t.opened * 1000) / 10 : 0,
        bounceRate: t.sent > 0 ? Math.round(t.bounced / t.sent * 1000) / 10 : 0
      }));

      // Review pipeline
      const reqs = reviewReqs || [];
      const reviewPipeline = {
        totalRequests: reqs.length,
        sent: reqs.filter(r => ['sent', 'reminded', 'completed'].includes(r.status)).length,
        reminded: reqs.filter(r => ['reminded', 'completed'].includes(r.status)).length,
        completed: reqs.filter(r => r.status === 'completed').length,
        conversionRate: reqs.length > 0
          ? Math.round(reqs.filter(r => r.status === 'completed').length / reqs.length * 1000) / 10
          : 0
      };

      // Abandonment pipeline
      const abandonmentPipeline = {
        nudgesSent: (abandonmentNudges || []).length,
        converted: abandonmentConversions,
        conversionRate: (abandonmentNudges || []).length > 0
          ? Math.round(abandonmentConversions / (abandonmentNudges || []).length * 1000) / 10
          : 0
      };

      // Daily trend (uses date range, defaults to last 30 days)
      const trendStart = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      let trendQuery = supabaseAdmin
        .from('notification_log')
        .select('email_type, channel, sent_at, delivered_at, opened_at, clicked_at')
        .order('sent_at', { ascending: true });
      trendQuery = trendQuery.gte('sent_at', trendStart);
      if (endDate) trendQuery = trendQuery.lte('sent_at', endDate + 'T23:59:59.999Z');

      const { data: recentLogs } = await trendQuery;

      const dailyTrend = {};
      for (const row of (recentLogs || [])) {
        const day = row.sent_at?.substring(0, 10);
        if (!day) continue;
        if (!dailyTrend[day]) dailyTrend[day] = { day, sent: 0, delivered: 0, opened: 0, clicked: 0 };
        dailyTrend[day].sent++;
        if (row.delivered_at) dailyTrend[day].delivered++;
        if (row.opened_at) dailyTrend[day].opened++;
        if (row.clicked_at) dailyTrend[day].clicked++;
      }

      // Overall totals — split email vs SMS
      const allRows = funnel || [];
      const emailRows = allRows.filter(r => r.channel === 'email');
      const smsRows = allRows.filter(r => r.channel === 'sms');
      const totalSent = allRows.length;
      const totalEmails = emailRows.length;
      const totalSms = smsRows.length;
      const totalDelivered = allRows.filter(r => r.delivered_at).length;
      const totalOpened = allRows.filter(r => r.opened_at).length;
      const totalClicked = allRows.filter(r => r.clicked_at).length;

      return res.status(200).json({
        success: true,
        overview: {
          totalSent,
          totalEmails,
          totalSms,
          totalDelivered,
          totalOpened,
          totalClicked,
          overallDeliveryRate: totalEmails > 0 ? Math.round(totalDelivered / totalEmails * 1000) / 10 : 0,
          overallOpenRate: totalDelivered > 0 ? Math.round(totalOpened / totalDelivered * 1000) / 10 : 0,
          overallClickRate: totalOpened > 0 ? Math.round(totalClicked / totalOpened * 1000) / 10 : 0
        },
        touchpoints,
        reviewPipeline,
        abandonmentPipeline,
        dailyTrend: Object.values(dailyTrend)
      });
    }

    // ---- CLIENT ERROR STATS ----
    if (action === 'clientErrorStats') {
      const fromDate = req.query.from || new Date(new Date().setHours(0,0,0,0)).toISOString();
      const toDate = req.query.to || new Date().toISOString();

      const { data: summary } = await supabaseAdmin
        .from('client_error_log')
        .select('error_type, component, funnel_step, error_message, created_at')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(500);

      const errors = summary || [];
      const total = errors.length;

      // Group by error_type + component
      const byTypeComponent = {};
      const byStep = {};

      for (const e of errors) {
        const key = (e.error_type || 'unknown') + '|' + (e.component || 'unknown');
        if (!byTypeComponent[key]) byTypeComponent[key] = { error_type: e.error_type, component: e.component, count: 0, sample_message: e.error_message };
        byTypeComponent[key].count++;

        if (e.funnel_step) {
          if (!byStep[e.funnel_step]) byStep[e.funnel_step] = { step: e.funnel_step, count: 0 };
          byStep[e.funnel_step].count++;
        }
      }

      return res.status(200).json({
        success: true,
        total: total,
        by_type_component: Object.values(byTypeComponent).sort((a, b) => b.count - a.count),
        by_funnel_step: Object.values(byStep).sort((a, b) => b.count - a.count),
        recent_errors: errors.slice(0, 20).map(e => ({
          error_type: e.error_type,
          component: e.component,
          funnel_step: e.funnel_step,
          message: (e.error_message || '').slice(0, 200),
          created_at: e.created_at
        }))
      });
    }

    // ---- SERVER ERROR STATS ----
    if (action === 'serverErrorStats') {
      const fromDate = req.query.from || new Date(new Date().setHours(0,0,0,0)).toISOString();
      const toDate = req.query.to || new Date().toISOString();

      const { data: errors } = await supabaseAdmin
        .from('api_error_log')
        .select('endpoint, action, error_message, created_at')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(500);

      const rows = errors || [];
      const grouped = {};
      let total = 0;

      for (const e of rows) {
        total++;
        const key = (e.endpoint || '') + '|' + (e.action || '') + '|' + (e.error_message || '').slice(0, 100);
        if (!grouped[key]) grouped[key] = { endpoint: e.endpoint, action: e.action, error_message: e.error_message, count: 0, last_seen: e.created_at };
        grouped[key].count++;
      }

      return res.status(200).json({
        success: true,
        total: total,
        errors: Object.values(grouped).sort((a, b) => b.count - a.count)
      });
    }

    // ---- SMS DELIVERY STATS ----
    if (action === 'smsDeliveryStats') {
      const fromDate = req.query.from || new Date(new Date().setHours(0,0,0,0)).toISOString();
      const toDate = req.query.to || new Date().toISOString();

      const { data: allSms } = await supabaseAdmin
        .from('sms_messages')
        .select('status, carrier, country, provider_status, provider_error, created_at')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(1000);

      const msgs = allSms || [];
      const totalSent = msgs.length;
      const delivered = msgs.filter(m => m.status === 'delivered').length;
      const deliveryRate = totalSent > 0 ? Math.round(100 * delivered / totalSent) : null;

      // Group by carrier
      const byCarrier = {};
      for (const m of msgs) {
        const key = (m.carrier || 'Unknown') + '|' + (m.country || '');
        if (!byCarrier[key]) byCarrier[key] = { carrier: m.carrier || 'Unknown', country: m.country || '', total_sent: 0, delivered: 0, failed: 0, bounced: 0, pending: 0 };
        byCarrier[key].total_sent++;
        if (m.status === 'delivered') byCarrier[key].delivered++;
        else if (m.status === 'failed') byCarrier[key].failed++;
        else if (m.status === 'bounced') byCarrier[key].bounced++;
        else byCarrier[key].pending++;
      }
      for (const c of Object.values(byCarrier)) {
        c.delivery_rate_pct = c.total_sent > 0 ? Math.round(100 * c.delivered / c.total_sent) : null;
      }

      // Group by status + provider_status
      const byStatus = {};
      for (const m of msgs) {
        const key = (m.status || '') + '|' + (m.provider_status || '') + '|' + (m.provider_error || '');
        if (!byStatus[key]) byStatus[key] = { status: m.status, provider_status: m.provider_status, provider_error: m.provider_error, count: 0 };
        byStatus[key].count++;
      }

      return res.status(200).json({
        success: true,
        delivery_rate_pct: deliveryRate,
        total_sent: totalSent,
        total_delivered: delivered,
        by_carrier: Object.values(byCarrier).sort((a, b) => b.total_sent - a.total_sent),
        by_status: Object.values(byStatus).sort((a, b) => b.count - a.count)
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin API error:', err);
    await reportApiError({ endpoint: '/api/v2/admin', action: req.query?.action || 'unknown', error: err, requestBody: req.body, req }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function buildStarRatingHtml(reviewUrl, promptText) {
  const prompt = promptText || 'Tap a star to rate your experience:';
  const starPath = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
  let html = `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 4px;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#1A1A2E;">${prompt}</p>
    </td></tr><tr><td align="center">
      <table cellpadding="0" cellspacing="0" style="display:inline-table;"><tr>`;
  for (let i = 1; i <= 5; i++) {
    const url = reviewUrl + (reviewUrl.includes('?') ? '&' : '?') + 'rating=' + i;
    html += `<td style="padding:0 4px;" align="center">
          <a href="${url}" style="text-decoration:none;display:inline-block;" title="${i} star${i > 1 ? 's' : ''}">
            <svg width="40" height="40" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${starPath}" fill="#FFB74D" stroke="#E8A33D" stroke-width="0.5"/></svg>
          </a>
        </td>`;
  }
  html += `</tr><tr>`;
  for (let i = 1; i <= 5; i++) {
    html += `<td align="center" style="padding:2px 4px 0;"><span style="font-size:11px;color:#888;">${i}</span></td>`;
  }
  html += `</tr></table></td></tr></table>`;
  return html;
}

function buildReviewEmailFromSettings(firstName, headline, bodyHtml, ctaText, footerNote, reviewUrl) {
  const starsHtml = buildStarRatingHtml(reviewUrl, ctaText);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#E94560,#FF6B6B);padding:32px 32px 24px;text-align:center;">
    <div style="margin-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#fff;letter-spacing:0.5px;">Ryvite</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${headline}</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;line-height:1.6;">Hey ${firstName},</p>
    ${bodyHtml}
    ${starsHtml}
    <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:1.5;text-align:center;">${footerNote}</p>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
    <p style="margin:0;font-size:12px;color:#aaa;">Ryvite — AI-Powered Custom Invitations</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildReviewRequestEmail(firstName, eventTitle, reviewUrl) {
  const starsHtml = buildStarRatingHtml(reviewUrl);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#E94560,#FF6B6B);padding:32px 32px 24px;text-align:center;">
    <div style="margin-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#fff;letter-spacing:0.5px;">Ryvite</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">How was ${eventTitle}?</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;line-height:1.6;">Hey ${firstName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#555;line-height:1.6;">We hope your event was amazing! We'd love to hear about your experience using Ryvite. Your feedback helps other hosts discover what's possible.</p>
    <p style="margin:0 0 8px;font-size:15px;color:#555;line-height:1.6;">It only takes a minute — tap a star below:</p>
    ${starsHtml}
    <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:1.5;text-align:center;">Your review may be featured on our site to help other event planners.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
    <p style="margin:0;font-size:12px;color:#aaa;">Ryvite — AI-Powered Custom Invitations</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
