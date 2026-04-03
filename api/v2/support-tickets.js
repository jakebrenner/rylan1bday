import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { reportApiError } from './lib/error-reporter.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDER_EMAIL = 'jake@getmrkt.com';
const PROD_URL = 'https://ryvite.com';

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function isAdmin(user) {
  const email = user.email.toLowerCase();
  if (email === FOUNDER_EMAIL) return true;
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();
  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return adminList.includes(email);
  }
  return false;
}

async function sendNewTicketEmail(ticket, userEmail, userName, eventTitle) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminUrl = `${PROD_URL}/v2/admin/#support`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background-color:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background-color:#1A1A2E;padding:32px 40px;border-radius:16px 16px 0 0;text-align:center;">
            <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;color:#FFFAF5;font-size:24px;font-weight:700;">New Support Ticket</h1>
            <p style="margin:8px 0 0;color:#A78BFA;font-size:14px;">Ticket #${ticket.ticket_number}</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#FFFAF5;padding:40px;">
            <p style="margin:0 0 24px;color:#1A1A2E;font-size:16px;line-height:1.6;">
              A user has submitted a new support ticket.
            </p>
            <table width="100%" cellpadding="12" cellspacing="0" style="background-color:#FFF5E6;border-radius:12px;margin-bottom:24px;">
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">User</td>
                <td style="color:#1A1A2E;font-size:14px;font-weight:600;border-bottom:1px solid #FFE8CC;padding:12px 16px;">${userName || 'Unknown'} (${userEmail})</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Subject</td>
                <td style="color:#1A1A2E;font-size:14px;font-weight:600;border-bottom:1px solid #FFE8CC;padding:12px 16px;">${ticket.subject}</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Category</td>
                <td style="color:#1A1A2E;font-size:14px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">${ticket.category.replace('_', ' ')}</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Priority</td>
                <td style="color:#1A1A2E;font-size:14px;font-weight:600;border-bottom:1px solid #FFE8CC;padding:12px 16px;${ticket.priority === 'urgent' ? 'color:#E94560;' : ''}">${ticket.priority.toUpperCase()}</td>
              </tr>
              ${ticket.event_id ? `<tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Event</td>
                <td style="color:#1A1A2E;font-size:14px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">${eventTitle || 'Unknown'}<br><span style="font-family:monospace;font-size:12px;color:#6B7280;">${ticket.event_id}</span></td>
              </tr>` : ''}
              <tr>
                <td style="color:#6B7280;font-size:13px;padding:12px 16px;">Ticket ID</td>
                <td style="color:#1A1A2E;font-size:14px;font-family:monospace;padding:12px 16px;">#${ticket.ticket_number}</td>
              </tr>
            </table>
            <div style="text-align:center;margin:32px 0;">
              <a href="${adminUrl}" style="display:inline-block;background-color:#E94560;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:16px;font-weight:600;">
                View in Admin Panel
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background-color:#1A1A2E;padding:20px 40px;border-radius:0 0 16px 16px;text-align:center;">
            <p style="margin:0;color:#6B7280;font-size:12px;">Ryvite Support Alerts</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: 'Ryvite Alerts <alerts@ryvite.com>',
      to: process.env.ADMIN_EMAIL || 'support@ryvite.com',
      subject: `[Ticket #${ticket.ticket_number}] ${ticket.subject}`,
      html
    });
  } catch (err) {
    console.error('Failed to send support ticket email:', err);
  }
}

async function sendAdminReplyEmail(ticket, userEmail, userName, replyMessage) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const supportUrl = `${PROD_URL}/v2/support/?ticket=${ticket.id}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background-color:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background-color:#1A1A2E;padding:32px 40px;border-radius:16px 16px 0 0;text-align:center;">
            <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;color:#FFFAF5;font-size:24px;font-weight:700;">Support Update</h1>
            <p style="margin:8px 0 0;color:#A78BFA;font-size:14px;">Ticket #${ticket.ticket_number} — ${ticket.subject}</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#FFFAF5;padding:40px;">
            <p style="margin:0 0 8px;color:#1A1A2E;font-size:16px;line-height:1.6;">
              Hi ${userName || 'there'},
            </p>
            <p style="margin:0 0 24px;color:#1A1A2E;font-size:16px;line-height:1.6;">
              The Ryvite team has replied to your support ticket:
            </p>
            <div style="background-color:#F0F0FF;border-left:4px solid #A78BFA;border-radius:8px;padding:20px;margin-bottom:24px;">
              <p style="margin:0;color:#1A1A2E;font-size:15px;line-height:1.6;white-space:pre-wrap;">${replyMessage}</p>
            </div>
            <div style="text-align:center;margin:32px 0;">
              <a href="${supportUrl}" style="display:inline-block;background-color:#E94560;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:16px;font-weight:600;">
                View Ticket
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background-color:#1A1A2E;padding:20px 40px;border-radius:0 0 16px 16px;text-align:center;">
            <p style="margin:0;color:#6B7280;font-size:12px;">Ryvite Support</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: 'Ryvite Support <hello@ryvite.com>',
      to: userEmail,
      subject: `Re: [Ticket #${ticket.ticket_number}] ${ticket.subject}`,
      html
    });
  } catch (err) {
    console.error('Failed to send admin reply email:', err);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // ================================================================
    // USER: List own tickets
    // ================================================================
    if (action === 'list' && req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*, events(title)')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

      if (error) return res.status(400).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, tickets: data || [] });
    }

    // ================================================================
    // USER: Get single ticket with messages
    // ================================================================
    if (action === 'get' && req.method === 'GET') {
      const { ticketId } = req.query;
      if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId required' });

      const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*, events(title)')
        .eq('id', ticketId)
        .eq('user_id', user.id)
        .single();

      if (error || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

      const { data: messages } = await supabaseAdmin
        .from('support_messages')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

      return res.status(200).json({ success: true, ticket, messages: messages || [] });
    }

    // ================================================================
    // USER: Create ticket
    // ================================================================
    if (action === 'create' && req.method === 'POST') {
      const { subject, category, priority, eventId, message, themeSnapshot } = req.body || {};

      if (!subject || !category || !message) {
        return res.status(400).json({ success: false, error: 'subject, category, and message are required' });
      }

      // Get user profile for email
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, display_name')
        .eq('id', user.id)
        .single();

      // Validate event belongs to user if provided
      let eventTitle = null;
      if (eventId) {
        const { data: event } = await supabaseAdmin
          .from('events')
          .select('id, title')
          .eq('id', eventId)
          .eq('user_id', user.id)
          .single();
        if (!event) return res.status(400).json({ success: false, error: 'Event not found or not yours' });
        eventTitle = event.title;
      }

      const ticketBase = {
        user_id: user.id,
        event_id: eventId || null,
        subject,
        category,
        priority: priority || 'normal'
      };

      // Try with theme_snapshot first, fall back without if column doesn't exist yet
      let ticket, ticketError;
      if (themeSnapshot) {
        const result = await supabaseAdmin
          .from('support_tickets')
          .insert({ ...ticketBase, theme_snapshot: themeSnapshot })
          .select()
          .single();
        if (result.error && result.error.message && result.error.message.includes('theme_snapshot')) {
          // Column doesn't exist yet — retry without it
          const retry = await supabaseAdmin.from('support_tickets').insert(ticketBase).select().single();
          ticket = retry.data;
          ticketError = retry.error;
        } else {
          ticket = result.data;
          ticketError = result.error;
        }
      } else {
        const result = await supabaseAdmin.from('support_tickets').insert(ticketBase).select().single();
        ticket = result.data;
        ticketError = result.error;
      }

      if (ticketError) return res.status(400).json({ success: false, error: ticketError.message });

      // Insert initial message
      await supabaseAdmin
        .from('support_messages')
        .insert({
          ticket_id: ticket.id,
          sender_id: user.id,
          sender_type: 'user',
          message
        });

      // Send email notification (fire-and-forget)
      sendNewTicketEmail(ticket, profile?.email || user.email, profile?.display_name, eventTitle);

      return res.status(200).json({ success: true, ticket });
    }

    // ================================================================
    // USER: Reply to own ticket
    // ================================================================
    if (action === 'reply' && req.method === 'POST') {
      const { ticketId, message } = req.body || {};
      if (!ticketId || !message) return res.status(400).json({ success: false, error: 'ticketId and message required' });

      // Verify ticket belongs to user
      const { data: ticket } = await supabaseAdmin
        .from('support_tickets')
        .select('id, status')
        .eq('id', ticketId)
        .eq('user_id', user.id)
        .single();

      if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
      if (ticket.status === 'closed') return res.status(400).json({ success: false, error: 'Ticket is closed' });

      const { data: msg, error } = await supabaseAdmin
        .from('support_messages')
        .insert({
          ticket_id: ticketId,
          sender_id: user.id,
          sender_type: 'user',
          message
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Reopen if resolved
      if (ticket.status === 'resolved') {
        await supabaseAdmin.from('support_tickets').update({ status: 'open' }).eq('id', ticketId);
      }

      return res.status(200).json({ success: true, message: msg });
    }

    // ================================================================
    // ADMIN: List all tickets
    // ================================================================
    if (action === 'adminList' && req.method === 'GET') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const { status, category, priority } = req.query;

      let query = supabaseAdmin
        .from('support_tickets')
        .select('*, events(title), profiles!support_tickets_user_id_fkey(email, display_name)')
        .order('updated_at', { ascending: false });

      if (status) query = query.eq('status', status);
      if (category) query = query.eq('category', category);
      if (priority) query = query.eq('priority', priority);

      const { data, error } = await query;
      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, tickets: data || [] });
    }

    // ================================================================
    // ADMIN: Get single ticket with messages
    // ================================================================
    if (action === 'adminGet' && req.method === 'GET') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const { ticketId } = req.query;
      if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId required' });

      const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*, events(id, title, event_type, status, slug), profiles!support_tickets_user_id_fkey(email, display_name)')
        .eq('id', ticketId)
        .single();

      if (error || !ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

      const { data: messages } = await supabaseAdmin
        .from('support_messages')
        .select('*, profiles:sender_id(email, display_name)')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

      return res.status(200).json({ success: true, ticket, messages: messages || [] });
    }

    // ================================================================
    // ADMIN: Reply to any ticket
    // ================================================================
    if (action === 'adminReply' && req.method === 'POST') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const { ticketId, message } = req.body || {};
      if (!ticketId || !message) return res.status(400).json({ success: false, error: 'ticketId and message required' });

      const { data: ticket } = await supabaseAdmin
        .from('support_tickets')
        .select('*, profiles!support_tickets_user_id_fkey(email, display_name)')
        .eq('id', ticketId)
        .single();

      if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

      const { data: msg, error } = await supabaseAdmin
        .from('support_messages')
        .insert({
          ticket_id: ticketId,
          sender_id: user.id,
          sender_type: 'admin',
          message
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Auto-set to in_progress if open
      if (ticket.status === 'open') {
        await supabaseAdmin.from('support_tickets').update({ status: 'in_progress' }).eq('id', ticketId);
      }

      // Email the user about the reply
      sendAdminReplyEmail(ticket, ticket.profiles?.email, ticket.profiles?.display_name, message);

      return res.status(200).json({ success: true, message: msg });
    }

    // ================================================================
    // ADMIN: Update ticket status
    // ================================================================
    if (action === 'adminUpdateStatus' && req.method === 'POST') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const { ticketId, status } = req.body || {};
      if (!ticketId || !status) return res.status(400).json({ success: false, error: 'ticketId and status required' });

      const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status' });
      }

      const { error } = await supabaseAdmin
        .from('support_tickets')
        .update({ status })
        .eq('id', ticketId);

      if (error) return res.status(400).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    // ── Update ticket resolution (AI resolved, credit issued, etc.) ──
    if (action === 'updateResolution' && req.method === 'POST') {
      const { ticketId, resolutionType, aiAttempts, status, priority } = req.body || {};
      if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId required' });

      const validResolutions = ['ai_resolved', 'human_resolved', 'credit_issued', 'user_abandoned'];
      const updates = {};
      if (resolutionType && validResolutions.includes(resolutionType)) updates.resolution_type = resolutionType;
      if (typeof aiAttempts === 'number') updates.ai_attempts = aiAttempts;
      if (status) updates.status = status;
      if (priority) updates.priority = priority;
      if (resolutionType === 'human_resolved') updates.resolved_by = user.id;

      const { error } = await supabaseAdmin
        .from('support_tickets')
        .update(updates)
        .eq('id', ticketId);

      if (error) return res.status(400).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    // ── Admin: Get active theme for an event (for HTML editor) ──
    if (action === 'adminGetTheme' && req.method === 'GET') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const eventId = req.query.eventId;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      // Try active theme first, fall back to most recent theme
      let { data: theme, error } = await supabaseAdmin
        .from('event_themes')
        .select('id, html, css, config, version, thankyou_html, is_active')
        .eq('event_id', eventId)
        .eq('is_active', true)
        .single();

      if (error || !theme) {
        // Fall back to latest theme by version
        const fallback = await supabaseAdmin
          .from('event_themes')
          .select('id, html, css, config, version, thankyou_html, is_active')
          .eq('event_id', eventId)
          .order('version', { ascending: false })
          .limit(1)
          .single();
        theme = fallback.data;
      }

      // Last resort: check if any support ticket for this event has a theme_snapshot
      if (!theme) {
        const { data: ticketWithSnapshot } = await supabaseAdmin
          .from('support_tickets')
          .select('theme_snapshot')
          .eq('event_id', eventId)
          .not('theme_snapshot', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
          .catch(() => ({ data: null }));

        if (ticketWithSnapshot && ticketWithSnapshot.theme_snapshot) {
          // Return the snapshot as a virtual theme (not from event_themes)
          const snap = ticketWithSnapshot.theme_snapshot;
          theme = {
            id: 'snapshot',
            html: snap.html || '',
            css: snap.css || '',
            config: snap.config || {},
            version: 0,
            thankyou_html: snap.thankyou_html || null,
            is_active: false,
            _source: 'ticket_snapshot'
          };
        }
      }

      if (!theme) return res.status(404).json({ success: false, error: 'No theme found for this event' });

      // Also fetch event details for context
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, title, event_type, status, slug')
        .eq('id', eventId)
        .single();

      return res.status(200).json({ success: true, theme, event });
    }

    // ── Admin: Save edited theme HTML/CSS (direct edit by support team) ──
    if (action === 'adminSaveTheme' && req.method === 'POST') {
      if (!(await isAdmin(user))) return res.status(403).json({ success: false, error: 'Admin access required' });

      const { themeId, html, css, config, eventId } = req.body || {};
      if (!themeId && !eventId) return res.status(400).json({ success: false, error: 'themeId or eventId required' });

      // If themeId is 'snapshot', we need to create a new event_themes row
      if (themeId === 'snapshot' && eventId) {
        const { data: newTheme, error } = await supabaseAdmin
          .from('event_themes')
          .insert({
            event_id: eventId,
            version: 1,
            is_active: true,
            html: html || '',
            css: css || '',
            config: config || {},
            model: 'admin_edit',
            prompt: 'Manually created by support team'
          })
          .select('id')
          .single();

        if (error) return res.status(400).json({ success: false, error: error.message });
        return res.status(200).json({ success: true, themeId: newTheme.id });
      }

      const updates = {};
      if (html !== undefined) updates.html = html;
      if (css !== undefined) updates.css = css;
      if (config !== undefined) updates.config = config;

      const { error } = await supabaseAdmin
        .from('event_themes')
        .update(updates)
        .eq('id', themeId);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('Support tickets error:', err);
    await reportApiError({ endpoint: '/api/v2/support-tickets', action: req.query?.action || 'unknown', error: err, requestBody: req.body, req }).catch(() => {});
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}
