import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API);

const SITE_URL = process.env.SITE_URL || 'https://ryvite.com';

function buildMagicLinkEmail(confirmUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#FFFAF5;font-family:'Inter','Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFFAF5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td align="center" style="padding-bottom:0;">
          <div style="background:linear-gradient(135deg,#1A1A2E 0%,#0f3460 100%);border-radius:12px 12px 0 0;padding:32px 40px;">
            <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;font-size:28px;color:#FFFFFF;letter-spacing:-0.5px;">Ryvite</h1>
            <p style="margin:4px 0 0;font-size:13px;color:#FFB74D;font-style:italic;">Prompt to Party</p>
          </div>
        </td></tr>
        <tr><td style="background:#FFFFFF;padding:40px;border-radius:0 0 12px 12px;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
          <h2 style="margin:0 0 16px;font-family:'Playfair Display',Georgia,serif;font-size:22px;color:#1A1A2E;">Your login link</h2>
          <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6;">Tap the button below to securely sign in to your Ryvite account. This link expires in 1 hour.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <a href="${confirmUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#E94560,#FF6B6B);color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:50px;font-family:'Inter','Helvetica Neue',Arial,sans-serif;">Sign In to Ryvite</a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:13px;color:#D1D5DB;line-height:1.5;">If you didn\u2019t request this link, you can safely ignore this email.</p>
          <p style="margin:0;font-size:13px;color:#D1D5DB;line-height:1.5;">If the button doesn\u2019t work, copy and paste this URL into your browser:</p>
          <p style="margin:8px 0 0;font-size:12px;color:#A78BFA;word-break:break-all;">${confirmUrl}</p>
        </td></tr>
        <tr><td align="center" style="padding:24px 0 0;">
          <p style="margin:0;font-size:12px;color:#D1D5DB;">&copy; 2026 Ryvite &mdash; Beautiful invitations, effortlessly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildWelcomeEmail(confirmUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#FFFAF5;font-family:'Inter','Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFFAF5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td align="center" style="padding-bottom:0;">
          <div style="background:linear-gradient(135deg,#1A1A2E 0%,#0f3460 100%);border-radius:12px 12px 0 0;padding:32px 40px;">
            <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;font-size:28px;color:#FFFFFF;letter-spacing:-0.5px;">Ryvite</h1>
            <p style="margin:4px 0 0;font-size:13px;color:#FFB74D;font-style:italic;">Prompt to Party</p>
          </div>
        </td></tr>
        <tr><td style="background:#FFFFFF;padding:40px;border-radius:0 0 12px 12px;box-shadow:0 4px 24px rgba(26,26,46,0.08);">
          <h2 style="margin:0 0 16px;font-family:'Playfair Display',Georgia,serif;font-size:22px;color:#1A1A2E;">Welcome to Ryvite!</h2>
          <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6;">Thanks for signing up! Tap the button below to sign in and start creating beautiful AI-designed event invitations.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <a href="${confirmUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#E94560,#FF6B6B);color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:50px;font-family:'Inter','Helvetica Neue',Arial,sans-serif;">Get Started</a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:13px;color:#D1D5DB;line-height:1.5;">If you didn\u2019t create a Ryvite account, you can safely ignore this email.</p>
          <p style="margin:0;font-size:13px;color:#D1D5DB;line-height:1.5;">If the button doesn\u2019t work, copy and paste this URL:</p>
          <p style="margin:8px 0 0;font-size:12px;color:#A78BFA;word-break:break-all;">${confirmUrl}</p>
        </td></tr>
        <tr><td align="center" style="padding:24px 0 0;">
          <p style="margin:0;font-size:12px;color:#D1D5DB;">&copy; 2026 Ryvite &mdash; Beautiful invitations, effortlessly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendBrandedMagicLink(email, type) {
  const redirectTo = `${SITE_URL}/v2/login/`;

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo }
  });

  if (error) throw error;

  // The hashed_token is the token to use in the verification URL
  // Build the verification URL that redirects to our site
  const confirmUrl = `${process.env.SUPABASE_URL}/auth/v1/verify?token=${data.properties.hashed_token}&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;

  const html = type === 'welcome'
    ? buildWelcomeEmail(confirmUrl)
    : buildMagicLinkEmail(confirmUrl);

  const subject = type === 'welcome'
    ? 'Welcome to Ryvite!'
    : 'Your Ryvite login link';

  await resend.emails.send({
    from: 'Ryvite <onboarding@resend.dev>',
    to: email,
    subject,
    html
  });
}

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

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: displayName || '', phone: phone || '' }
      });

      if (error) {
        // User might already exist — send magic link instead
        if (error.message.includes('already been registered')) {
          await sendBrandedMagicLink(email, 'login');
          return res.status(200).json({ success: true, message: 'Check your email for login link' });
        }
        return res.status(400).json({ success: false, error: error.message });
      }

      // Send branded welcome magic link
      await sendBrandedMagicLink(email, 'welcome');

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

      // Verify user exists before sending link
      const { data: { users } } = await supabase.auth.admin.listUsers();
      const userExists = users.some(u => u.email === email);
      if (!userExists) {
        return res.status(400).json({ success: false, error: 'No account found with that email. Please sign up first.' });
      }

      await sendBrandedMagicLink(email, 'login');

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
