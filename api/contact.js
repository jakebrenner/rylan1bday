import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, phone, event } = req.body;

  if (!name || !email || !phone || !event) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    await resend.emails.send({
      from: 'Ryvite <onboarding@resend.dev>',
      to: 'jake@getmrkt.com',
      subject: `New Ryvite Request from ${name}`,
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem;">
          <div style="background: linear-gradient(135deg, #E94560, #FF6B6B); padding: 2rem; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">New Invite Request</h1>
          </div>
          <div style="background: #FFFAF5; padding: 2rem; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; font-weight: 600; color: #1A1A2E; width: 100px;">Name</td>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; color: #6B7280;">${escapeHtml(name)}</td>
              </tr>
              <tr>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; font-weight: 600; color: #1A1A2E;">Email</td>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; color: #6B7280;"><a href="mailto:${escapeHtml(email)}" style="color: #E94560;">${escapeHtml(email)}</a></td>
              </tr>
              <tr>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; font-weight: 600; color: #1A1A2E;">Phone</td>
                <td style="padding: 0.75rem 0; border-bottom: 1px solid #eee; color: #6B7280;"><a href="tel:${escapeHtml(phone)}" style="color: #E94560;">${escapeHtml(phone)}</a></td>
              </tr>
              <tr>
                <td style="padding: 0.75rem 0; font-weight: 600; color: #1A1A2E; vertical-align: top;">Event</td>
                <td style="padding: 0.75rem 0; color: #6B7280;">${escapeHtml(event)}</td>
              </tr>
            </table>
          </div>
          <p style="text-align: center; color: #aaa; font-size: 0.75rem; margin-top: 1.5rem;">Sent from ryvite.com</p>
        </div>
      `
    });

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Resend error:', error);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
