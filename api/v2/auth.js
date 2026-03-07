import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'signup') {
      const { email, displayName, phone } = req.body || {};
      if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://ryvite.com';

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: displayName || '', phone: phone || '' }
      });

      if (error) {
        // User might already exist — send magic link instead
        if (error.message.includes('already been registered')) {
          const { error: otpError } = await supabase.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: `${baseUrl}/v2/login/` }
          });
          if (otpError) return res.status(400).json({ success: false, error: otpError.message });
          return res.status(200).json({ success: true, message: 'Check your email for login link' });
        }
        return res.status(400).json({ success: false, error: error.message });
      }

      // Send magic link for the new user
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${baseUrl}/v2/login/` }
      });

      if (otpError) {
        return res.status(400).json({ success: false, error: otpError.message });
      }

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

      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://ryvite.com';

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${baseUrl}/v2/login/` }
      });

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, message: 'Check your email for login link' });
    }

    if (action === 'profile') {
      // Get user profile from session token
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
          phone: profile?.phone || ''
        }
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
