import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
  const redirectTo = `${clientOrigin}/v2/login/`;

  try {
    if (action === 'signup') {
      const { email, displayName, phone } = req.body || {};
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

      // Update profile with phone if provided
      if (phone && data.user) {
        await supabase
          .from('profiles')
          .update({ phone, display_name: displayName || '' })
          .eq('id', data.user.id);
      }

      return res.status(200).json({ success: true, message: 'Check your email for login link' });
    }

    if (action === 'login') {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      const { data, error } = await supabaseAnon.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });

      if (error) {
        console.error('OTP login error:', error.message, error.status);
        return res.status(400).json({ success: false, error: error.message });
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

      // Fetch active subscription
      const { data: activeSub } = await supabase
        .from('subscriptions')
        .select('id, status, plan_id, events_used, generations_used')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let planInfo = null;
      if (activeSub) {
        const { data: plan } = await supabase
          .from('plans')
          .select('name, display_name, max_events, max_generations')
          .eq('id', activeSub.plan_id)
          .single();
        planInfo = plan;
      }

      return res.status(200).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: profile?.display_name || user.user_metadata?.display_name || '',
          phone: profile?.phone || '',
          avatarUrl: profile?.avatar_url || '',
          tier: profile?.tier || 'free',
          referralSource: profile?.referral_source || null,
          createdAt: profile?.created_at || user.created_at,
          hasActivePlan: !!activeSub,
          subscription: activeSub ? {
            id: activeSub.id,
            planName: planInfo?.display_name || '',
            maxEvents: planInfo?.max_events || 0,
            maxGenerations: planInfo?.max_generations || 0,
            eventsUsed: activeSub.events_used || 0,
            generationsUsed: activeSub.generations_used || 0
          } : null
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

      const { displayName, phone, referralSource } = req.body || {};
      const updates = {};
      if (displayName !== undefined) updates.display_name = displayName;
      if (phone !== undefined) updates.phone = phone;
      if (referralSource !== undefined) updates.referral_source = referralSource;

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
