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

  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
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
      const { data: plans, error } = await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('is_active', true)
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
          maxEvents: p.max_events,
          maxGenerations: p.max_generations,
          smsPriceCents: p.sms_price_cents || 5,
          features: p.features || []
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
        sessionParams.success_url = returnUrl ? `${baseUrl}${returnUrl}` : `${baseUrl}/v2/dashboard/?purchased=true&session_id={CHECKOUT_SESSION_ID}`;
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
        .eq('status', 'success');

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
          maxEvents: activeSub?.plans?.max_events || 0,
          maxGenerations: activeSub?.plans?.max_generations || 0,
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

  const { data: subscription, error: subError } = await supabaseAdmin
    .from('subscriptions')
    .insert({
      user_id: userId,
      plan_id: planId,
      status: 'active',
      stripe_customer_id: session.customer,
      stripe_checkout_session_id: session.id,
      coupon_id: couponId || null,
      amount_paid_cents: session.amount_total || (originalAmountCents - discountCents),
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
  const { data: activeSub } = await supabaseAdmin
    .from('subscriptions')
    .select('*, plans:plan_id (max_events, max_generations)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!activeSub) {
    return {
      hasActivePlan: false,
      canCreateEvent: false,
      canGenerate: false,
      reason: 'No active plan. Purchase a plan to create events.'
    };
  }

  const maxEvents = activeSub.plans?.max_events || 0;
  const maxGenerations = activeSub.plans?.max_generations || 0;

  const { count: eventCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('status', 'archived');

  const { count: genCount } = await supabaseAdmin
    .from('generation_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'success');

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
      ? `You've used all ${maxEvents} event(s) in your plan.`
      : !canGenerate
      ? `You've used all ${maxGenerations} AI generations in your plan.`
      : null
  };
}
