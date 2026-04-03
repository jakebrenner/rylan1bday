import { Resend } from 'resend';
import { reportApiError } from './lib/error-reporter.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const PROD_URL = 'https://ryvite.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    const { userEmail, userName, eventTitle, newLimit } = req.body || {};

    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail required' });
    }

    const dashboardUrl = `${PROD_URL}/v2/dashboard/`;
    const limitDisplay = newLimit >= 999999 ? 'unlimited' : newLimit?.toLocaleString() || '2,000';
    const firstName = userName ? userName.split(' ')[0] : 'there';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: #1A1A2E; padding: 32px 40px; border-radius: 16px 16px 0 0; text-align: center;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; color: #FFFAF5; font-size: 28px; font-weight: 700;">
                You're Good to Go!
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: #FFFAF5; padding: 40px;">
              <p style="margin: 0 0 16px; color: #1A1A2E; font-size: 16px; line-height: 1.6;">
                Hey ${firstName},
              </p>
              <p style="margin: 0 0 24px; color: #1A1A2E; font-size: 16px; line-height: 1.6;">
                Great news! Your SMS limit for <strong>${eventTitle || 'your event'}</strong> has been increased to <strong>${limitDisplay}</strong> messages. You can continue sending invites right away.
              </p>

              <div style="background-color: #F0FDF4; border-radius: 12px; padding: 20px; margin-bottom: 24px; text-align: center;">
                <p style="margin: 0; color: #4ECDC4; font-size: 14px; font-weight: 600;">New SMS Limit</p>
                <p style="margin: 8px 0 0; color: #1A1A2E; font-size: 32px; font-weight: 700;">${limitDisplay}</p>
              </div>

              <div style="text-align: center; margin: 32px 0;">
                <a href="${dashboardUrl}" style="display: inline-block; background-color: #E94560; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-size: 16px; font-weight: 600;">
                  Back to Dashboard
                </a>
              </div>

              <p style="margin: 0; color: #6B7280; font-size: 14px; line-height: 1.6; text-align: center;">
                Need help? Just reply to this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #1A1A2E; padding: 20px 40px; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #6B7280; font-size: 12px;">Built with love for Rylan</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await resend.emails.send({
      from: 'Ryvite <hello@ryvite.com>',
      to: userEmail,
      subject: `Your SMS limit has been increased for ${eventTitle || 'your event'}`,
      html
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('User notification error:', err);
    await reportApiError({ endpoint: '/api/v2/user-notification', action: req.query?.action || 'unknown', error: err, requestBody: req.body, req }).catch(() => {});
    return res.status(500).json({ error: err.message || 'Failed to send notification' });
  }
}
