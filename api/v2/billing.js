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

// ---- PRICING: SINGLE SOURCE OF TRUTH ----
const EVENT_PRICE_CENTS = 499; // $4.99 per event

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
    try {
      await stripe.customers.retrieve(profile.stripe_customer_id);
      return profile.stripe_customer_id;
    } catch (e) {
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
          billingType: p.billing_type || 'fixed',
          maxEvents: p.max_events,
          maxGenerations: p.max_generations,
          features: p.features || []
        })),
        eventPriceCents: EVENT_PRICE_CENTS
      });
    }

    // ---- VALIDATE COUPON (public) ----
    if (action === 'validateCoupon') {
      const { code } = req.query;
      if (!code) return res.status(400).json({ error: 'Coupon code required' });

      const user = await getUser(req);
      const result = await validateCoupon(code, 'event_499', user?.id, user?.email);

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
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        eventPriceCents: EVENT_PRICE_CENTS
      });
    }

    // ---- AUTHENTICATED ENDPOINTS ----
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // ---- CHECK EVENT ACCESS ----
    // Determines what a user can do based on payment status
    if (action === 'checkEventAccess') {
      const eventId = req.query.eventId;
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      // Get the event
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, user_id, payment_status, sms_limit, sms_sent_count')
        .eq('id', eventId)
        .single();

      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.user_id !== user.id) return res.status(403).json({ error: 'Not your event' });

      // Count generations for this specific event
      const { count: genCount } = await supabaseAdmin
        .from('generation_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('status', 'success');

      const isFirstEvent = event.payment_status === 'free';
      const isFreeEvent = event.payment_status === 'free';
      const isPaid = event.payment_status === 'paid';
      const requiresPayment = !isFreeEvent && !isPaid;

      // Generation limits: free tier = 1, paid = soft cap 10 (not enforced server-side)
      const generationLimit = isFreeEvent ? 1 : 10;
      const smsLimit = isFreeEvent ? 0 : (event.sms_limit || 1000);

      return res.status(200).json({
        success: true,
        isFirstEvent,
        isPaid,
        isFreeEvent,
        requiresPayment,
        canGenerate: true, // AI generation is never gated behind payment
        canSendSMS: isFreeEvent ? false : isPaid,
        canSendEmail: true,
        generationCount: genCount || 0,
        generationLimit,
        softCapReached: (genCount || 0) >= generationLimit && !isFreeEvent,
        smsLimit,
        smsSentCount: event.sms_sent_count || 0,
        eventPaymentStatus: event.payment_status,
        eventPriceCents: EVENT_PRICE_CENTS
      });
    }

    // ---- CHECK SMS LIMIT ----
    if (action === 'checkSMSLimit') {
      const eventId = req.query.eventId;
      const contactCount = parseInt(req.query.contactCount) || 0;
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, user_id, payment_status, sms_limit, sms_sent_count')
        .eq('id', eventId)
        .single();

      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.user_id !== user.id) return res.status(403).json({ error: 'Not your event' });

      if (event.payment_status === 'free') {
        return res.status(200).json({
          success: true,
          smsSentCount: 0,
          smsLimit: 0,
          remaining: 0,
          wouldExceed: true,
          canSend: false,
          reason: 'SMS is not available on the free tier. Upgrade to send SMS invites.'
        });
      }

      const smsSent = event.sms_sent_count || 0;
      const limit = event.sms_limit || 1000;
      const remaining = Math.max(0, limit - smsSent);
      const wouldExceed = contactCount > 0 && (smsSent + contactCount) > limit;

      return res.status(200).json({
        success: true,
        smsSentCount: smsSent,
        smsLimit: limit,
        remaining,
        wouldExceed,
        canSend: !wouldExceed && remaining > 0
      });
    }

    // ---- REQUEST SMS LIMIT INCREASE ----
    if (action === 'requestSMSIncrease') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, eventTitle, requestedCount, guestCount } = req.body || {};
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, user_id, sms_limit, sms_sent_count')
        .eq('id', eventId)
        .single();

      if (!event || event.user_id !== user.id) {
        return res.status(403).json({ error: 'Not your event' });
      }

      // Check for existing pending request
      const { data: existingRequest } = await supabaseAdmin
        .from('sms_approvals')
        .select('id')
        .eq('event_id', eventId)
        .eq('status', 'pending')
        .maybeSingle();

      if (existingRequest) {
        return res.status(200).json({ success: true, message: 'Request already pending', alreadyPending: true });
      }

      const { error: insertError } = await supabaseAdmin
        .from('sms_approvals')
        .insert({
          event_id: eventId,
          user_id: user.id,
          user_email: user.email,
          event_title: eventTitle || 'Untitled Event',
          current_sms_sent: event.sms_sent_count || 0,
          current_limit: event.sms_limit || 1000,
          requested_count: requestedCount || 0,
          guest_count: guestCount || 0,
          status: 'pending'
        });

      if (insertError) return res.status(400).json({ error: insertError.message });

      return res.status(200).json({ success: true, message: 'SMS limit increase request submitted' });
    }

    // ---- APPROVE SMS LIMIT INCREASE (admin only) ----
    if (action === 'approveSMSIncrease') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      // Verify global admin
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('is_global_admin')
        .eq('id', user.id)
        .single();

      if (!profile?.is_global_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { approvalId, eventId, newLimit, action: approvalAction, reason } = req.body || {};
      if (!approvalId || !eventId) return res.status(400).json({ error: 'approvalId and eventId required' });

      const isApproved = approvalAction !== 'deny';

      // Update the approval record
      await supabaseAdmin
        .from('sms_approvals')
        .update({
          status: isApproved ? 'approved' : 'denied',
          approved_limit: isApproved ? (newLimit || 2000) : null,
          approved_at: new Date().toISOString(),
          approved_by: user.id,
          reason: reason || null
        })
        .eq('id', approvalId);

      // If approved, update the event's SMS limit
      if (isApproved) {
        await supabaseAdmin
          .from('events')
          .update({ sms_limit: newLimit || 2000 })
          .eq('id', eventId);
      }

      return res.status(200).json({ success: true, approved: isApproved });
    }

    // ---- LIST SMS APPROVALS (admin only) ----
    if (action === 'listSMSApprovals') {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('is_global_admin')
        .eq('id', user.id)
        .single();

      if (!profile?.is_global_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { data: approvals } = await supabaseAdmin
        .from('sms_approvals')
        .select('*')
        .order('created_at', { ascending: false });

      return res.status(200).json({ success: true, approvals: approvals || [] });
    }

    // ---- CREATE CHECKOUT SESSION ----
    if (action === 'checkout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, eventTitle, couponCode, returnUrl, embedded, successUrl, cancelUrl } = req.body || {};
      if (!eventId) return res.status(400).json({ error: 'eventId required' });

      // Verify user owns this event
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, user_id, title, payment_status')
        .eq('id', eventId)
        .single();

      if (!event || event.user_id !== user.id) {
        return res.status(403).json({ error: 'Not your event' });
      }

      if (event.payment_status === 'paid') {
        return res.status(200).json({ success: true, message: 'Event already paid', alreadyPaid: true });
      }

      // Calculate price with optional coupon
      let discount = null;
      let coupon = null;
      let discountCents = 0;
      if (couponCode) {
        const couponResult = await validateCoupon(couponCode, 'event_499', user.id, user.email);
        if (!couponResult.valid) {
          return res.status(400).json({ error: couponResult.error });
        }
        coupon = couponResult.coupon;
        discount = couponResult.discount;
      }

      let finalAmountCents = EVENT_PRICE_CENTS;
      if (discount) {
        if (discount.type === 'percent') {
          discountCents = Math.round(EVENT_PRICE_CENTS * discount.percent / 100);
        } else {
          discountCents = discount.amountCents;
        }
        finalAmountCents = Math.max(0, EVENT_PRICE_CENTS - discountCents);
      }

      const customerId = await getOrCreateStripeCustomer(user);
      const baseUrl = getBaseUrl(req);
      const title = eventTitle || event.title || 'Event';

      const sessionParams = {
        customer: customerId,
        ...(!embedded && { payment_method_types: ['card'] }),
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Ryvite Event: ${title}`,
              description: 'AI-designed custom invitation with unlimited guests, SMS + email delivery, and RSVP tracking.'
            },
            unit_amount: finalAmountCents
          },
          quantity: 1
        }],
        mode: 'payment',
        payment_intent_data: { setup_future_usage: 'off_session' },
        metadata: {
          supabase_user_id: user.id,
          event_id: eventId,
          event_title: title,
          coupon_id: coupon?.id || '',
          coupon_code: couponCode || '',
          original_amount_cents: String(EVENT_PRICE_CENTS),
          discount_cents: String(discountCents),
          checkout_type: 'event_payment'
        }
      };

      if (embedded) {
        sessionParams.ui_mode = 'embedded';
        sessionParams.redirect_on_completion = 'if_required';
        sessionParams.return_url = `${baseUrl}${returnUrl || '/v2/dashboard/'}?event=${eventId}&payment=success&session_id={CHECKOUT_SESSION_ID}`;
      } else {
        // Allow custom redirect URLs (e.g., back to create page after design-chat upgrade)
        const defaultSuccess = `/v2/dashboard/?event=${eventId}&payment=success&session_id={CHECKOUT_SESSION_ID}`;
        const defaultCancel = `/v2/dashboard/?event=${eventId}&payment=cancelled`;
        const finalSuccessPath = successUrl ? `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}` : defaultSuccess;
        const finalCancelPath = cancelUrl || defaultCancel;
        sessionParams.success_url = `${baseUrl}${finalSuccessPath}`;
        sessionParams.cancel_url = `${baseUrl}${finalCancelPath}`;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      return res.status(200).json({
        success: true,
        sessionId: session.id,
        checkoutUrl: embedded ? null : session.url,
        url: embedded ? null : session.url,
        clientSecret: embedded ? session.client_secret : null
      });
    }

    // ---- BUY EVENT CREDITS (pre-purchase) ----
    if (action === 'buy-credits') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { quantity: rawQty, couponCode } = req.body || {};
      const quantity = Math.max(1, Math.min(10, parseInt(rawQty) || 1));

      let discount = null;
      let coupon = null;
      let discountCents = 0;
      if (couponCode) {
        const couponResult = await validateCoupon(couponCode, 'event_499', user.id, user.email);
        if (!couponResult.valid) {
          return res.status(400).json({ error: couponResult.error });
        }
        coupon = couponResult.coupon;
        discount = couponResult.discount;
      }

      let unitPriceCents = EVENT_PRICE_CENTS;
      if (discount) {
        if (discount.type === 'percent') {
          discountCents = Math.round(EVENT_PRICE_CENTS * discount.percent / 100);
        } else {
          discountCents = discount.amountCents;
        }
        unitPriceCents = Math.max(0, EVENT_PRICE_CENTS - discountCents);
      }

      const totalCents = unitPriceCents * quantity;
      const customerId = await getOrCreateStripeCustomer(user);

      // Check for saved payment method — charge instantly if available
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
        limit: 1
      });

      if (paymentMethods.data.length > 0) {
        // Instant charge with saved card
        const savedCard = paymentMethods.data[0];
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: totalCents,
            currency: 'usd',
            customer: customerId,
            payment_method: savedCard.id,
            off_session: true,
            confirm: true,
            metadata: {
              supabase_user_id: user.id,
              checkout_type: 'credit_purchase',
              quantity: String(quantity),
              coupon_id: coupon?.id || '',
              coupon_code: couponCode || '',
              original_amount_cents: String(EVENT_PRICE_CENTS),
              discount_cents: String(discountCents)
            }
          });

          if (paymentIntent.status === 'succeeded') {
            // Process immediately — increment credits, billing history
            await processCreditPurchase(user.id, quantity, totalCents, paymentIntent.id, customerId, coupon?.id);
            return res.status(200).json({
              success: true,
              charged: true,
              quantity,
              amountCents: totalCents,
              cardLast4: savedCard.card.last4,
              cardBrand: savedCard.card.brand
            });
          }

          // 3D Secure or other action required — fall through to embedded checkout
        } catch (cardErr) {
          // Card declined or error — fall through to embedded checkout
          console.error('Saved card charge failed:', cardErr.message);
        }
      }

      // No saved card or charge failed — use embedded checkout
      const baseUrl = getBaseUrl(req);
      const sessionParams = {
        customer: customerId,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: quantity === 1 ? 'Ryvite Event Credit' : `Ryvite Event Credits (×${quantity})`,
              description: 'Pre-purchase event credits for AI-designed invitations with unlimited guests, SMS + email delivery, and RSVP tracking.'
            },
            unit_amount: unitPriceCents
          },
          quantity
        }],
        mode: 'payment',
        ui_mode: 'embedded',
        redirect_on_completion: 'never',
        payment_intent_data: { setup_future_usage: 'off_session' },
        metadata: {
          supabase_user_id: user.id,
          checkout_type: 'credit_purchase',
          quantity: String(quantity),
          coupon_id: coupon?.id || '',
          coupon_code: couponCode || '',
          original_amount_cents: String(EVENT_PRICE_CENTS),
          discount_cents: String(discountCents)
        }
      };

      const session = await stripe.checkout.sessions.create(sessionParams);

      return res.status(200).json({
        success: true,
        charged: false,
        sessionId: session.id,
        clientSecret: session.client_secret
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

    // ---- DELETE PAYMENT METHOD ----
    if (action === 'delete-payment-method') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { paymentMethodId } = req.body || {};
      if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

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

    // ---- GET USER SUBSCRIPTION / PAYMENT INFO ----
    if (action === 'subscription') {
      // Count events by payment status and get credit balances in parallel
      const [eventsRes, genRes, smsRes, profileRes] = await Promise.all([
        supabaseAdmin.from('events').select('id, payment_status').eq('user_id', user.id),
        supabaseAdmin.from('generation_log').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'success').not('event_id', 'is', null),
        supabaseAdmin.from('sms_messages').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabaseAdmin.from('profiles').select('purchased_event_credits, free_event_credits').eq('id', user.id).single()
      ]);

      const events = eventsRes.data || [];
      const totalEvents = events.length;
      const paidEvents = events.filter(e => e.payment_status === 'paid').length;
      const freeEvents = events.filter(e => e.payment_status === 'free').length;
      const purchasedCredits = profileRes.data?.purchased_event_credits || 0;
      const freeCredits = profileRes.data?.free_event_credits || 0;

      return res.status(200).json({
        success: true,
        pricing: {
          model: 'per_event',
          eventPriceCents: EVENT_PRICE_CENTS
        },
        usage: {
          totalEvents,
          paidEvents,
          freeEvents,
          generationsUsed: genRes.count || 0,
          smsSent: smsRes.count || 0
        },
        credits: {
          purchased: purchasedCredits,
          free: freeCredits,
          total: purchasedCredits + freeCredits
        }
      });
    }

    // ---- VERIFY CHECKOUT SESSION (fallback if webhook is slow) ----
    if (action === 'verify-session') {
      const sessionId = req.query.session_id || (req.body && req.body.session_id);
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'session_id is required' });
      }

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== 'paid') {
          return res.status(200).json({ success: false, error: 'Payment not completed yet', paymentStatus: session.payment_status });
        }

        const metadata = session.metadata || {};
        const metaUserId = metadata.supabase_user_id;
        const checkoutType = metadata.checkout_type || 'event_payment';

        if (!metaUserId) {
          return res.status(400).json({ success: false, error: 'Missing metadata in checkout session' });
        }

        if (metaUserId !== user.id) {
          return res.status(403).json({ success: false, error: 'Session does not belong to this user' });
        }

        // Credit purchase — no event to check
        if (checkoutType === 'credit_purchase') {
          // Check if already processed by looking at billing_history
          const { data: existing } = await supabaseAdmin
            .from('billing_history')
            .select('id')
            .eq('stripe_payment_intent_id', session.payment_intent)
            .single();

          if (existing) {
            return res.status(200).json({ success: true, type: 'credit_purchase', source: 'already_processed' });
          }

          await processEventPayment(session);
          return res.status(200).json({ success: true, type: 'credit_purchase', source: 'verified' });
        }

        // Standard event payment
        const eventId = metadata.event_id;
        if (!eventId) {
          return res.status(400).json({ success: false, error: 'Missing eventId in checkout session' });
        }

        // Check if already processed
        const { data: event } = await supabaseAdmin
          .from('events')
          .select('payment_status')
          .eq('id', eventId)
          .single();

        if (event?.payment_status === 'paid') {
          return res.status(200).json({ success: true, eventId, source: 'already_paid' });
        }

        // Webhook hasn't processed yet — do it now
        await processEventPayment(session);

        return res.status(200).json({ success: true, eventId, source: 'verified' });
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

    // ---- CHECK LIMITS (simplified) ----
    if (action === 'checkLimits') {
      const limitCheck = await checkUserLimits(user.id);
      return res.status(200).json({ success: true, ...limitCheck });
    }

    // ---- ADMIN: LIST PAYMENTS (admin only) ----
    if (action === 'adminPayments') {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('is_global_admin')
        .eq('id', user.id)
        .single();

      if (!profile?.is_global_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { data: payments } = await supabaseAdmin
        .from('billing_history')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      // Summary stats
      const allPayments = (payments || []).filter(p => p.status === 'succeeded');
      const totalRevenueCents = allPayments.reduce((sum, p) => sum + (p.amount_cents || 0), 0);

      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const thisWeek = new Date(now);
      thisWeek.setDate(thisWeek.getDate() - 7);

      const monthRevenue = allPayments
        .filter(p => new Date(p.created_at) >= thisMonth)
        .reduce((sum, p) => sum + (p.amount_cents || 0), 0);
      const weekRevenue = allPayments
        .filter(p => new Date(p.created_at) >= thisWeek)
        .reduce((sum, p) => sum + (p.amount_cents || 0), 0);

      return res.status(200).json({
        success: true,
        payments: payments || [],
        summary: {
          totalRevenueCents,
          totalPaidEvents: allPayments.length,
          monthRevenueCents: monthRevenue,
          weekRevenueCents: weekRevenue
        }
      });
    }

    // ---- ADMIN: LIST USERS (admin only) ----
    if (action === 'adminUsers') {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('is_global_admin')
        .eq('id', user.id)
        .single();

      if (!profile?.is_global_admin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, email, display_name, created_at')
        .order('created_at', { ascending: false });

      // Get event counts per user
      const { data: events } = await supabaseAdmin
        .from('events')
        .select('user_id, payment_status');

      // Get SMS counts per user
      const { data: smsData } = await supabaseAdmin
        .from('sms_messages')
        .select('user_id');

      const eventsByUser = {};
      for (const e of (events || [])) {
        if (!eventsByUser[e.user_id]) eventsByUser[e.user_id] = { total: 0, paid: 0 };
        eventsByUser[e.user_id].total++;
        if (e.payment_status === 'paid') eventsByUser[e.user_id].paid++;
      }

      const smsByUser = {};
      for (const s of (smsData || [])) {
        smsByUser[s.user_id] = (smsByUser[s.user_id] || 0) + 1;
      }

      return res.status(200).json({
        success: true,
        users: (profiles || []).map(p => ({
          id: p.id,
          email: p.email,
          displayName: p.display_name,
          createdAt: p.created_at,
          events: eventsByUser[p.id]?.total || 0,
          paidEvents: eventsByUser[p.id]?.paid || 0,
          smsSent: smsByUser[p.id] || 0
        })),
        totals: {
          users: (profiles || []).length,
          events: (events || []).length,
          paidEvents: (events || []).filter(e => e.payment_status === 'paid').length,
          totalSMS: (smsData || []).length
        }
      });
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
        await processEventPayment(event.data.object);
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

// ---- PROCESS CREDIT PURCHASE (direct charge) ----
// Called when saved card is charged instantly for credit purchase
async function processCreditPurchase(userId, quantity, amountCents, paymentIntentId, customerId, couponId) {
  // Increment purchased_event_credits
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('purchased_event_credits')
    .eq('id', userId)
    .single();

  await supabaseAdmin
    .from('profiles')
    .update({
      purchased_event_credits: ((profile?.purchased_event_credits || 0) + quantity),
      stripe_customer_id: customerId
    })
    .eq('id', userId);

  // Create billing history record
  let receiptUrl = null;
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.latest_charge) {
        const charge = await stripe.charges.retrieve(pi.latest_charge);
        receiptUrl = charge.receipt_url || null;
      }
    } catch (e) { /* Non-critical */ }
  }

  await supabaseAdmin
    .from('billing_history')
    .insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntentId,
      amount_cents: amountCents,
      currency: 'usd',
      status: 'succeeded',
      description: quantity === 1 ? 'Event credit purchase' : `Event credit purchase (×${quantity})`,
      receipt_url: receiptUrl
    });

  // Handle coupon redemption
  if (couponId) {
    await supabaseAdmin.from('coupon_redemptions').insert({ coupon_id: couponId, user_id: userId });
    await supabaseAdmin.rpc('increment_coupon_usage', { coupon_uuid: couponId }).catch(async () => {
      const { data: c } = await supabaseAdmin.from('coupons').select('times_used').eq('id', couponId).single();
      if (c) await supabaseAdmin.from('coupons').update({ times_used: (c.times_used || 0) + 1 }).eq('id', couponId);
    });
  }
}

// ---- PROCESS EVENT PAYMENT ----
// Called by webhook or verify-session to mark event as paid or add credits
async function processEventPayment(session) {
  const metadata = session.metadata || {};
  const userId = metadata.supabase_user_id;
  const checkoutType = metadata.checkout_type || 'event_payment';
  const couponId = metadata.coupon_id || null;
  const discountCents = parseInt(metadata.discount_cents) || 0;

  if (!userId) {
    console.error('Missing userId in checkout metadata');
    return;
  }

  // Handle credit pre-purchase (no specific event)
  if (checkoutType === 'credit_purchase') {
    const quantity = parseInt(metadata.quantity) || 1;

    // Increment purchased_event_credits
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('purchased_event_credits')
      .eq('id', userId)
      .single();

    await supabaseAdmin
      .from('profiles')
      .update({
        purchased_event_credits: ((profile?.purchased_event_credits || 0) + quantity),
        stripe_customer_id: session.customer
      })
      .eq('id', userId);

    // Create billing history record
    await supabaseAdmin
      .from('billing_history')
      .insert({
        user_id: userId,
        stripe_payment_intent_id: session.payment_intent,
        amount_cents: session.amount_total || (EVENT_PRICE_CENTS * quantity),
        currency: session.currency || 'usd',
        status: 'succeeded',
        description: quantity === 1 ? 'Event credit purchase' : `Event credit purchase (×${quantity})`,
        receipt_url: null
      });

    // Handle coupon redemption
    if (couponId) {
      await supabaseAdmin.from('coupon_redemptions').insert({ coupon_id: couponId, user_id: userId });
      await supabaseAdmin.rpc('increment_coupon_usage', { coupon_uuid: couponId }).catch(async () => {
        const { data: c } = await supabaseAdmin.from('coupons').select('times_used').eq('id', couponId).single();
        if (c) await supabaseAdmin.from('coupons').update({ times_used: (c.times_used || 0) + 1 }).eq('id', couponId);
      });
    }

    // Try to get receipt URL
    if (session.payment_intent) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        if (paymentIntent.latest_charge) {
          const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
          if (charge.receipt_url) {
            await supabaseAdmin.from('billing_history').update({ receipt_url: charge.receipt_url }).eq('stripe_payment_intent_id', session.payment_intent);
          }
        }
      } catch (e) { /* Non-critical */ }
    }

    return;
  }

  // Standard event payment flow
  const eventId = metadata.event_id;
  if (!eventId) {
    console.error('Missing eventId in checkout metadata');
    return;
  }

  // Update event payment status
  const { error: updateError } = await supabaseAdmin
    .from('events')
    .update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      sms_limit: 1000
    })
    .eq('id', eventId);

  if (updateError) {
    console.error('Failed to update event payment status:', updateError);
  }

  // Create billing history record
  await supabaseAdmin
    .from('billing_history')
    .insert({
      user_id: userId,
      stripe_payment_intent_id: session.payment_intent,
      amount_cents: session.amount_total || EVENT_PRICE_CENTS,
      currency: session.currency || 'usd',
      status: 'succeeded',
      description: `Event payment: ${metadata.event_title || 'Event'}`,
      receipt_url: null
    });

  // Update profile with Stripe customer
  await supabaseAdmin
    .from('profiles')
    .update({ stripe_customer_id: session.customer })
    .eq('id', userId);

  // Handle coupon redemption
  if (couponId) {
    await supabaseAdmin
      .from('coupon_redemptions')
      .insert({
        coupon_id: couponId,
        user_id: userId
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

  // Try to get receipt URL
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
      // Non-critical
    }
  }
}

async function handleRefund(charge) {
  if (!charge.payment_intent) return;

  // Update billing history
  await supabaseAdmin
    .from('billing_history')
    .update({ status: 'refunded' })
    .eq('stripe_payment_intent_id', charge.payment_intent);

  // Find which event this was for and mark as refunded
  const { data: historyRows } = await supabaseAdmin
    .from('billing_history')
    .select('description')
    .eq('stripe_payment_intent_id', charge.payment_intent)
    .limit(1);

  // Best-effort: mark event as refunded if we can find it
  // The event_id isn't stored in billing_history, but we can get it from Stripe metadata
  try {
    const pi = await stripe.paymentIntents.retrieve(charge.payment_intent);
    const eventId = pi.metadata?.event_id;
    if (eventId) {
      await supabaseAdmin
        .from('events')
        .update({ payment_status: 'refunded' })
        .eq('id', eventId);
    }
  } catch (e) {
    // Non-critical
  }
}

// ---- COUPON VALIDATION ----
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

// ---- SIMPLIFIED PLAN LIMIT CHECKING ----
export async function checkUserLimits(userId) {
  // Count user's events
  const { count: eventCount } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Under the new model, users can always create events.
  // Payment gate appears at publish/send time, not creation.
  return {
    hasActivePlan: true,
    canCreateEvent: true,
    canGenerate: true,
    eventsUsed: eventCount || 0,
    eventPriceCents: EVENT_PRICE_CENTS,
    reason: null
  };
}
