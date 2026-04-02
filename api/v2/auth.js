import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { sendCapiEvent } from './lib/meta-capi.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3/sms/send';

/**
 * Send SMS to all admins who have new_user_signup notifications enabled.
 * Must be awaited before sending the HTTP response — Vercel freezes serverless
 * functions after res.json(), killing incomplete async work. Errors are caught
 * internally and never propagate to the caller.
 */
async function sendAdminSignupNotifications(userEmail, displayName, userPhone) {
  try {
    const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
    const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
    if (!CLICKSEND_USERNAME || !CLICKSEND_API_KEY) {
      console.warn('Admin signup notification skipped — CLICKSEND_USERNAME or CLICKSEND_API_KEY not set');
      return;
    }

    // Find all admins who want signup notifications
    const { data: subscribers, error: queryError } = await supabase
      .from('admin_notification_prefs')
      .select('admin_user_id, phone')
      .eq('new_user_signup', true);

    if (queryError) {
      console.error('Admin signup notification — failed to query prefs:', queryError.message);
      return;
    }

    if (!subscribers?.length) {
      console.log('Admin signup notification — no subscribers with new_user_signup enabled');
      return;
    }

    // Build message with all available info
    let body = `New Ryvite signup: ${userEmail}`;
    if (displayName) body += ` (${displayName})`;
    if (userPhone) body += ` | Phone: ${userPhone}`;

    const credentials = Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64');

    for (const sub of subscribers) {
      const digits = (sub.phone || '').replace(/\D/g, '');
      const e164 = digits.length >= 10 ? `+1${digits.slice(-10)}` : null;
      if (!e164) {
        console.warn(`Admin signup notification — skipping subscriber ${sub.admin_user_id}: invalid phone "${sub.phone}"`);
        continue;
      }

      const response = await fetch(CLICKSEND_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`
        },
        body: JSON.stringify({
          messages: [{ to: e164, body, source: 'ryvite-admin-notif' }]
        })
      });

      const result = await response.json();
      const csMsg = result.data?.messages?.[0];

      if (csMsg?.status !== 'SUCCESS') {
        console.error(`Admin signup notification — ClickSend failed for ${e164}:`, csMsg?.status, csMsg);
      }

      // Log to notification_log (no event_id, no billing — platform cost)
      await supabase.from('notification_log').insert({
        channel: 'sms',
        recipient: digits.slice(-10),
        status: csMsg?.status === 'SUCCESS' ? 'sent' : 'failed',
        provider_id: csMsg?.message_id || null,
        error: csMsg?.status !== 'SUCCESS' ? (csMsg?.status || 'unknown') : null,
        sent_at: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('Admin signup notification error:', err);
  }
}

// Anon-key client for user-facing auth flows (OTP emails, token refresh)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PROD_URL = 'https://ryvite.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // Use origin from frontend so magic links work on preview deploys
  const clientOrigin = req.body?.origin || req.headers.origin || PROD_URL;
  // Include the intended post-login redirect path in the magic link URL
  // so it survives cross-browser/device magic link clicks
  const redirectPath = req.body?.redirectPath || '';
  const redirectTo = redirectPath
    ? `${clientOrigin}/v2/login/?redirect=${encodeURIComponent(redirectPath)}`
    : `${clientOrigin}/v2/login/`;

  try {
    if (action === 'signup') {
      const { email, displayName, phone, utm } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: displayName || '', phone: phone || '' }
      });

      if (error) {
        // User already exists — send magic link instead
        if (error.message.includes('already been registered')) {
          const { error: otpError } = await supabaseAnon.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: redirectTo }
          });
          if (otpError) return res.status(400).json({ success: false, error: otpError.message });
          return res.status(200).json({ success: true, message: 'Check your email for login link' });
        }
        return res.status(400).json({ success: false, error: error.message });
      }

      // Send magic link for the new user
      const { error: otpError } = await supabaseAnon.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });
      if (otpError) return res.status(400).json({ success: false, error: otpError.message });

      // Update profile with phone and UTM attribution if provided
      if (data.user) {
        const profileUpdate = {};
        if (phone) { profileUpdate.phone = phone; profileUpdate.display_name = displayName || ''; }
        if (utm && typeof utm === 'object') { profileUpdate.signup_utm = utm; }
        if (Object.keys(profileUpdate).length > 0) {
          await supabase.from('profiles').update(profileUpdate).eq('id', data.user.id);
        }
      }

      // Await background tasks before responding — Vercel may freeze the
      // function after res.json(), killing any incomplete async work.
      const metaEventId = crypto.randomUUID();
      await Promise.all([
        sendAdminSignupNotifications(email, displayName, phone).catch(() => {}),
        sendCapiEvent({
          eventName: 'CompleteRegistration',
          eventId: metaEventId,
          eventSourceUrl: req.headers.referer || req.headers.origin || '',
          userData: { email, phone, name: displayName },
          customData: { content_name: 'Ryvite Account', status: 'true' },
          req
        }).catch(() => {})
      ]);

      return res.status(200).json({ success: true, message: 'Check your email for login link', metaEventId });
    }

    // Silent signup: creates user + returns session token immediately (no magic link click needed)
    // Used by the create page guest onboarding flow
    if (action === 'quickSignup') {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      let userId = null;
      let isExisting = false;

      // Try to create user (auto-confirmed)
      const { data: createData, error: createError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true
      });

      if (createError) {
        if (createError.message.includes('already been registered')) {
          // User exists — look up their ID
          isExisting = true;
          const { data: { users } } = await supabase.auth.admin.listUsers();
          const existing = users.find(u => u.email === email);
          if (existing) {
            userId = existing.id;
          } else {
            return res.status(400).json({ success: false, error: 'Could not find existing account' });
          }
        } else {
          return res.status(400).json({ success: false, error: createError.message });
        }
      } else {
        userId = createData.user.id;
      }

      // Generate magic link token (without sending email)
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email
      });

      if (linkError || !linkData?.properties?.hashed_token) {
        return res.status(500).json({ success: false, error: 'Could not generate session' });
      }

      // Exchange the token for a real session
      const { data: sessionData, error: sessionError } = await supabaseAnon.auth.verifyOtp({
        token_hash: linkData.properties.hashed_token,
        type: 'magiclink'
      });

      if (sessionError || !sessionData?.session) {
        return res.status(500).json({ success: false, error: 'Could not create session: ' + (sessionError?.message || 'unknown') });
      }

      // Create profile if new user
      let metaEventId = null;
      if (!isExisting && userId) {
        await supabase.from('profiles').upsert({ id: userId, email }, { onConflict: 'id' }).catch(() => {});

        // Await background tasks — Vercel may freeze after res.json()
        metaEventId = crypto.randomUUID();
        await Promise.all([
          sendAdminSignupNotifications(email, '', '').catch(() => {}),
          sendCapiEvent({
            eventName: 'CompleteRegistration',
            eventId: metaEventId,
            eventSourceUrl: req.headers.referer || req.headers.origin || '',
            userData: { email },
            customData: { content_name: 'Guest Onboarding', status: 'true' },
            req
          }).catch(() => {})
        ]);
      }

      // Fetch profile for client
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      return res.status(200).json({
        success: true,
        accessToken: sessionData.session.access_token,
        refreshToken: sessionData.session.refresh_token,
        expiresAt: sessionData.session.expires_at,
        isNew: !isExisting,
        metaEventId: metaEventId,
        user: {
          id: userId,
          email,
          displayName: profile?.display_name || '',
          phone: profile?.phone || '',
          tier: profile?.tier || 'free',
          freeEventCredits: profile?.free_event_credits ?? 0,
          purchasedEventCredits: profile?.purchased_event_credits ?? 0,
          isGlobalAdmin: profile?.is_global_admin || false
        }
      });
    }

    if (action === 'login') {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      // Check if this email already has a profile (i.e., is an existing user).
      // signInWithOtp auto-creates new users, so we need to detect that case
      // to send admin signup notifications.
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      const { data, error } = await supabaseAnon.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });

      if (error) {
        console.error('OTP login error:', error.message, error.status);
        return res.status(400).json({ success: false, error: error.message });
      }

      // If no profile existed, this login auto-created a new user — notify admins
      // Must await before responding or Vercel may freeze the function
      if (!existingProfile) {
        await sendAdminSignupNotifications(email, '', '').catch(() => {});
      }

      return res.status(200).json({ success: true, message: 'Check your email for login link' });
    }

    if (action === 'profile') {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const token = authHeader.slice(7);
      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error || !user) {
        return res.status(401).json({ success: false, error: 'Invalid session' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      return res.status(200).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: profile?.display_name || user.user_metadata?.display_name || '',
          phone: profile?.phone || '',
          avatarUrl: profile?.avatar_url || '',
          tier: profile?.tier || 'free',
          freeEventCredits: profile?.free_event_credits || 0,
          purchasedEventCredits: profile?.purchased_event_credits || 0,
          referralSource: profile?.referral_source || null,
          createdAt: profile?.created_at || user.created_at,
          isGlobalAdmin: profile?.is_global_admin || false,
        }
      });
    }

    if (action === 'updateProfile') {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const token = authHeader.slice(7);
      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error || !user) {
        return res.status(401).json({ success: false, error: 'Invalid session' });
      }

      const { displayName, phone, referralSource, utmSource, utmMedium, utmCampaign, utmContent } = req.body || {};
      const updates = {};
      if (displayName !== undefined) updates.display_name = displayName;
      if (phone !== undefined) updates.phone = phone;
      if (referralSource !== undefined) updates.referral_source = referralSource;
      if (utmSource !== undefined) updates.utm_source = utmSource;
      if (utmMedium !== undefined) updates.utm_medium = utmMedium;
      if (utmCampaign !== undefined) updates.utm_campaign = utmCampaign;
      if (utmContent !== undefined) updates.utm_content = utmContent;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id);

      if (updateError) {
        return res.status(500).json({ success: false, error: updateError.message });
      }

      // Fetch updated profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      const updatedUser = {
        id: user.id,
        email: user.email,
        displayName: profile?.display_name || '',
        phone: profile?.phone || '',
        avatarUrl: profile?.avatar_url || '',
        tier: profile?.tier || 'free',
        referralSource: profile?.referral_source || null,
        createdAt: profile?.created_at || user.created_at
      };

      return res.status(200).json({ success: true, user: updatedUser });
    }

    if (action === 'refresh') {
      const { refreshToken } = req.body || {};
      if (!refreshToken) return res.status(400).json({ success: false, error: 'refreshToken is required' });

      const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });

      if (error || !data.session) {
        return res.status(401).json({ success: false, error: 'Refresh failed — please log in again' });
      }

      return res.status(200).json({
        success: true,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at
      });
    }

    if (action === 'createAdminAccount') {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      const FOUNDER_EMAIL = 'jake@getmrkt.com';
      if (email.toLowerCase() !== FOUNDER_EMAIL) {
        return res.status(403).json({ success: false, error: 'Only the founder account can be created via this endpoint' });
      }

      // Ensure the user exists in Supabase auth
      let userId;
      const { data: createData, error: createError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: 'Jake', phone: '' }
      });

      if (createError) {
        if (createError.message.includes('already been registered')) {
          // User exists — list users to find them
          const { data: listData } = await supabase.auth.admin.listUsers();
          const existing = listData?.users?.find(u => u.email === email.toLowerCase());
          if (!existing) return res.status(500).json({ success: false, error: 'User exists but could not be found' });
          userId = existing.id;
        } else {
          return res.status(400).json({ success: false, error: createError.message });
        }
      } else {
        userId = createData.user.id;
      }

      // Generate a magic link without sending an email (bypasses rate limit)
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: redirectTo }
      });

      if (linkError) return res.status(400).json({ success: false, error: linkError.message });

      // The link properties contain the hashed_token — build the verification URL
      const tokenHash = linkData?.properties?.hashed_token;
      if (!tokenHash) {
        return res.status(500).json({ success: false, error: 'Could not generate login link' });
      }

      const verifyUrl = `${process.env.SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;

      return res.status(200).json({
        success: true,
        message: 'Admin account ready. Use the link below to log in.',
        loginUrl: verifyUrl
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
