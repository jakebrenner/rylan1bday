import { createClient } from '@supabase/supabase-js';
import { checkAndChargeSmsUsage } from './billing.js';
import { Resend } from 'resend';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3/sms/send';
const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
const SMS_COST_CENTS = 10; // $0.10 per message charged to user
const resend = new Resend(process.env.RESEND_API_KEY);

// ---- Helpers ----

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function toE164(phone) {
  const digits = normalizePhone(phone);
  return digits ? `+1${digits}` : null;
}

function getClickSendAuthHeader() {
  const credentials = Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Send SMS messages via ClickSend REST API
 * @param {Array<{to: string, body: string, from?: string, schedule?: number, custom_string?: string}>} messages
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function sendViaClickSend(messages) {
  if (!CLICKSEND_USERNAME || !CLICKSEND_API_KEY) {
    return { success: false, error: 'ClickSend credentials not configured' };
  }

  try {
    const response = await fetch(CLICKSEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getClickSendAuthHeader()
      },
      body: JSON.stringify({
        messages: messages.map(m => ({
          to: m.to,
          body: m.body,
          source: 'ryvite',
          from: m.from || undefined,
          schedule: m.schedule || undefined,
          custom_string: m.custom_string || undefined
        }))
      })
    });

    const result = await response.json();

    if (result.http_code !== 200) {
      return { success: false, error: result.response_msg || 'ClickSend API error', data: result };
    }

    return { success: true, data: result.data };
  } catch (err) {
    console.error('ClickSend API error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Record sent SMS messages in the database for billing and audit
 */
async function recordSmsMessages(userId, eventId, sentMessages, messageType, clickSendResults) {
  const csMessages = clickSendResults?.messages || [];

  const smsRecords = sentMessages.map((msg, i) => ({
    user_id: userId,
    event_id: eventId || null,
    recipient_phone: msg.phone,
    recipient_name: msg.name || null,
    message_type: messageType,
    status: csMessages[i]?.status === 'SUCCESS' ? 'sent' : 'queued',
    provider_id: csMessages[i]?.message_id || null,
    cost_cents: SMS_COST_CENTS,
    billed: false
  }));

  if (smsRecords.length > 0) {
    await supabaseAdmin.from('sms_messages').insert(smsRecords);
  }

  // Also log to notification_log for audit trail
  const notifRecords = sentMessages.map((msg, i) => ({
    event_id: eventId || null,
    guest_id: msg.guestId || null,
    channel: 'sms',
    recipient: msg.phone,
    subject: null,
    status: csMessages[i]?.status === 'SUCCESS' ? 'sent' : 'pending',
    provider_id: csMessages[i]?.message_id || null,
    error: csMessages[i]?.status !== 'SUCCESS' ? (csMessages[i]?.status || null) : null,
    sent_at: new Date().toISOString()
  }));

  if (notifRecords.length > 0) {
    await supabaseAdmin.from('notification_log').insert(notifRecords);
  }

  // Check billing threshold
  await checkAndChargeSmsUsage(userId).catch(err => {
    console.error('SMS billing check failed:', err);
  });

  return smsRecords.length;
}

/**
 * Verify user owns the event
 */
async function verifyEventOwnership(userId, eventId) {
  const { data: event, error } = await supabaseAdmin
    .from('events')
    .select('id, title, user_id, event_date, slug')
    .eq('id', eventId)
    .single();

  if (error || !event) return { error: 'Event not found' };
  if (event.user_id !== userId) return { error: 'You do not own this event' };
  return { event };
}

/**
 * Fetch guests with phone numbers for an event
 */
async function fetchGuestsWithPhones(eventId, { guestIds, recipientFilter } = {}) {
  let query = supabaseAdmin
    .from('guests')
    .select('id, name, phone, status, email')
    .eq('event_id', eventId)
    .not('phone', 'is', null);

  if (guestIds && guestIds.length > 0) {
    query = query.in('id', guestIds);
  } else if (recipientFilter && recipientFilter !== 'all') {
    query = query.eq('status', recipientFilter);
  }

  const { data: guests, error } = await query;
  if (error) return { error: error.message };

  // Filter to only guests with valid phone numbers
  const validGuests = (guests || []).filter(g => {
    const e164 = toE164(g.phone);
    return e164 !== null;
  });

  return { guests: validGuests };
}

// ---- Main Handler ----

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // All actions require auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    // ============================================================
    // USE CASE 1: Send invite SMS to guests
    // ============================================================
    if (action === 'sendInvites') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, guestIds, message, allGuests } = req.body || {};

      if (!eventId || !message) {
        return res.status(400).json({ success: false, error: 'eventId and message are required' });
      }

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      const { guests, error: guestError } = await fetchGuestsWithPhones(eventId, {
        guestIds: allGuests ? undefined : guestIds
      });
      if (guestError) return res.status(400).json({ success: false, error: guestError });

      if (guests.length === 0) {
        return res.status(400).json({ success: false, error: 'No guests with valid phone numbers found' });
      }

      // Build messages — resolve {name} and {link} per-guest
      const baseUrl = req.headers.origin || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      const clickSendMessages = guests.map(g => {
        const guestLink = `${baseUrl}/v2/event/${event.slug}?gid=${g.id}`;
        return {
          to: toE164(g.phone),
          body: message
            .replace(/\{name\}/gi, g.name || 'Guest')
            .replace(/\{link\}/gi, guestLink)
        };
      });

      const result = await sendViaClickSend(clickSendMessages);
      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }

      // Record in DB
      const sentMessages = guests.map(g => ({
        phone: normalizePhone(g.phone),
        name: g.name,
        guestId: g.id
      }));

      const recorded = await recordSmsMessages(user.id, eventId, sentMessages, 'invite', result.data);

      // Update invited_at for these guests
      const guestIdsToUpdate = guests.map(g => g.id);
      await supabaseAdmin
        .from('guests')
        .update({ invited_at: new Date().toISOString() })
        .in('id', guestIdsToUpdate);

      return res.status(200).json({
        success: true,
        sent: recorded,
        totalPrice: result.data?.total_price,
        queuedCount: result.data?.queued_count
      });
    }

    // ============================================================
    // USE CASE 2: Send ad hoc update to guests
    // ============================================================
    if (action === 'sendUpdate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, guestIds, message, recipientFilter } = req.body || {};

      if (!eventId || !message) {
        return res.status(400).json({ success: false, error: 'eventId and message are required' });
      }

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      const { guests, error: guestError } = await fetchGuestsWithPhones(eventId, {
        guestIds,
        recipientFilter: recipientFilter || 'all'
      });
      if (guestError) return res.status(400).json({ success: false, error: guestError });

      if (guests.length === 0) {
        return res.status(400).json({ success: false, error: 'No guests with valid phone numbers found' });
      }

      const updateBaseUrl = req.headers.origin || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      const clickSendMessages = guests.map(g => {
        const guestLink = `${updateBaseUrl}/v2/event/${event.slug}?gid=${g.id}`;
        return {
          to: toE164(g.phone),
          body: message
            .replace(/\{name\}/gi, g.name || 'Guest')
            .replace(/\{link\}/gi, guestLink)
        };
      });

      const result = await sendViaClickSend(clickSendMessages);
      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }

      const sentMessages = guests.map(g => ({
        phone: normalizePhone(g.phone),
        name: g.name,
        guestId: g.id
      }));

      const messageType = recipientFilter === 'all' ? 'update' : 'custom';
      const recorded = await recordSmsMessages(user.id, eventId, sentMessages, messageType, result.data);

      return res.status(200).json({
        success: true,
        sent: recorded,
        recipientFilter: recipientFilter || 'all',
        totalPrice: result.data?.total_price
      });
    }

    // ============================================================
    // USE CASE 3: Save auto-reminders
    // ============================================================
    if (action === 'saveReminder') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, reminders } = req.body || {};

      if (!eventId || !reminders || !Array.isArray(reminders) || reminders.length === 0) {
        return res.status(400).json({ success: false, error: 'eventId and reminders array are required' });
      }

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      if (!event.event_date) {
        return res.status(400).json({ success: false, error: 'Event must have a date set to schedule reminders' });
      }

      const eventDate = new Date(event.event_date);
      const now = new Date();

      const reminderRows = [];
      for (const r of reminders) {
        if (!r.offsetMinutes || !r.message) {
          return res.status(400).json({ success: false, error: 'Each reminder needs offsetMinutes and message' });
        }

        const scheduledFor = new Date(eventDate.getTime() - r.offsetMinutes * 60 * 1000);

        if (scheduledFor <= now) {
          return res.status(400).json({
            success: false,
            error: `Reminder with offset ${r.offsetMinutes} minutes would be in the past`
          });
        }

        reminderRows.push({
          event_id: eventId,
          user_id: user.id,
          offset_minutes: r.offsetMinutes,
          message: r.message,
          scheduled_for: scheduledFor.toISOString(),
          status: 'pending'
        });
      }

      const { data, error } = await supabaseAdmin
        .from('sms_reminders')
        .insert(reminderRows)
        .select();

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, reminders: data });
    }

    // ============================================================
    // List reminders for an event
    // ============================================================
    if (action === 'listReminders') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      const { data, error } = await supabaseAdmin
        .from('sms_reminders')
        .select('*')
        .eq('event_id', eventId)
        .order('scheduled_for', { ascending: true });

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, reminders: data });
    }

    // ============================================================
    // Delete (cancel) a reminder
    // ============================================================
    if (action === 'deleteReminder') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { reminderId } = req.body || {};
      if (!reminderId) return res.status(400).json({ success: false, error: 'reminderId required' });

      // Verify ownership
      const { data: reminder, error: findErr } = await supabaseAdmin
        .from('sms_reminders')
        .select('id, user_id, status')
        .eq('id', reminderId)
        .single();

      if (findErr || !reminder) return res.status(404).json({ success: false, error: 'Reminder not found' });
      if (reminder.user_id !== user.id) return res.status(403).json({ success: false, error: 'Not your reminder' });
      if (reminder.status !== 'pending') {
        return res.status(400).json({ success: false, error: `Cannot cancel a reminder that is already ${reminder.status}` });
      }

      const { error } = await supabaseAdmin
        .from('sms_reminders')
        .update({ status: 'cancelled' })
        .eq('id', reminderId);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // USE CASE 4: Host notification preferences
    // ============================================================
    if (action === 'updateNotifyPrefs') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, notifyOnRsvp, notifyMode, notifyPhone } = req.body || {};

      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      if (notifyOnRsvp && !notifyPhone) {
        return res.status(400).json({ success: false, error: 'notifyPhone required when enabling notifications' });
      }

      const normalizedPhone = notifyPhone ? normalizePhone(notifyPhone) : null;
      if (notifyOnRsvp && !normalizedPhone) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }

      const prefsData = {
        event_id: eventId,
        user_id: user.id,
        notify_on_rsvp: notifyOnRsvp ?? false,
        notify_mode: notifyMode || 'instant',
        notify_phone: normalizedPhone || '',
        updated_at: new Date().toISOString()
      };

      // Upsert: insert or update on event_id conflict
      const { data, error } = await supabaseAdmin
        .from('event_notification_prefs')
        .upsert(prefsData, { onConflict: 'event_id' })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, prefs: data });
    }

    if (action === 'getNotifyPrefs') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      const { data, error } = await supabaseAdmin
        .from('event_notification_prefs')
        .select('*')
        .eq('event_id', eventId)
        .single();

      // No prefs set yet is not an error — return defaults
      if (error || !data) {
        return res.status(200).json({
          success: true,
          prefs: {
            notify_on_rsvp: false,
            notify_mode: 'instant',
            notify_phone: null
          }
        });
      }

      return res.status(200).json({ success: true, prefs: data });
    }

    // ============================================================
    // SMS History for an event
    // ============================================================
    if (action === 'history') {
      const { eventId, page, limit } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      const pageNum = Math.max(1, parseInt(page) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
      const offset = (pageNum - 1) * limitNum;

      const { data, error, count } = await supabaseAdmin
        .from('sms_messages')
        .select('*', { count: 'exact' })
        .eq('event_id', eventId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({
        success: true,
        messages: data,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: count,
          totalPages: Math.ceil((count || 0) / limitNum)
        }
      });
    }

    // ============================================================
    // Send a single test SMS to the host's own phone
    // ============================================================
    if (action === 'sendTest') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { phone, message } = req.body || {};

      if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'phone and message are required' });
      }

      const e164 = toE164(phone);
      if (!e164) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }

      // Replace {name} with "Test Guest" for preview
      const testBody = message.replace(/\{name\}/gi, 'Test Guest');

      const result = await sendViaClickSend([{ to: e164, body: testBody }]);
      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }

      // Record test message (no event association required, but include if provided)
      const eventId = req.body.eventId || null;
      await recordSmsMessages(user.id, eventId, [{ phone: normalizePhone(phone), name: 'Test', guestId: null }], 'custom', result.data);

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // USE CASE 6: Send invite emails to guests via Resend
    // Styled to match the AI-generated event theme
    // ============================================================
    if (action === 'sendEmailInvites') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, subject, message, allGuests, guestIds } = req.body || {};

      if (!eventId) {
        return res.status(400).json({ success: false, error: 'eventId is required' });
      }

      const { event, error: ownerError } = await verifyEventOwnership(user.id, eventId);
      if (ownerError) return res.status(403).json({ success: false, error: ownerError });

      // Fetch active theme for this event — use its colors/fonts in the email
      const { data: theme } = await supabaseAdmin
        .from('event_themes')
        .select('config')
        .eq('event_id', eventId)
        .eq('is_active', true)
        .single();

      const cfg = theme?.config || {};
      const primaryColor = cfg.primaryColor || '#E94560';
      const secondaryColor = cfg.secondaryColor || '#FF6B6B';
      const accentColor = cfg.accentColor || '#2196F3';
      const headlineFont = cfg.fontHeadline || 'Playfair Display';
      const bodyFont = cfg.fontBody || 'Inter';

      // Email-safe color utilities (no opacity, no rgba — only solid hex)
      const hexToRgb = (hex) => {
        const h = hex.replace('#', '');
        return [parseInt(h.substring(0,2),16), parseInt(h.substring(2,4),16), parseInt(h.substring(4,6),16)];
      };
      const rgbToHex = (r,g,b) => '#' + [r,g,b].map(c => Math.max(0,Math.min(255,Math.round(c))).toString(16).padStart(2,'0')).join('');
      const mix = (hex, target, amount) => {
        const [r1,g1,b1] = hexToRgb(hex);
        const [r2,g2,b2] = hexToRgb(target);
        return rgbToHex(r1+(r2-r1)*amount, g1+(g2-g1)*amount, b1+(b2-b1)*amount);
      };
      const luminance = (hex) => {
        const [r,g,b] = hexToRgb(hex);
        return (0.299*r + 0.587*g + 0.114*b) / 255;
      };

      // Email always uses a LIGHT body — dark-themed invites convey their personality
      // through accent colors, fonts, and the details card, not a dark email background.
      // This ensures maximum readability and deliverability across all email clients.
      const emailBg = '#FFFFFF';
      const emailTextColor = '#1A1A2E';
      const emailSubtextColor = '#5A5A6E';
      const emailFooterColor = '#9A9AAE';

      // Theme-derived accents (these carry the invite's personality into the email)
      const cardBg = mix(primaryColor, '#FFFFFF', 0.92);        // Very soft primary tint
      const accentLine = primaryColor;                            // Bold primary for top bar + card accent
      const dividerColor = mix(primaryColor, '#FFFFFF', 0.75);   // Softer primary for decorative divider

      // Button: use primary bg, auto-detect text contrast
      const btnTextColor = luminance(primaryColor) > 0.55 ? '#1A1A2E' : '#FFFFFF';

      // Fetch guests with emails
      let query = supabaseAdmin
        .from('guests')
        .select('id, name, email, status')
        .eq('event_id', eventId)
        .not('email', 'is', null);

      if (!allGuests && guestIds?.length) {
        query = query.in('id', guestIds);
      }

      const { data: guests, error: guestError } = await query;
      if (guestError) return res.status(400).json({ success: false, error: guestError.message });

      const validGuests = (guests || []).filter(g => g.email && g.email.includes('@'));
      if (validGuests.length === 0) {
        return res.status(400).json({ success: false, error: 'No guests with valid email addresses found' });
      }

      // Get host profile for the "from" display name
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('display_name')
        .eq('id', user.id)
        .single();

      const hostName = profile?.display_name || 'Someone';
      const baseUrl = req.headers.origin || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      const eventTitle = event.title || 'an event';
      const emailSubject = subject || `You're invited to ${eventTitle}!`;
      const eventDate = event.event_date
        ? new Date(event.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : '';

      // Build and send individual emails
      let sentCount = 0;
      let failedCount = 0;
      const notifRecords = [];

      // Check if the user has a custom email template from the design chat
      const customEmailHtml = cfg.emailHtml || null;

      for (const guest of validGuests) {
        const guestLink = `${baseUrl}/v2/event/${event.slug}?gid=${guest.id}`;
        const guestName = guest.name || 'Guest';

        let html;
        if (customEmailHtml) {
          // Use the AI-customized email template — resolve per-guest placeholders
          html = customEmailHtml
            .replace(/\{name\}/gi, guestName)
            .replace(/\{link\}/gi, guestLink);
        } else {
          // Ryvite-branded email invite — dark header, cream background, clean card, gradient CTA.
          // Matches the Ryvite auth emails and brand guidelines for a consistent experience.
          const accentTint = mix(primaryColor, '#FFFFFF', 0.85);

          html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You're invited to ${eventTitle}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#FFFAF5;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<!-- Preheader text -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#FFFAF5;">
  ${hostName} has invited you to ${eventTitle}${eventDate ? ' on ' + eventDate : ''}. View your invitation and RSVP!
  ${'&nbsp;&zwnj;'.repeat(30)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFAF5;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">

  <!-- Branded header with logo -->
  <tr><td align="center" style="padding-bottom:0;">
    <div style="background:linear-gradient(135deg, #1A1A2E 0%, #0f3460 100%);border-radius:12px 12px 0 0;padding:24px 40px;text-align:center;">
      <img src="${baseUrl}/api/logo.png?variant=dark" alt="Ryvite" width="160" height="44" style="display:block;margin:0 auto 4px;width:160px;height:44px;border:0;" />
      <p style="margin:0;font-size:12px;color:#FFB74D;font-style:italic;font-family:'Inter',Arial,sans-serif;">Prompt to Party</p>
    </div>
  </td></tr>

  <!-- Accent bar (event's primary color) -->
  <tr><td style="height:4px;background-color:${primaryColor};font-size:0;line-height:0;" height="4">&nbsp;</td></tr>

  <!-- Main card body -->
  <tr><td style="background-color:#FFFFFF;padding:40px 36px 36px;box-shadow:0 4px 24px rgba(26,26,46,0.08);">

    <!-- "You're Invited" headline -->
    <h2 style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#1A1A2E;margin:0 0 6px;line-height:1.2;text-align:center;">You're Invited</h2>

    <!-- Event title -->
    <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:17px;color:#5A5A6E;margin:0 0 20px;line-height:1.4;text-align:center;">${eventTitle}</p>

    <!-- Event details card (tinted with event color) -->
    ${eventDate || event.location_name ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:${accentTint};padding:20px 24px;border-left:3px solid ${primaryColor};">
      ${eventDate ? `<p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A2E;margin:0 0 4px;line-height:1.5;font-weight:600;">${eventDate}</p>` : ''}
      ${event.location_name ? `<p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;color:#5A5A6E;margin:0;line-height:1.5;">${event.location_name}</p>` : ''}
    </td></tr></table>` : ''}

    <!-- Spacer -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="height:28px;font-size:0;line-height:0;" height="28">&nbsp;</td>
    </tr></table>

    <!-- CTA button (Ryvite coral gradient, pill) -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:0 0 8px;">
      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${guestLink}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="50%" fillcolor="#E94560" stroke="f"><v:textbox inset="0,0,0,0"><center style="font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#FFFFFF;">View Invitation</center></v:textbox></v:roundrect><![endif]-->
      <!--[if !mso]><!-->
      <a href="${guestLink}" target="_blank" style="display:inline-block;padding:14px 48px;background:linear-gradient(135deg, #E94560, #FF6B6B);color:#FFFFFF;font-size:16px;font-weight:600;text-decoration:none;border-radius:50px;font-family:'Inter',Arial,Helvetica,sans-serif;letter-spacing:0.3px;">View Invitation</a>
      <!--<![endif]-->
    </td></tr>
    </table>

    <!-- Subtle helper text -->
    <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;color:#D1D5DB;margin:16px 0 0;line-height:1.5;text-align:center;">Tap the button to see your full invitation and RSVP</p>

  </td></tr>

  <!-- Footer -->
  <tr><td align="center" style="padding:20px 0 0;">
    <p style="margin:0;font-size:12px;color:#D1D5DB;font-family:'Inter',Arial,sans-serif;">&copy; 2026 Ryvite &mdash; Beautiful invitations, effortlessly.</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
        }

        try {
          await resend.emails.send({
            from: 'Ryvite <noreply@ryvite.com>',
            to: guest.email,
            subject: emailSubject,
            html: html
          });
          sentCount++;
          notifRecords.push({
            event_id: eventId,
            guest_id: guest.id,
            channel: 'email',
            recipient: guest.email,
            subject: emailSubject,
            status: 'sent',
            sent_at: new Date().toISOString()
          });
        } catch (emailErr) {
          console.error('Failed to send invite email to', guest.email, emailErr);
          failedCount++;
          notifRecords.push({
            event_id: eventId,
            guest_id: guest.id,
            channel: 'email',
            recipient: guest.email,
            subject: emailSubject,
            status: 'failed',
            error: emailErr.message || 'Send failed',
            sent_at: new Date().toISOString()
          });
        }
      }

      // Record in notification_log
      if (notifRecords.length > 0) {
        await supabaseAdmin.from('notification_log').insert(notifRecords).catch(() => {});
      }

      // Update invited_at for successfully sent guests
      const sentGuestIds = notifRecords.filter(r => r.status === 'sent').map(r => r.guest_id);
      if (sentGuestIds.length > 0) {
        await supabaseAdmin
          .from('guests')
          .update({ invited_at: new Date().toISOString() })
          .in('id', sentGuestIds);
      }

      return res.status(200).json({
        success: true,
        sent: sentCount,
        failed: failedCount,
        total: validGuests.length
      });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('SMS API error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
