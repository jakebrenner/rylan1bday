import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Disable body parsing so we can access raw body for Stripe webhook signature verification
export const config = {
  api: { bodyParser: false }
};

const PROD_URL = 'https://ryvite.com';

function getBaseUrl(req) {
  const origin = req.parsedBody?.origin || req.headers.origin;
  if (origin) return origin;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : PROD_URL;
}

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function getOrCreateStripeCustomer(user) {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, display_name, phone')
    .eq('id', user.id)
    .single();

  // If we have a stored customer ID, verify it still exists in Stripe
  // (it may reference a different/old Stripe account)
  if (profile?.stripe_customer_id) {
    try {
      await stripe.customers.retrieve(profile.stripe_customer_id);
      return profile.stripe_customer_id;
    } catch (e) {
      // Customer doesn't exist in current Stripe account — create a new one
      console.warn('Stale stripe_customer_id for user', user.id, '— creating new customer');
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: profile?.display_name || '',
    metadata: { supabase_user_id: user.id }
  });

  await supabaseAdmin
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', user.id);

  return customer.id;
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function parseBody(req) {
  const rawBody = await getRawBody(req);
  req.rawBody = rawBody;
  try {
    req.parsedBody = JSON.parse(rawBody.toString());
  } catch {
    req.parsedBody = {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ---- STRIPE WEBHOOK ----
  if (action === 'webhook') {
    return handleWebhook(req, res);
  }

  // Parse body for all non-webhook requests
  await parseBody(req);
  // Make parsed body accessible as req.body for downstream code
  req.body = req.parsedBody;

  try {
    // ---- GET PLANS (public) ----
    if (action === 'plans') {
      // If slug is provided, fetch that specific plan (for hidden plan signup links)
      const slug = req.query.slug;
      let query = supabaseAdmin.from('plans').select('*').eq('is_active', true);
      if (slug) {
        query = query.eq('name', slug);
      } else {
        // Public listing: exclude hidden plans
        query = query.or('is_hidden.is.null,is_hidden.eq.false');
      }
      query = query.order('sort_order', { ascending: true });

      const { data: plans, error } = await query;

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
          billingType: p.billing_type || 'fixed',
          aiMarkupPct: p.ai_markup_pct || 50,
          maxEvents: p.max_events,
          maxGenerations: p.max_generations,
          smsPriceCents: p.sms_price_cents || 5,
          features: p.features || [],
          isHidden: p.is_hidden || false
        }))
      });
    }

    // ---- VALIDATE COUPON (public, but needs plan context) ----
    if (action === 'validateCoupon') {
      const { code, planName } = req.query;
      if (!code) return res.status(400).json({ error: 'Coupon code required' });

      const user = await getUser(req);
      const result = await validateCoupon(code, planName, user?.id, user?.email);

      if (!result.valid) {
        return res.status(400).json({ success: false, error: result.error });
      }

      return res.status(200).json({
        success: true,
        coupon: {
          id: result.coupon.id,
          code: result.coupon.code,
          discountType: result.coupon.discount_type,
          discountValue: Number(result.coupon.discount_value),
          description: result.coupon.description
        },
        discount: result.discount
      });
    }

    // ---- STRIPE CONFIG (public) ----
    if (action === 'config') {
      return res.status(200).json({
        success: true,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      });
    }

    // ---- ESTIMATED COST PER EVENT (public) ----
    if (action === 'estimateCost') {
      // Model pricing per 1M tokens (input / output) — must match AI_MODEL_PRICING
      const MODEL_PRICING = {
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, label: 'Haiku 4.5' },
        'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00, label: 'Sonnet 4' },
        'claude-sonnet-4-6':         { input: 3.00, output: 15.00, label: 'Sonnet 4.6' },
        'claude-opus-4-20250514':    { input: 15.00, output: 75.00, label: 'Opus 4' },
        'claude-opus-4-6':           { input: 15.00, output: 75.00, label: 'Opus 4.6' },
      };

      // Fetch admin-configured theme model
      const { data: configData } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', ['theme_model', 'chat_model']);
      const config = {};
      (configData || []).forEach(row => { config[row.key] = row.value; });
      const themeModel = config.theme_model || 'claude-sonnet-4-6';
      const chatModel = config.chat_model || 'claude-haiku-4-5-20251001';

      // Fetch markup from the usage-based plan (admin-configurable)
      let markupPct = 50;
      const planSlug = req.query.planSlug;
      if (planSlug) {
        const { data: planRow } = await supabaseAdmin
          .from('plans').select('ai_markup_pct').eq('name', planSlug).single();
        if (planRow) markupPct = planRow.ai_markup_pct || 50;
      } else {
        // Default: look for any usage-based plan's markup
        const { data: usagePlans } = await supabaseAdmin
          .from('plans').select('ai_markup_pct').eq('billing_type', 'usage').eq('is_active', true).limit(1);
        if (usagePlans?.length > 0) markupPct = usagePlans[0].ai_markup_pct || 50;
      }

      // Typical token usage per generation (based on system prompt + theme output)
      // Initial generation: ~4K input, ~8K output
      // Tweak: ~6K input (includes current theme), ~8K output
      // Chat message: ~1.5K input, ~0.5K output
      const TYPICAL_INITIAL_GEN = { input: 4000, output: 8000 };
      const TYPICAL_TWEAK = { input: 6000, output: 8000 };
      const TYPICAL_CHAT_MSG = { input: 1500, output: 500 };

      // Assume per invite: 1 initial gen + 4 design tweaks + 4 chat messages
      const themePricing = MODEL_PRICING[themeModel] || MODEL_PRICING['claude-sonnet-4-6'];
      const chatPricing = MODEL_PRICING[chatModel] || MODEL_PRICING['claude-haiku-4-5-20251001'];

      const initialGenCost = (TYPICAL_INITIAL_GEN.input * themePricing.input + TYPICAL_INITIAL_GEN.output * themePricing.output) / 1_000_000;
      const tweakCost = (TYPICAL_TWEAK.input * themePricing.input + TYPICAL_TWEAK.output * themePricing.output) / 1_000_000;
      const chatCost = (TYPICAL_CHAT_MSG.input * chatPricing.input + TYPICAL_CHAT_MSG.output * chatPricing.output) / 1_000_000;

      const numTweaks = 4;
      const numChatMsgs = 4;

      const rawAiCost = initialGenCost + (tweakCost * numTweaks) + (chatCost * numChatMsgs);
      const aiCostWithMarkup = rawAiCost * (1 + markupPct / 100);

      return res.status(200).json({
        success: true,
        estimate: {
          aiCostCents: Math.round(aiCostWithMarkup * 100),
          breakdown: {
            themeModel: themeModel,
            themeModelLabel: themePricing.label,
            chatModel: chatModel,
            chatModelLabel: chatPricing.label,
            initialGenerations: 1,
            tweaks: numTweaks,
            chatMessages: numChatMsgs,
            aiMarkupPct: markupPct,
            rawAiCostCents: Math.round(rawAiCost * 100)
          }
        }
      });
    }

    // ---- AUTHENTICATED ENDPOINTS ----
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // ---- CREATE CHECKOUT SESSION ----
    if (action === 'checkout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { planId, couponCode, returnUrl, embedded } = req.body || {};
      if (!planId) return res.status(400).json({ error: 'planId required' });

      const { data: plan } = await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('id', planId)
        .eq('is_active', true)
        .single();

      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      // Usage-based plans with $0 upfront: collect payment method via setup mode
      if (plan.billing_type === 'usage' && plan.price_cents === 0) {
        const customerId = await getOrCreateStripeCustomer(user);
        const baseUrl = getBaseUrl(req);

        const sessionParams = {
          customer: customerId,
          mode: 'setup',
          payment_method_types: ['card'],
          metadata: {
            supabase_user_id: user.id,
            plan_id: plan.id,
            plan_name: plan.name,
            checkout_type: 'usage_setup'
          }
        };

        if (embedded) {
          sessionParams.ui_mode = 'embedded';
          sessionParams.return_url = `${baseUrl}${returnUrl || '/v2/create/?purchased=true'}&session_id={CHECKOUT_SESSION_ID}`;
        } else {
          sessionParams.success_url = returnUrl
            ? `${baseUrl}${returnUrl}${returnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`
            : `${baseUrl}/v2/dashboard/?purchased=true&session_id={CHECKOUT_SESSION_ID}`;
          sessionParams.cancel_url = `${baseUrl}/v2/pricing/`;
        }

        const session = await stripe.checkout.sessions.create(sessionParams);

        return res.status(200).json({
          success: true,
          sessionId: session.id,
          url: embedded ? null : session.url,
          clientSecret: embedded ? session.client_secret : null
        });
      }

      let discount = null;
      let coupon = null;
      if (couponCode) {
        const couponResult = await validateCoupon(couponCode, plan.name, user.id, user.email);
        if (!couponResult.valid) {
          return res.status(400).json({ error: couponResult.error });
        }
        coupon = couponResult.coupon;
        discount = couponResult.discount;
      }

      const customerId = await getOrCreateStripeCustomer(user);
      const baseUrl = getBaseUrl(req);

      let finalAmountCents = plan.price_cents;
      let discountCents = 0;
      if (discount) {
        if (discount.type === 'percent') {
          discountCents = Math.round(plan.price_cents * discount.percent / 100);
        } else {
          discountCents = discount.amountCents;
        }
        finalAmountCents = Math.max(0, plan.price_cents - discountCents);
      }

      const sessionParams = {
        customer: customerId,
        ...(!embedded && { payment_method_types: ['card'] }),
        line_items: [{
          price_data: {
            currency: plan.currency || 'usd',
            product_data: {
              name: plan.display_name,
              description: plan.description || `${plan.max_events} event, up to ${plan.max_generations} AI generations`
            },
            unit_amount: finalAmountCents
          },
          quantity: 1
        }],
        mode: 'payment',
        payment_intent_data: { setup_future_usage: 'off_session' },
        metadata: {
          supabase_user_id: user.id,
          plan_id: plan.id,
          plan_name: plan.name,
          coupon_id: coupon?.id || '',
          coupon_code: couponCode || '',
          original_amount_cents: String(plan.price_cents),
          discount_cents: String(discountCents)
        }
      };

      // Embedded mode: render Stripe form on our page instead of redirecting
      if (embedded) {
        sessionParams.ui_mode = 'embedded';
        sessionParams.return_url = `${baseUrl}${returnUrl || '/v2/create/?purchased=true'}&session_id={CHECKOUT_SESSION_ID}`;
      } else {
        sessionParams.success_url = returnUrl
          ? `${baseUrl}${returnUrl}${returnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`
          : `${baseUrl}/v2/dashboard/?purchased=true&session_id={CHECKOUT_SESSION_ID}`;
        sessionParams.cancel_url = returnUrl ? `${baseUrl}${returnUrl.split('?')[0]}` : `${baseUrl}/v2/pricing/`;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      return res.status(200).json({
        success: true,
        sessionId: session.id,
        url: embedded ? null : session.url,
        clientSecret: embedded ? session.client_secret : null
      });
    }

    // ---- GET SAVED PAYMENT METHOD ----
    if (action === 'payment-method') {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      if (!profile?.stripe_customer_id) {
        return res.status(200).json({ success: true, hasPaymentMethod: false });
      }

      try {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: profile.stripe_customer_id,
          type: 'card',
          limit: 1
        });

        if (paymentMethods.data.length === 0) {
          return res.status(200).json({ success: true, hasPaymentMethod: false });
        }

        const card = paymentMethods.data[0].card;
        return res.status(200).json({
          success: true,
          hasPaymentMethod: true,
          card: {
            brand: card.brand,
            last4: card.last4,
            expMonth: card.exp_month,
            expYear: card.exp_year
          },
          paymentMethodId: paymentMethods.data[0].id
        });
      } catch (e) {
        return res.status(200).json({ success: true, hasPaymentMethod: false });
      }
    }

    // ---- CREATE SETUP INTENT (update/add payment method) ----
    if (action === 'create-setup-intent') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      let customerId = profile?.stripe_customer_id;

      // Create Stripe customer if they don't have one
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { supabase_user_id: user.id }
        });
        customerId = customer.id;
        await supabaseAdmin
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', user.id);
      }

      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        metadata: { supabase_user_id: user.id }
      });

      return res.status(200).json({
        success: true,
        clientSecret: setupIntent.client_secret
      });
    }

    // ---- CONFIRM SETUP INTENT (after Stripe Elements completes) ----
    if (action === 'confirm-setup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { setupIntentId } = req.body || {};
      if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });

      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

      if (setupIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Setup intent not completed', status: setupIntent.status });
      }

      // Set as default payment method for the customer
      if (setupIntent.customer && setupIntent.payment_method) {
        await stripe.customers.update(setupIntent.customer, {
          invoice_settings: { default_payment_method: setupIntent.payment_method }
        });
      }

      return res.status(200).json({ success: true });
    }

    // ---- DELETE PAYMENT METHOD ----
    if (action === 'delete-payment-method') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { paymentMethodId } = req.body || {};
      if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

      // Verify this payment method belongs to the user
      const { data: pmProfile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      if (!pmProfile?.stripe_customer_id) {
        return res.status(400).json({ error: 'No Stripe customer found' });
      }

      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.customer !== pmProfile.stripe_customer_id) {
        return res.status(403).json({ error: 'Payment method does not belong to this user' });
      }

      await stripe.paymentMethods.detach(paymentMethodId);

      return res.status(200).json({ success: true });
    }

    // ---- ACTIVATE USAGE PLAN (returning customer with saved card, $0 upfront) ----
    if (action === 'activate-usage-plan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { planId } = req.body || {};
      if (!planId) return res.status(400).json({ error: 'planId required' });

      const { data: plan } = await supabaseAdmin
        .from('plans').select('*').eq('id', planId).eq('is_active', true).single();
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.billing_type !== 'usage' || plan.price_cents !== 0) {
        return res.status(400).json({ error: 'This endpoint is only for $0 usage-based plans' });
      }

      // Verify user has a payment method on file
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('stripe_customer_id').eq('id', user.id).single();
      if (!profile?.stripe_customer_id) {
        return res.status(400).json({ error: 'No payment method on file. Please add a card first.' });
      }
      const pms = await stripe.paymentMethods.list({ customer: profile.stripe_customer_id, type: 'card', limit: 1 });
      if (pms.data.length === 0) {
        return res.status(400).json({ error: 'No card on file. Please add a payment method.' });
      }

      // Check for existing active subscription
      const { data: existingSubs } = await supabaseAdmin
        .from('subscriptions').select('id').eq('user_id', user.id).eq('status', 'active');
      if (existingSubs && existingSubs.length > 0) {
        return res.status(200).json({ success: true, message: 'Already has active subscription' });
      }

      // Create subscription record
      const { error: subError } = await supabaseAdmin.from('subscriptions').insert({
        user_id: user.id,
        plan_id: plan.id,
        status: 'active',
        amount_paid_cents: 0,
        stripe_customer_id: profile.stripe_customer_id
      });
      if (subError) return res.status(400).json({ error: subError.message });

      return res.status(200).json({ success: true });
    }

    // ---- QUICK CHARGE (saved card) ----
    if (action === 'quick-charge') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { planId, couponCode } = req.body || {};
      if (!planId) return res.status(400).json({ error: 'planId required' });

      const { data: plan } = await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('id', planId)
        .eq('is_active', true)
        .single();

      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      // Get saved payment method
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      if (!profile?.stripe_customer_id) {
        return res.status(400).json({ error: 'No payment method on file' });
      }

      const paymentMethods = await stripe.paymentMethods.list({
        customer: profile.stripe_customer_id,
        type: 'card',
        limit: 1
      });

      if (paymentMethods.data.length === 0) {
        return res.status(400).json({ error: 'No payment method on file' });
      }

      // Calculate amount with optional coupon
      let discount = null;
      let coupon = null;
      let discountCents = 0;
      if (couponCode) {
        const couponResult = await validateCoupon(couponCode, plan.name, user.id, user.email);
        if (!couponResult.valid) {
          return res.status(400).json({ error: couponResult.error });
        }
        coupon = couponResult.coupon;
        discount = couponResult.discount;
      }

      let finalAmountCents = plan.price_cents;
      if (discount) {
        if (discount.type === 'percent') {
          discountCents = Math.round(plan.price_cents * discount.percent / 100);
        } else {
          discountCents = discount.amountCents;
        }
        finalAmountCents = Math.max(0, plan.price_cents - discountCents);
      }

      // Charge saved card
      const paymentIntent = await stripe.paymentIntents.create({
        amount: finalAmountCents,
        currency: plan.currency || 'usd',
        customer: profile.stripe_customer_id,
        payment_method: paymentMethods.data[0].id,
        off_session: true,
        confirm: true,
        description: `Plan purchase: ${plan.display_name}`,
        metadata: {
          supabase_user_id: user.id,
          plan_id: plan.id,
          plan_name: plan.name,
          coupon_id: coupon?.id || '',
          coupon_code: couponCode || '',
          original_amount_cents: String(plan.price_cents),
          discount_cents: String(discountCents),
          charge_type: 'quick_charge'
        }
      });

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment failed. Please try with a new card.' });
      }

      // Create subscription (same as webhook handler)
      const { data: subscription } = await supabaseAdmin
        .from('subscriptions')
        .insert({
          user_id: user.id,
          plan_id: plan.id,
          status: 'active',
          stripe_customer_id: profile.stripe_customer_id,
          stripe_checkout_session_id: null,
          coupon_id: coupon?.id || null,
          amount_paid_cents: finalAmountCents,
          discount_cents: discountCents,
          events_used: 0,
          generations_used: 0,
          current_period_start: new Date().toISOString()
        })
        .select()
        .single();

      // Billing history
      let receiptUrl = null;
      if (paymentIntent.latest_charge) {
        try {
          const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
          receiptUrl = charge.receipt_url || null;
        } catch (e) {}
      }

      await supabaseAdmin.from('billing_history').insert({
        user_id: user.id,
        subscription_id: subscription?.id,
        stripe_payment_intent_id: paymentIntent.id,
        amount_cents: finalAmountCents,
        currency: plan.currency || 'usd',
        status: 'succeeded',
        description: `Plan purchase: ${plan.display_name}`,
        receipt_url: receiptUrl
      });

      // Handle coupon redemption
      if (coupon?.id && subscription?.id) {
        await supabaseAdmin.from('coupon_redemptions').insert({
          coupon_id: coupon.id,
          user_id: user.id,
          subscription_id: subscription.id
        });
        await supabaseAdmin.rpc('increment_coupon_usage', { coupon_uuid: coupon.id }).then(() => {});
      }

      return res.status(200).json({
        success: true,
        subscriptionId: subscription?.id,
        receiptUrl
      });
    }

    // ---- GET USER SUBSCRIPTION INFO ----
    if (action === 'subscription') {
      const { data: subscriptions } = await supabaseAdmin
        .from('subscriptions')
        .select(`
          *,
          plans:plan_id (name, display_name, price_cents, max_events, max_generations, features),
          coupons:coupon_id (code, discount_type, discount_value)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      const { count: eventCount } = await supabaseAdmin
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .neq('status', 'archived');

      const { count: genCount } = await supabaseAdmin
        .from('generation_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'success')
        .not('event_id', 'is', null);

      // SMS usage
      const { count: smsCount } = await supabaseAdmin
        .from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);

      const { data: smsCostData } = await supabaseAdmin
        .from('sms_messages')
        .select('cost_cents')
        .eq('user_id', user.id);

      const smsTotalCents = (smsCostData || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      const activeSub = (subscriptions || []).find(s => s.status === 'active');

      // Sum limits across all active subscriptions
      const activeSubs = (subscriptions || []).filter(s => s.status === 'active');
      let totalMaxEvents = 0;
      let totalMaxGenerations = 0;
      for (const sub of activeSubs) {
        totalMaxEvents += sub.plans?.max_events || 0;
        totalMaxGenerations += sub.plans?.max_generations || 0;
      }

      return res.status(200).json({
        success: true,
        subscription: activeSub ? {
          id: activeSub.id,
          status: activeSub.status,
          plan: activeSub.plans,
          coupon: activeSub.coupons,
          amountPaidCents: activeSub.amount_paid_cents,
          discountCents: activeSub.discount_cents,
          eventsUsed: activeSub.events_used,
          generationsUsed: activeSub.generations_used,
          createdAt: activeSub.created_at
        } : null,
        usage: {
          eventsUsed: eventCount || 0,
          generationsUsed: genCount || 0,
          maxEvents: totalMaxEvents,
          maxGenerations: totalMaxGenerations,
          smsSent: smsCount || 0,
          smsCostCents: smsTotalCents,
          smsPriceCents: activeSub?.plans?.sms_price_cents || 5
        },
        allSubscriptions: (subscriptions || []).map(s => ({
          id: s.id,
          status: s.status,
          planName: s.plans?.display_name || 'Unknown',
          amountPaidCents: s.amount_paid_cents,
          createdAt: s.created_at
        }))
      });
    }

    // ---- PER-EVENT COST ----
    // Returns total AI generation cost for a specific event (all generations, including billed)
    if (action === 'event_cost') {
      const eventId = req.query.eventId;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      // Verify the user owns this event and get persisted cost
      const { data: evt } = await supabaseAdmin
        .from('events').select('id, user_id, total_cost_cents').eq('id', eventId).single();
      if (!evt || evt.user_id !== user.id) {
        return res.status(403).json({ success: false, error: 'Not your event' });
      }

      // Get generation count for display
      const { count: genCount } = await supabaseAdmin
        .from('generation_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('status', 'success');

      // Always recalculate from generation_log as ground truth, then take the
      // max of that vs persisted column (handles partial backfills & pre-deploy gaps)
      let markupPct = 50;
      const { data: usageSubs } = await supabaseAdmin
        .from('subscriptions')
        .select('plans:plan_id (ai_markup_pct)')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .limit(1);
      if (usageSubs && usageSubs.length > 0 && usageSubs[0].plans?.ai_markup_pct) {
        markupPct = usageSubs[0].plans.ai_markup_pct;
      }

      const { data: gens } = await supabaseAdmin
        .from('generation_log')
        .select('model, input_tokens, output_tokens')
        .eq('event_id', eventId)
        .eq('status', 'success');

      let rawCostDollars = 0;
      for (const g of (gens || [])) {
        const pricing = AI_MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
        rawCostDollars += ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
      }
      const recalcCents = Math.round(rawCostDollars * (1 + markupPct / 100) * 100);
      const persistedCents = evt.total_cost_cents || 0;

      // Use whichever is higher — persisted tracks increments that may include
      // costs not in generation_log; recalc catches pre-deploy generations
      const totalCostCents = Math.max(recalcCents, persistedCents);

      // Self-heal: if recalculated is higher, update the persisted column
      if (recalcCents > persistedCents) {
        const { error: healError } = await supabaseAdmin.from('events')
          .update({ total_cost_cents: recalcCents })
          .eq('id', eventId);
        if (healError) console.error('Event cost self-heal failed:', healError.message);
      }

      return res.status(200).json({
        success: true,
        eventId,
        totalCostCents,
        generationCount: genCount || 0
      });
    }

    // ---- REAL-TIME USAGE SUMMARY ----
    // Returns unbilled AI and SMS costs with breakdown, threshold info, and credits
    if (action === 'usage_summary') {
      // Get user's billing threshold
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('billing_threshold_cents, successful_charges_count')
        .eq('id', user.id)
        .single();

      const thresholdCents = profile?.billing_threshold_cents || 500;
      const chargeCount = profile?.successful_charges_count || 0;

      // Get active usage-based subscription
      const { data: activeSubs } = await supabaseAdmin
        .from('subscriptions')
        .select('id, plan_id, plans:plan_id (billing_type, ai_markup_pct, sms_price_cents)')
        .eq('user_id', user.id)
        .eq('status', 'active');

      const usageSub = (activeSubs || []).find(s => s.plans?.billing_type === 'usage');
      const markupPct = usageSub?.plans?.ai_markup_pct || 50;
      const smsPriceCents = usageSub?.plans?.sms_price_cents || 5;

      // ALL AI generations (for total cost tracking)
      const { data: allGens } = await supabaseAdmin
        .from('generation_log')
        .select('id, model, input_tokens, output_tokens, created_at, event_id, billed')
        .eq('user_id', user.id)
        .eq('status', 'success');

      // Split into unbilled (for billing threshold) and all (for display)
      const unbilledGens = (allGens || []).filter(g => !g.billed);

      let rawAiCostDollars = 0;
      const genDetails = [];
      for (const g of (unbilledGens || [])) {
        const pricing = AI_MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
        const rawCost = ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
        rawAiCostDollars += rawCost;
        genDetails.push({
          id: g.id,
          model: g.model,
          rawCostCents: Math.round(rawCost * 100),
          createdAt: g.created_at,
          eventId: g.event_id
        });
      }

      const aiCostWithMarkup = rawAiCostDollars * (1 + markupPct / 100);
      const aiCostCents = Math.round(aiCostWithMarkup * 100);

      // Total all-time AI cost (billed + unbilled)
      let rawAllTimeAiDollars = 0;
      for (const g of (allGens || [])) {
        const pricing = AI_MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
        rawAllTimeAiDollars += ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
      }
      const allTimeAiCents = Math.round(rawAllTimeAiDollars * (1 + markupPct / 100) * 100);

      // Unbilled SMS
      const { data: unbilledSms } = await supabaseAdmin
        .from('sms_messages')
        .select('id, cost_cents, created_at, event_id')
        .eq('user_id', user.id)
        .eq('billed', false);

      const smsCostCents = (unbilledSms || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      // All-time SMS cost
      const { data: allSms } = await supabaseAdmin
        .from('sms_messages')
        .select('cost_cents')
        .eq('user_id', user.id);
      const allTimeSmsCents = (allSms || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      // Available credits
      const { data: credits } = await supabaseAdmin
        .from('usage_credits')
        .select('id, remaining_cents, source, description, expires_at')
        .eq('user_id', user.id)
        .gt('remaining_cents', 0)
        .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString());

      const totalCreditsCents = (credits || []).reduce((sum, c) => sum + c.remaining_cents, 0);

      const totalUnbilledCents = aiCostCents + smsCostCents;
      const afterCreditsCents = Math.max(0, totalUnbilledCents - totalCreditsCents);

      // Billing history summary
      const { data: billingHistory } = await supabaseAdmin
        .from('billing_history')
        .select('amount_cents, status, created_at, description')
        .eq('user_id', user.id)
        .eq('status', 'succeeded')
        .order('created_at', { ascending: false })
        .limit(10);

      const totalPaidCents = (billingHistory || []).reduce((sum, b) => sum + (b.amount_cents || 0), 0);

      return res.status(200).json({
        success: true,
        usage: {
          ai: {
            unbilledCount: (unbilledGens || []).length,
            totalCount: (allGens || []).length,
            rawCostCents: Math.round(rawAiCostDollars * 100),
            markupPct,
            totalCents: aiCostCents,
            allTimeCents: allTimeAiCents,
            details: genDetails
          },
          sms: {
            unbilledCount: (unbilledSms || []).length,
            totalCents: smsCostCents,
            allTimeCents: allTimeSmsCents,
            pricePerMessageCents: smsPriceCents
          },
          totalUnbilledCents,
          totalAllTimeCents: allTimeAiCents + allTimeSmsCents,
          credits: {
            availableCents: totalCreditsCents,
            items: (credits || []).map(c => ({
              id: c.id,
              remainingCents: c.remaining_cents,
              source: c.source,
              description: c.description,
              expiresAt: c.expires_at
            }))
          },
          afterCreditsCents,
          threshold: {
            cents: thresholdCents,
            tier: chargeCount >= 3 ? 'trusted' : chargeCount >= 1 ? 'established' : 'new',
            successfulCharges: chargeCount,
            pctToThreshold: thresholdCents > 0 ? Math.min(100, Math.round(afterCreditsCents / thresholdCents * 100)) : 0
          },
          totalPaidToDateCents: totalPaidCents,
          recentCharges: (billingHistory || []).slice(0, 5).map(b => ({
            amountCents: b.amount_cents,
            description: b.description,
            date: b.created_at
          }))
        }
      });
    }

    // ---- MONTHLY SWEEP (charge remaining balance) ----
    // Called by Vercel Cron on the 1st of each month, or manually by admin.
    // Charges any unbilled usage > $0.50.
    if (action === 'monthly-sweep') {
      // Verify: Vercel Cron sends Authorization: Bearer <CRON_SECRET>
      const authHeader = req.headers.authorization || '';
      const cronToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const cronSecret = cronToken || req.headers['x-cron-secret'] || req.body?.cronSecret;
      const isAdmin = user && ['jakebrennan54@gmail.com'].includes(user.email);

      if (cronSecret !== process.env.CRON_SECRET && !isAdmin) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Get all usage-based subscribers with unbilled usage
      const { data: usageSubs } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id, plans:plan_id (billing_type, ai_markup_pct, sms_price_cents)')
        .eq('status', 'active');

      const usageUsers = (usageSubs || [])
        .filter(s => s.plans?.billing_type === 'usage')
        .map(s => s.user_id);

      const uniqueUsers = [...new Set(usageUsers)];
      const results = [];
      const MIN_SWEEP_CENTS = 50; // Don't charge less than $0.50

      for (const uid of uniqueUsers) {
        try {
          // Calculate unbilled AI
          const { data: unbilledGens } = await supabaseAdmin
            .from('generation_log')
            .select('id, model, input_tokens, output_tokens')
            .eq('user_id', uid)
            .eq('billed', false)
            .eq('status', 'success');

          let rawAiDollars = 0;
          for (const g of (unbilledGens || [])) {
            const pricing = AI_MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
            rawAiDollars += ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
          }

          const sub = (usageSubs || []).find(s => s.user_id === uid);
          const markup = sub?.plans?.ai_markup_pct || 50;
          const aiCents = Math.round(rawAiDollars * (1 + markup / 100) * 100);

          // Calculate unbilled SMS
          const { data: unbilledSms } = await supabaseAdmin
            .from('sms_messages')
            .select('id, cost_cents')
            .eq('user_id', uid)
            .eq('billed', false);

          const smsCents = (unbilledSms || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);
          let totalCents = aiCents + smsCents;

          if (totalCents < MIN_SWEEP_CENTS) {
            results.push({ userId: uid, skipped: true, reason: 'below_minimum', totalCents });
            continue;
          }

          // Apply credits
          const { data: credits } = await supabaseAdmin
            .from('usage_credits')
            .select('id, remaining_cents')
            .eq('user_id', uid)
            .gt('remaining_cents', 0)
            .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
            .order('created_at', { ascending: true });

          let creditsApplied = 0;
          for (const credit of (credits || [])) {
            if (totalCents <= 0) break;
            const deduct = Math.min(credit.remaining_cents, totalCents);
            await supabaseAdmin
              .from('usage_credits')
              .update({ remaining_cents: credit.remaining_cents - deduct })
              .eq('id', credit.id);
            creditsApplied += deduct;
            totalCents -= deduct;
          }

          if (totalCents < MIN_SWEEP_CENTS) {
            results.push({ userId: uid, skipped: true, reason: 'covered_by_credits', creditsApplied });
            continue;
          }

          // Get payment method
          const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', uid)
            .single();

          if (!profile?.stripe_customer_id) {
            results.push({ userId: uid, skipped: true, reason: 'no_stripe_customer' });
            continue;
          }

          const paymentMethods = await stripe.paymentMethods.list({
            customer: profile.stripe_customer_id,
            type: 'card',
            limit: 1
          });

          if (paymentMethods.data.length === 0) {
            results.push({ userId: uid, skipped: true, reason: 'no_payment_method' });
            continue;
          }

          // Charge
          const paymentIntent = await stripe.paymentIntents.create({
            amount: totalCents,
            currency: 'usd',
            customer: profile.stripe_customer_id,
            payment_method: paymentMethods.data[0].id,
            off_session: true,
            confirm: true,
            description: `Monthly usage sweep: AI + SMS`,
            metadata: {
              supabase_user_id: uid,
              charge_type: 'monthly_sweep',
              ai_cents: String(aiCents),
              sms_cents: String(smsCents),
              credits_applied: String(creditsApplied)
            }
          });

          if (paymentIntent.status === 'succeeded') {
            // Mark AI generations as billed
            if (unbilledGens?.length > 0) {
              await supabaseAdmin
                .from('generation_log')
                .update({ billed: true })
                .in('id', unbilledGens.map(g => g.id));
            }

            // Mark SMS as billed
            if (unbilledSms?.length > 0) {
              await supabaseAdmin
                .from('sms_messages')
                .update({ billed: true })
                .in('id', unbilledSms.map(m => m.id));
            }

            // Record billing history
            let receiptUrl = null;
            try {
              if (paymentIntent.latest_charge) {
                const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
                receiptUrl = charge.receipt_url || null;
              }
            } catch (e) {}

            await supabaseAdmin.from('billing_history').insert({
              user_id: uid,
              stripe_payment_intent_id: paymentIntent.id,
              amount_cents: totalCents,
              currency: 'usd',
              status: 'succeeded',
              description: `Monthly usage sweep: ${(unbilledGens || []).length} AI generations, ${(unbilledSms || []).length} SMS`,
              receipt_url: receiptUrl
            });

            // Update charge count and threshold
            await supabaseAdmin.rpc('increment_successful_charges', { p_user_id: uid }).then(() => {});

            // Update sweep timestamp
            await supabaseAdmin
              .from('profiles')
              .update({ last_monthly_sweep_at: new Date().toISOString() })
              .eq('id', uid);

            results.push({ userId: uid, charged: true, amountCents: totalCents, creditsApplied });
          } else {
            results.push({ userId: uid, charged: false, reason: 'payment_failed' });
          }
        } catch (e) {
          results.push({ userId: uid, charged: false, error: e.message });
        }
      }

      return res.status(200).json({
        success: true,
        usersProcessed: uniqueUsers.length,
        results
      });
    }

    // ---- VERIFY CHECKOUT SESSION (fallback if webhook is slow) ----
    if (action === 'verify-session') {
      const sessionId = req.query.session_id || (req.body && req.body.session_id);
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'session_id is required' });
      }

      // First check if subscription already exists for this session
      const { data: existingSub } = await supabaseAdmin
        .from('subscriptions')
        .select('id, status')
        .eq('stripe_checkout_session_id', sessionId)
        .maybeSingle();

      if (existingSub) {
        return res.status(200).json({ success: true, subscription: existingSub, source: 'existing' });
      }

      // Not found — check with Stripe directly
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const isUsageSetup = (session.metadata || {}).checkout_type === 'usage_setup';

        if (!isUsageSetup && session.payment_status !== 'paid') {
          return res.status(200).json({ success: false, error: 'Payment not completed yet', paymentStatus: session.payment_status });
        }

        // For setup mode, check that setup succeeded
        if (isUsageSetup && session.status !== 'complete') {
          return res.status(200).json({ success: false, error: 'Setup not completed yet' });
        }

        // Payment/setup is confirmed by Stripe but webhook hasn't created the subscription yet
        // Create it now (same logic as handleCheckoutComplete)
        const metadata = session.metadata || {};
        const metaUserId = metadata.supabase_user_id;
        const planId = metadata.plan_id;

        if (!metaUserId || !planId) {
          return res.status(400).json({ success: false, error: 'Missing metadata in checkout session' });
        }

        // Verify the authenticated user matches the session owner
        if (metaUserId !== user.id) {
          return res.status(403).json({ success: false, error: 'Session does not belong to this user' });
        }

        // Double-check no subscription was created in the meantime (race condition guard)
        const { data: raceCheck } = await supabaseAdmin
          .from('subscriptions')
          .select('id, status')
          .eq('stripe_checkout_session_id', sessionId)
          .maybeSingle();

        if (raceCheck) {
          return res.status(200).json({ success: true, subscription: raceCheck, source: 'race-resolved' });
        }

        const couponId = metadata.coupon_id || null;
        const originalAmountCents = parseInt(metadata.original_amount_cents) || 0;
        const discountCents = parseInt(metadata.discount_cents) || 0;

        const { data: subscription, error: subError } = await supabaseAdmin
          .from('subscriptions')
          .insert({
            user_id: metaUserId,
            plan_id: planId,
            status: 'active',
            stripe_customer_id: session.customer,
            stripe_checkout_session_id: session.id,
            coupon_id: couponId || null,
            amount_paid_cents: isUsageSetup ? 0 : (session.amount_total || (originalAmountCents - discountCents)),
            discount_cents: discountCents,
            events_used: 0,
            generations_used: 0,
            current_period_start: new Date().toISOString()
          })
          .select()
          .single();

        if (subError) {
          // Could be duplicate key if webhook just ran
          const { data: fallback } = await supabaseAdmin
            .from('subscriptions')
            .select('id, status')
            .eq('stripe_checkout_session_id', sessionId)
            .maybeSingle();

          if (fallback) {
            return res.status(200).json({ success: true, subscription: fallback, source: 'webhook-resolved' });
          }
          return res.status(500).json({ success: false, error: 'Failed to create subscription: ' + subError.message });
        }

        // Update profile tier
        await supabaseAdmin
          .from('profiles')
          .update({ stripe_customer_id: session.customer, tier: 'pro' })
          .eq('id', metaUserId);

        // Create billing history
        await supabaseAdmin
          .from('billing_history')
          .insert({
            user_id: metaUserId,
            subscription_id: subscription.id,
            stripe_payment_intent_id: session.payment_intent,
            amount_cents: session.amount_total || (originalAmountCents - discountCents),
            currency: session.currency || 'usd',
            status: 'succeeded',
            description: `Plan purchase: ${metadata.plan_name || 'Single Event'}`,
            receipt_url: null
          });

        // Handle coupon redemption
        if (couponId) {
          await supabaseAdmin
            .from('coupon_redemptions')
            .insert({
              coupon_id: couponId,
              user_id: metaUserId,
              subscription_id: subscription.id
            });

          await supabaseAdmin.rpc('increment_coupon_usage', { coupon_uuid: couponId })
            .catch(async () => {
              const { data: c } = await supabaseAdmin
                .from('coupons')
                .select('times_used')
                .eq('id', couponId)
                .single();
              if (c) {
                await supabaseAdmin
                  .from('coupons')
                  .update({ times_used: (c.times_used || 0) + 1 })
                  .eq('id', couponId);
              }
            });
        }

        return res.status(200).json({ success: true, subscription: { id: subscription.id, status: 'active' }, source: 'created' });
      } catch (stripeErr) {
        console.error('Stripe session verify error:', stripeErr);
        return res.status(500).json({ success: false, error: 'Failed to verify session with Stripe' });
      }
    }

    // ---- BILLING HISTORY ----
    if (action === 'history') {
      const { data: history } = await supabaseAdmin
        .from('billing_history')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      return res.status(200).json({
        success: true,
        history: (history || []).map(h => ({
          id: h.id,
          amountCents: h.amount_cents,
          currency: h.currency,
          status: h.status,
          description: h.description,
          receiptUrl: h.receipt_url,
          createdAt: h.created_at
        }))
      });
    }

    // ---- SMS USAGE DETAILS ----
    if (action === 'smsUsage') {
      const { data: messages } = await supabaseAdmin
        .from('sms_messages')
        .select('id, event_id, recipient_phone, recipient_name, message_type, status, cost_cents, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100);

      const totalCents = (messages || []).reduce((sum, m) => sum + (m.cost_cents || 0), 0);

      return res.status(200).json({
        success: true,
        messages: (messages || []).map(m => ({
          id: m.id,
          eventId: m.event_id,
          recipientPhone: m.recipient_phone,
          recipientName: m.recipient_name,
          messageType: m.message_type,
          status: m.status,
          costCents: m.cost_cents,
          createdAt: m.created_at
        })),
        summary: {
          totalSent: (messages || []).length,
          totalCostCents: totalCents
        }
      });
    }

    // ---- CHECK PLAN LIMITS ----
    if (action === 'checkLimits') {
      const limitCheck = await checkUserLimits(user.id);
      return res.status(200).json({ success: true, ...limitCheck });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Billing API error:', err?.message || err, err?.stack);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}

// ---- STRIPE WEBHOOK HANDLER ----
async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;

  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];

    if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(rawBody.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;

      case 'payment_intent.succeeded':
        break;

      case 'charge.refunded':
        await handleRefund(event.data.object);
        break;

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler error' });
  }
}

async function handleCheckoutComplete(session) {
  const metadata = session.metadata || {};
  const userId = metadata.supabase_user_id;
  const planId = metadata.plan_id;
  const couponId = metadata.coupon_id || null;
  const couponCode = metadata.coupon_code || null;
  const originalAmountCents = parseInt(metadata.original_amount_cents) || 0;
  const discountCents = parseInt(metadata.discount_cents) || 0;

  if (!userId || !planId) {
    console.error('Missing userId or planId in checkout metadata');
    return;
  }

  // Usage-based plan setup (no payment, just saved card)
  const isUsageSetup = metadata.checkout_type === 'usage_setup';

  const { data: subscription, error: subError } = await supabaseAdmin
    .from('subscriptions')
    .insert({
      user_id: userId,
      plan_id: planId,
      status: 'active',
      stripe_customer_id: session.customer,
      stripe_checkout_session_id: session.id,
      coupon_id: couponId || null,
      amount_paid_cents: isUsageSetup ? 0 : (session.amount_total || (originalAmountCents - discountCents)),
      discount_cents: discountCents,
      events_used: 0,
      generations_used: 0,
      current_period_start: new Date().toISOString()
    })
    .select()
    .single();

  if (subError) {
    console.error('Failed to create subscription:', subError);
    return;
  }

  await supabaseAdmin
    .from('billing_history')
    .insert({
      user_id: userId,
      subscription_id: subscription.id,
      stripe_payment_intent_id: session.payment_intent,
      amount_cents: session.amount_total || (originalAmountCents - discountCents),
      currency: session.currency || 'usd',
      status: 'succeeded',
      description: `Plan purchase: ${metadata.plan_name || 'Single Event'}`,
      receipt_url: null
    });

  if (couponId) {
    await supabaseAdmin
      .from('coupon_redemptions')
      .insert({
        coupon_id: couponId,
        user_id: userId,
        subscription_id: subscription.id
      });

    await supabaseAdmin.rpc('increment_coupon_usage', { coupon_uuid: couponId })
      .then(() => {})
      .catch(async () => {
        const { data: c } = await supabaseAdmin
          .from('coupons')
          .select('times_used')
          .eq('id', couponId)
          .single();
        if (c) {
          await supabaseAdmin
            .from('coupons')
            .update({ times_used: (c.times_used || 0) + 1 })
            .eq('id', couponId);
        }
      });
  }

  await supabaseAdmin
    .from('profiles')
    .update({ stripe_customer_id: session.customer, tier: 'pro' })
    .eq('id', userId);

  if (session.payment_intent) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      if (paymentIntent.latest_charge) {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        if (charge.receipt_url) {
          await supabaseAdmin
            .from('billing_history')
            .update({ receipt_url: charge.receipt_url })
            .eq('stripe_payment_intent_id', session.payment_intent);
        }
      }
    } catch (e) {
      // Non-critical, receipt URL is nice-to-have
    }
  }
}

async function handleRefund(charge) {
  if (!charge.payment_intent) return;

  await supabaseAdmin
    .from('billing_history')
    .update({ status: 'refunded' })
    .eq('stripe_payment_intent_id', charge.payment_intent);
}

// ---- COUPON VALIDATION ENGINE ----
async function validateCoupon(code, planName, userId, userEmail) {
  const { data: coupon, error } = await supabaseAdmin
    .from('coupons')
    .select('*')
    .eq('code', code.toUpperCase().trim())
    .eq('is_active', true)
    .single();

  if (error || !coupon) {
    return { valid: false, error: 'Invalid coupon code' };
  }

  const now = new Date();

  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    return { valid: false, error: 'This coupon is not yet active' };
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { valid: false, error: 'This coupon has expired' };
  }

  if (coupon.max_uses !== null && coupon.times_used >= coupon.max_uses) {
    return { valid: false, error: 'This coupon has reached its usage limit' };
  }

  if (userId && coupon.max_uses_per_user) {
    const { count } = await supabaseAdmin
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('user_id', userId);

    if (count >= coupon.max_uses_per_user) {
      return { valid: false, error: 'You have already used this coupon' };
    }
  }

  if (coupon.allowed_plans && coupon.allowed_plans.length > 0 && planName) {
    if (!coupon.allowed_plans.includes(planName)) {
      return { valid: false, error: 'This coupon does not apply to the selected plan' };
    }
  }

  if (coupon.allowed_emails && coupon.allowed_emails.length > 0) {
    if (!userEmail || !coupon.allowed_emails.map(e => e.toLowerCase()).includes(userEmail.toLowerCase())) {
      return { valid: false, error: 'This coupon is not available for your account' };
    }
  }

  let discountInfo;
  if (coupon.discount_type === 'percent') {
    discountInfo = {
      type: 'percent',
      percent: Number(coupon.discount_value),
      amountCents: 0,
      label: `${Number(coupon.discount_value)}% off`
    };
  } else {
    discountInfo = {
      type: 'fixed',
      amountCents: Math.round(Number(coupon.discount_value)),
      label: `$${(Number(coupon.discount_value) / 100).toFixed(2)} off`
    };
  }

  return { valid: true, coupon, discount: discountInfo };
}

// ---- PLAN LIMIT CHECKING ----
export async function checkUserLimits(userId) {
  // Sum limits across ALL active subscriptions (each purchase adds another event slot)
  const { data: activeSubs } = await supabaseAdmin
    .from('subscriptions')
    .select('*, plans:plan_id (max_events, max_generations)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (!activeSubs || activeSubs.length === 0) {
    return {
      hasActivePlan: false,
      canCreateEvent: false,
      canGenerate: false,
      reason: 'No active plan. Purchase a plan to create events.'
    };
  }

  // Aggregate limits from all active subscriptions
  let maxEvents = 0;
  let maxGenerations = 0;
  for (const sub of activeSubs) {
    maxEvents += sub.plans?.max_events || 0;
    maxGenerations += sub.plans?.max_generations || 0;
  }

  const { count: eventCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('status', 'archived');

  const { count: genCount } = await supabaseAdmin
    .from('generation_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'success')
    .not('event_id', 'is', null);

  const canCreateEvent = (eventCount || 0) < maxEvents;
  const canGenerate = (genCount || 0) < maxGenerations;

  return {
    hasActivePlan: true,
    canCreateEvent,
    canGenerate,
    eventsUsed: eventCount || 0,
    eventsMax: maxEvents,
    generationsUsed: genCount || 0,
    generationsMax: maxGenerations,
    reason: !canCreateEvent
      ? `You've used all ${maxEvents} event(s) you've purchased.`
      : !canGenerate
      ? `You've used all ${maxGenerations} AI generations in your plan.`
      : null
  };
}

// ---- DYNAMIC THRESHOLD HELPER ----
// Gets user's billing threshold (tiered: $5 new → $15 established → $25 trusted)
async function getUserThreshold(userId) {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('billing_threshold_cents, successful_charges_count')
    .eq('id', userId)
    .single();
  return profile?.billing_threshold_cents || 500;
}

// ---- CREDIT APPLICATION HELPER ----
// Applies usage credits and returns amount still owed
async function applyCreditsToCharge(userId, totalCents) {
  if (totalCents <= 0) return { chargeAmount: 0, creditsApplied: 0 };

  const { data: credits } = await supabaseAdmin
    .from('usage_credits')
    .select('id, remaining_cents')
    .eq('user_id', userId)
    .gt('remaining_cents', 0)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    .order('created_at', { ascending: true });

  let creditsApplied = 0;
  let remaining = totalCents;

  for (const credit of (credits || [])) {
    if (remaining <= 0) break;
    const deduct = Math.min(credit.remaining_cents, remaining);
    await supabaseAdmin
      .from('usage_credits')
      .update({ remaining_cents: credit.remaining_cents - deduct })
      .eq('id', credit.id);
    creditsApplied += deduct;
    remaining -= deduct;
  }

  return { chargeAmount: remaining, creditsApplied };
}

// ---- SMS THRESHOLD BILLING ----
// Charges accumulated SMS costs when they reach the user's dynamic threshold.
// Called after each SMS is sent. Batches charges to avoid micro-transactions.

export async function checkAndChargeSmsUsage(userId) {
  try {
    const thresholdCents = await getUserThreshold(userId);

    // Get unbilled SMS costs (messages not yet included in an SMS billing charge)
    const { data: unbilledMessages } = await supabaseAdmin
      .from('sms_messages')
      .select('id, cost_cents')
      .eq('user_id', userId)
      .eq('billed', false);

    if (!unbilledMessages || unbilledMessages.length === 0) return { charged: false };

    const totalCents = unbilledMessages.reduce((sum, m) => sum + (m.cost_cents || 0), 0);

    if (totalCents < thresholdCents) {
      return { charged: false, pendingCents: totalCents, threshold: thresholdCents };
    }

    // Get saved payment method
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_customer_id) {
      console.warn('SMS billing: no Stripe customer for user', userId);
      return { charged: false, error: 'No payment method on file' };
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: profile.stripe_customer_id,
      type: 'card',
      limit: 1
    });

    if (paymentMethods.data.length === 0) {
      console.warn('SMS billing: no payment method for user', userId);
      return { charged: false, error: 'No payment method on file' };
    }

    // Apply credits before charging
    const { chargeAmount, creditsApplied } = await applyCreditsToCharge(userId, totalCents);

    if (chargeAmount <= 0) {
      // Fully covered by credits — mark as billed
      const messageIds = unbilledMessages.map(m => m.id);
      await supabaseAdmin
        .from('sms_messages')
        .update({ billed: true })
        .in('id', messageIds);
      return { charged: false, coveredByCredits: true, creditsApplied, messageCount: unbilledMessages.length };
    }

    // Charge the accumulated SMS costs (minus credits)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      description: `SMS usage: ${unbilledMessages.length} messages`,
      metadata: {
        supabase_user_id: userId,
        charge_type: 'sms_usage',
        message_count: String(unbilledMessages.length),
        total_cents: String(totalCents),
        credits_applied: String(creditsApplied)
      }
    });

    if (paymentIntent.status !== 'succeeded') {
      console.error('SMS billing: payment failed for user', userId);
      return { charged: false, error: 'Payment failed' };
    }

    // Mark messages as billed
    const messageIds = unbilledMessages.map(m => m.id);
    await supabaseAdmin
      .from('sms_messages')
      .update({ billed: true })
      .in('id', messageIds);

    // Record in billing history
    let receiptUrl = null;
    try {
      if (paymentIntent.latest_charge) {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        receiptUrl = charge.receipt_url || null;
      }
    } catch (e) {}

    await supabaseAdmin.from('billing_history').insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntent.id,
      amount_cents: chargeAmount,
      currency: 'usd',
      status: 'succeeded',
      description: `SMS usage: ${unbilledMessages.length} messages` + (creditsApplied > 0 ? ` ($${(creditsApplied/100).toFixed(2)} credits applied)` : ''),
      receipt_url: receiptUrl
    });

    // Update successful charge count and threshold tier
    await supabaseAdmin.rpc('increment_successful_charges', { p_user_id: userId }).then(() => {});

    return { charged: true, amountCents: chargeAmount, creditsApplied, messageCount: unbilledMessages.length };
  } catch (e) {
    console.error('SMS billing error:', e.message);
    return { charged: false, error: e.message };
  }
}

// ---- AI COST THRESHOLD BILLING ----
// Charges accumulated AI generation costs when they reach the user's dynamic threshold.
// Only applies to users on 'usage' billing type plans.
// Called after each AI generation. Batches charges to avoid micro-transactions.

// AI model pricing per 1M tokens — must match generate-theme.js, chat.js, ratings.js, admin.js
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

export async function checkAndChargeAiUsage(userId) {
  try {
    const thresholdCents = await getUserThreshold(userId);

    // Check if user is on a usage-based plan
    const { data: activeSubs } = await supabaseAdmin
      .from('subscriptions')
      .select('id, plan_id, plans:plan_id (billing_type, ai_markup_pct)')
      .eq('user_id', userId)
      .eq('status', 'active');

    const usageSub = (activeSubs || []).find(s => s.plans?.billing_type === 'usage');
    if (!usageSub) return { charged: false, reason: 'not_usage_plan' };

    const markupPct = usageSub.plans.ai_markup_pct || 50;

    // Get unbilled AI generation costs
    const { data: unbilledGens } = await supabaseAdmin
      .from('generation_log')
      .select('id, model, input_tokens, output_tokens')
      .eq('user_id', userId)
      .eq('billed', false)
      .eq('status', 'success');

    if (!unbilledGens || unbilledGens.length === 0) return { charged: false };

    // Calculate raw cost
    let rawCostDollars = 0;
    for (const g of unbilledGens) {
      const pricing = AI_MODEL_PRICING[g.model] || { input: 3.00, output: 15.00 };
      rawCostDollars += ((g.input_tokens || 0) * pricing.input + (g.output_tokens || 0) * pricing.output) / 1_000_000;
    }

    // Apply markup
    const markedUpDollars = rawCostDollars * (1 + markupPct / 100);
    const totalCents = Math.round(markedUpDollars * 100);

    if (totalCents < thresholdCents) {
      return { charged: false, pendingCents: totalCents, threshold: thresholdCents };
    }

    // Get saved payment method
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_customer_id) {
      console.warn('AI billing: no Stripe customer for user', userId);
      return { charged: false, error: 'No payment method on file' };
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: profile.stripe_customer_id,
      type: 'card',
      limit: 1
    });

    if (paymentMethods.data.length === 0) {
      console.warn('AI billing: no payment method for user', userId);
      return { charged: false, error: 'No payment method on file' };
    }

    // Apply credits before charging
    const { chargeAmount, creditsApplied } = await applyCreditsToCharge(userId, totalCents);

    if (chargeAmount <= 0) {
      // Fully covered by credits — mark as billed
      const genIds = unbilledGens.map(g => g.id);
      await supabaseAdmin
        .from('generation_log')
        .update({ billed: true })
        .in('id', genIds);
      return { charged: false, coveredByCredits: true, creditsApplied, generationCount: unbilledGens.length };
    }

    // Charge the accumulated AI costs (minus credits)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      description: `AI usage: ${unbilledGens.length} generations (${markupPct}% markup)`,
      metadata: {
        supabase_user_id: userId,
        charge_type: 'ai_usage',
        generation_count: String(unbilledGens.length),
        raw_cost_cents: String(Math.round(rawCostDollars * 100)),
        markup_pct: String(markupPct),
        total_cents: String(totalCents),
        credits_applied: String(creditsApplied)
      }
    });

    if (paymentIntent.status !== 'succeeded') {
      console.error('AI billing: payment failed for user', userId);
      return { charged: false, error: 'Payment failed' };
    }

    // Mark generations as billed
    const genIds = unbilledGens.map(g => g.id);
    await supabaseAdmin
      .from('generation_log')
      .update({ billed: true })
      .in('id', genIds);

    // Record in billing history
    let receiptUrl = null;
    try {
      if (paymentIntent.latest_charge) {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        receiptUrl = charge.receipt_url || null;
      }
    } catch (e) {}

    await supabaseAdmin.from('billing_history').insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntent.id,
      amount_cents: chargeAmount,
      currency: 'usd',
      status: 'succeeded',
      description: `AI usage: ${unbilledGens.length} generations` + (creditsApplied > 0 ? ` ($${(creditsApplied/100).toFixed(2)} credits applied)` : ''),
      receipt_url: receiptUrl
    });

    // Update successful charge count and threshold tier
    await supabaseAdmin.rpc('increment_successful_charges', { p_user_id: userId }).then(() => {});

    return { charged: true, amountCents: chargeAmount, creditsApplied, generationCount: unbilledGens.length };
  } catch (e) {
    console.error('AI billing error:', e.message);
    return { charged: false, error: e.message };
  }
}
