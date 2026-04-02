import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'support@ryvite.com';
const PROD_URL = 'https://ryvite.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    const { eventId, eventTitle, userEmail, userName, smsSentCount, smsLimit, guestCount } = req.body || {};

    if (!eventId || !eventTitle) {
      return res.status(400).json({ error: 'eventId and eventTitle required' });
    }

    const subject = `SMS Limit Hit: ${eventTitle} (${smsSentCount || 0}/${smsLimit || 1000})`;
    const adminPanelUrl = `${PROD_URL}/v2/admin-panel/?tab=approvals&eventId=${eventId}`;

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
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; color: #FFFAF5; font-size: 24px; font-weight: 700;">
                SMS Limit Alert
              </h1>
              <p style="margin: 8px 0 0; color: #A78BFA; font-size: 14px;">Ryvite Admin Notification</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: #FFFAF5; padding: 40px;">
              <p style="margin: 0 0 24px; color: #1A1A2E; font-size: 16px; line-height: 1.6;">
                A user has reached their SMS limit and is requesting approval for more messages.
              </p>

              <table width="100%" cellpadding="12" cellspacing="0" style="background-color: #FFF5E6; border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="color: #6B7280; font-size: 13px; border-bottom: 1px solid #FFE8CC; padding: 12px 16px;">Event</td>
                  <td style="color: #1A1A2E; font-size: 14px; font-weight: 600; border-bottom: 1px solid #FFE8CC; padding: 12px 16px;">${eventTitle}</td>
                </tr>
                <tr>
                  <td style="color: #6B7280; font-size: 13px; border-bottom: 1px solid #FFE8CC; padding: 12px 16px;">Event ID</td>
                  <td style="color: #1A1A2E; font-size: 14px; padding: 12px 16px; font-family: monospace;">${eventId}</td>
                </tr>
                <tr>
                  <td style="color: #6B7280; font-size: 13px; border-bottom: 1px solid #FFE8CC; padding: 12px 16px;">User</td>
                  <td style="color: #1A1A2E; font-size: 14px; padding: 12px 16px;">${userName || 'Unknown'} (${userEmail || 'no email'})</td>
                </tr>
                <tr>
                  <td style="color: #6B7280; font-size: 13px; border-bottom: 1px solid #FFE8CC; padding: 12px 16px;">SMS Sent</td>
                  <td style="color: #E94560; font-size: 14px; font-weight: 600; padding: 12px 16px;">${smsSentCount || 0} / ${smsLimit || 1000}</td>
                </tr>
                <tr>
                  <td style="color: #6B7280; font-size: 13px; padding: 12px 16px;">Total Guests</td>
                  <td style="color: #1A1A2E; font-size: 14px; padding: 12px 16px;">${guestCount || 'Unknown'}</td>
                </tr>
              </table>

              <div style="text-align: center; margin: 32px 0;">
                <a href="${adminPanelUrl}" style="display: inline-block; background-color: #E94560; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-size: 16px; font-weight: 600;">
                  Review &amp; Approve
                </a>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #1A1A2E; padding: 20px 40px; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #6B7280; font-size: 12px;">Ryvite Admin Alerts</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await resend.emails.send({
      from: 'Ryvite Alerts <support@ryvite.com>',
      replyTo: 'support@ryvite.com',
      to: ADMIN_EMAIL,
      subject,
      html
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Admin alert error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send alert' });
  }
}
