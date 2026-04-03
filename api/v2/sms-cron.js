import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
// SMS included in $4.99 event price — no per-message billing

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3/sms/send';
const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
async function getSmsCostCents() {
  try {
    const { data } = await supabaseAdmin.from('app_config').select('value').eq('key', 'sms_cost_cents').single();
    return parseInt(data?.value) || 3;
  } catch { return 3; }
}

// ---- Helpers (duplicated from sms.js — Vercel isolates functions) ----

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
          source: 'ryvite-cron'
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

async function recordSmsMessages(userId, eventId, sentMessages, messageType, clickSendResults) {
  const csMessages = clickSendResults?.messages || [];
  const smsCostCents = await getSmsCostCents();

  const smsRecords = sentMessages.map((msg, i) => ({
    user_id: userId,
    event_id: eventId || null,
    recipient_phone: msg.phone,
    recipient_name: msg.name || null,
    message_type: messageType,
    status: csMessages[i]?.status === 'SUCCESS' ? 'sent' : 'queued',
    provider_id: csMessages[i]?.message_id || null,
    cost_cents: smsCostCents,
    billed: false
  }));

  if (smsRecords.length > 0) {
    await supabaseAdmin.from('sms_messages').insert(smsRecords);
  }

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

  // SMS included in $4.99 event price — no per-message billing

  return smsRecords.length;
}

// ---- Job A: Process due reminders (SMS + Email) ----

async function processDueReminders() {
  const now = new Date().toISOString();

  // Find all pending reminders that are due
  const { data: dueReminders, error } = await supabaseAdmin
    .from('sms_reminders')
    .select('*, events!inner(id, title, user_id, event_date, location_name, slug, payment_status)')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .limit(50); // Process in batches to stay within timeout

  if (error || !dueReminders || dueReminders.length === 0) {
    return { reminders: 0, messages: 0, emails: 0 };
  }

  let totalMessages = 0;
  let totalEmails = 0;

  for (const reminder of dueReminders) {
    try {
      const deliveryMethod = reminder.delivery_method || 'sms';

      if (deliveryMethod === 'email') {
        // ---- Email reminder ----
        const emailResult = await processEmailReminder(reminder, now);
        totalEmails += emailResult;
      } else {
        // ---- SMS reminder ----
        const smsResult = await processSmsReminder(reminder, now);
        totalMessages += smsResult;
      }
    } catch (err) {
      console.error(`Error processing reminder ${reminder.id}:`, err);
      await supabaseAdmin
        .from('sms_reminders')
        .update({ status: 'failed' })
        .eq('id', reminder.id);
    }
  }

  return { reminders: dueReminders.length, messages: totalMessages, emails: totalEmails };
}

async function processSmsReminder(reminder, now) {
  // Fetch guests with phones who are attending or haven't declined
  const { data: guests } = await supabaseAdmin
    .from('guests')
    .select('id, name, phone, status')
    .eq('event_id', reminder.event_id)
    .not('phone', 'is', null)
    .in('status', ['attending', 'maybe', 'invited']);

  const validGuests = (guests || []).filter(g => toE164(g.phone) !== null);

  if (validGuests.length === 0) {
    await supabaseAdmin
      .from('sms_reminders')
      .update({ status: 'sent', sent_at: now, recipients_count: 0 })
      .eq('id', reminder.id);
    return 0;
  }

  const clickSendMessages = validGuests.map(g => ({
    to: toE164(g.phone),
    body: reminder.message.replace(/\{name\}/gi, g.name || 'Guest')
  }));

  const result = await sendViaClickSend(clickSendMessages);

  if (result.success) {
    const sentMessages = validGuests.map(g => ({
      phone: normalizePhone(g.phone),
      name: g.name,
      guestId: g.id
    }));

    const recorded = await recordSmsMessages(
      reminder.user_id,
      reminder.event_id,
      sentMessages,
      'reminder',
      result.data
    );

    await supabaseAdmin
      .from('sms_reminders')
      .update({ status: 'sent', sent_at: now, recipients_count: validGuests.length })
      .eq('id', reminder.id);

    return recorded;
  } else {
    console.error(`SMS reminder ${reminder.id} failed:`, result.error);
    await supabaseAdmin
      .from('sms_reminders')
      .update({ status: 'failed' })
      .eq('id', reminder.id);
    return 0;
  }
}

async function processEmailReminder(reminder, now) {
  if (!resend) {
    console.error('RESEND_API_KEY not configured — cannot send email reminders');
    await supabaseAdmin
      .from('sms_reminders')
      .update({ status: 'failed' })
      .eq('id', reminder.id);
    return 0;
  }

  const event = reminder.events;
  const eventTitle = event.title || 'your event';
  const eventSlug = event.slug || '';

  // Fetch active theme colors for branded email
  const { data: theme } = await supabaseAdmin
    .from('event_themes')
    .select('config')
    .eq('event_id', reminder.event_id)
    .eq('is_active', true)
    .single();

  const cfg = theme?.config || {};
  const primaryColor = cfg.primaryColor || '#E94560';

  // Color utilities (duplicated — Vercel isolates functions)
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

  const accentTint = mix(primaryColor, '#FFFFFF', 0.92);
  const btnText = luminance(primaryColor) > 0.55 ? '#1A1A2E' : '#FFFFFF';

  const eventDate = event.event_date
    ? new Date(event.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const eventTime = event.event_date
    ? new Date(event.event_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  // Get host display name
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('display_name')
    .eq('id', reminder.user_id)
    .single();
  const hostName = profile?.display_name || 'Your host';

  // Determine base URL from event slug
  const baseUrl = 'https://ryvite.com';

  // Fetch guests with emails
  const { data: guests } = await supabaseAdmin
    .from('guests')
    .select('id, name, email, status')
    .eq('event_id', reminder.event_id)
    .not('email', 'is', null)
    .in('status', ['attending', 'maybe', 'invited']);

  const validGuests = (guests || []).filter(g => g.email && g.email.includes('@'));

  if (validGuests.length === 0) {
    await supabaseAdmin
      .from('sms_reminders')
      .update({ status: 'sent', sent_at: now, recipients_count: 0 })
      .eq('id', reminder.id);
    return 0;
  }

  let sentCount = 0;
  const notifRecords = [];
  const emailSubject = `Reminder: ${eventTitle}${eventDate ? ' — ' + eventDate : ''}`;

  for (const guest of validGuests) {
    const guestName = guest.name || 'Guest';
    const guestLink = `${baseUrl}/v2/event/${eventSlug}?gid=${guest.id}`;
    const personalMsg = reminder.message.replace(/\{name\}/gi, guestName);

    const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Reminder: ${eventTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#FFFAF5;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#FFFAF5;">
  ${eventTitle} is coming up${eventDate ? ' on ' + eventDate : ''}! Don't forget to RSVP.
  ${'&nbsp;&zwnj;'.repeat(30)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFAF5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">

  <!-- Hero section -->
  <tr><td align="center" style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${primaryColor};border-radius:16px 16px 0 0;">
    <tr><td style="padding:40px 32px 32px;text-align:center;">
      <p style="margin:0 0 8px;font-size:28px;line-height:1;">&#9200;</p>
      <p style="margin:0 0 6px;font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${btnText};opacity:0.7;">FRIENDLY REMINDER</p>
      <h1 style="margin:0;font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:${btnText};line-height:1.25;">${eventTitle}</h1>
    </td></tr>
    </table>
  </td></tr>

  <!-- Main card body -->
  <tr><td style="background-color:#FFFFFF;padding:0;border-radius:0 0 16px 16px;border:1px solid #f0ebe5;border-top:none;">

    <!-- Personal greeting -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:28px 32px 0;">
      <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;color:#1A1A2E;margin:0;line-height:1.6;">Hey ${guestName},</p>
      <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;color:#5A5A6E;margin:6px 0 0;line-height:1.6;">Just a friendly reminder from ${hostName} — this event is coming up soon!</p>
    </td></tr>
    </table>

    <!-- Event details card -->
    ${eventDate || event.location_name ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:20px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${accentTint};border-radius:12px;">
      <tr><td style="padding:18px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${eventDate ? `<tr>
          <td style="width:32px;vertical-align:top;padding-right:12px;">
            <p style="margin:0;font-size:18px;line-height:1;">&#128197;</p>
          </td>
          <td style="vertical-align:top;">
            <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A2E;margin:0;line-height:1.5;font-weight:600;">${eventDate}${eventTime ? ' at ' + eventTime : ''}</p>
          </td>
        </tr>` : ''}
        ${event.location_name ? `<tr>
          <td style="width:32px;vertical-align:top;padding-right:12px;${eventDate ? 'padding-top:10px;' : ''}">
            <p style="margin:0;font-size:18px;line-height:1;">&#128205;</p>
          </td>
          <td style="vertical-align:top;${eventDate ? 'padding-top:10px;' : ''}">
            <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;color:#5A5A6E;margin:0;line-height:1.5;">${event.location_name}</p>
          </td>
        </tr>` : ''}
        </table>
      </td></tr>
      </table>
    </td></tr>
    </table>` : ''}

    <!-- CTA button -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:28px 32px 0;">
      <a href="${guestLink}" target="_blank" style="display:inline-block;padding:16px 48px;background-color:${primaryColor};color:${btnText};font-size:16px;font-weight:700;text-decoration:none;border-radius:50px;font-family:'Inter',Arial,Helvetica,sans-serif;letter-spacing:0.3px;min-width:200px;text-align:center;">View Invitation &amp; RSVP</a>
    </td></tr>
    </table>

    <!-- Divider + helper text -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:24px 32px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #f0ebe5;height:1px;font-size:0;line-height:0;">&nbsp;</td></tr></table>
      <p style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;color:#B0B0B8;margin:16px 0 0;line-height:1.5;text-align:center;">Tap the button to see your full invitation and RSVP</p>
    </td></tr>
    </table>

  </td></tr>

  <!-- Footer -->
  <tr><td align="center" style="padding:24px 0 0;">
    <p style="margin:0;font-size:11px;color:#C8C8D0;font-family:'Inter',Arial,sans-serif;">Sent via <span style="color:#E94560;font-weight:600;">Ryvite</span> &mdash; Beautiful invitations, effortlessly.</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    try {
      const emailResult = await resend.emails.send({
        from: 'Ryvite <noreply@ryvite.com>',
        to: guest.email,
        subject: emailSubject,
        html: html
      });
      sentCount++;
      notifRecords.push({
        event_id: reminder.event_id,
        guest_id: guest.id,
        channel: 'email',
        recipient: guest.email,
        subject: emailSubject,
        status: 'sent',
        provider_id: emailResult?.data?.id || null,
        email_type: 'event_reminder',
        user_id: reminder.user_id || null,
        sent_at: now
      });
    } catch (emailErr) {
      console.error('Failed to send reminder email to', guest.email, emailErr);
      notifRecords.push({
        event_id: reminder.event_id,
        guest_id: guest.id,
        channel: 'email',
        recipient: guest.email,
        subject: emailSubject,
        status: 'failed',
        error: emailErr.message || 'Send failed',
        email_type: 'event_reminder',
        user_id: reminder.user_id || null,
        sent_at: now
      });
    }
  }

  // Record in notification_log
  if (notifRecords.length > 0) {
    await supabaseAdmin.from('notification_log').insert(notifRecords).catch(() => {});
  }

  // Update reminder status
  const finalStatus = sentCount > 0 ? 'sent' : 'failed';
  await supabaseAdmin
    .from('sms_reminders')
    .update({ status: finalStatus, sent_at: now, recipients_count: sentCount })
    .eq('id', reminder.id);

  return sentCount;
}

// ---- Job B: Send RSVP digest notifications ----

async function processRsvpDigests() {
  // Find all events with digest notification prefs enabled
  const { data: prefs, error } = await supabaseAdmin
    .from('event_notification_prefs')
    .select('*, events!inner(id, title, user_id)')
    .eq('notify_on_rsvp', true)
    .eq('notify_mode', 'digest');

  if (error || !prefs || prefs.length === 0) {
    return { digests: 0 };
  }

  let digestsSent = 0;

  for (const pref of prefs) {
    try {
      const since = pref.last_digest_at || pref.created_at;

      // Find new RSVPs since last digest
      const { data: newGuests } = await supabaseAdmin
        .from('guests')
        .select('name, status, responded_at')
        .eq('event_id', pref.event_id)
        .gt('responded_at', since)
        .order('responded_at', { ascending: true });

      if (!newGuests || newGuests.length === 0) continue;

      // Build digest message
      const statusEmoji = { attending: 'Yes', declined: 'No', maybe: 'Maybe' };
      const lines = newGuests.map(g =>
        `${g.name}: ${statusEmoji[g.status] || g.status}`
      );

      const eventTitle = pref.events?.title || 'your event';
      const body = `${newGuests.length} new RSVP${newGuests.length > 1 ? 's' : ''} for ${eventTitle}:\n${lines.join('\n')}`;

      const hostPhone = toE164(pref.notify_phone);
      if (!hostPhone) continue;

      const result = await sendViaClickSend([{ to: hostPhone, body }]);

      if (result.success) {
        await recordSmsMessages(
          pref.user_id,
          pref.event_id,
          [{ phone: normalizePhone(pref.notify_phone), name: 'Host' }],
          'update',
          result.data
        );

        // Update last_digest_at
        await supabaseAdmin
          .from('event_notification_prefs')
          .update({ last_digest_at: new Date().toISOString() })
          .eq('id', pref.id);

        digestsSent++;
      }
    } catch (err) {
      console.error(`Error processing digest for event ${pref.event_id}:`, err);
    }
  }

  return { digests: digestsSent };
}

// ---- Job C: Process review requests (auto-send after events) ----

async function loadReviewEmailSettings() {
  const keys = [
    'review_email_enabled', 'review_email_delay_days',
    'review_reminder_enabled', 'review_reminder_delay_days',
    'review_email_subject', 'review_email_headline', 'review_email_body',
    'review_email_cta_text', 'review_email_footer_note',
    'review_reminder_subject', 'review_reminder_headline', 'review_reminder_body',
    'review_reminder_cta_text', 'review_reminder_footer_note'
  ];
  const { data } = await supabaseAdmin.from('app_config').select('key, value').in('key', keys);
  const m = {};
  (data || []).forEach(r => { m[r.key] = r.value; });
  return {
    emailEnabled: m.review_email_enabled !== 'false',
    delayDays: parseInt(m.review_email_delay_days) || 1,
    reminderEnabled: m.review_reminder_enabled !== 'false',
    reminderDelayDays: parseInt(m.review_reminder_delay_days) || 7,
    emailSubject: m.review_email_subject || 'How was {{eventTitle}}? Share your experience!',
    emailHeadline: m.review_email_headline || 'How was {{eventTitle}}?',
    emailBody: m.review_email_body || 'We hope your event was amazing! We\'d love to hear about your experience using Ryvite. Your feedback helps other hosts discover what\'s possible.\n\nIt only takes a minute — just tap below to leave a quick review.',
    emailCtaText: m.review_email_cta_text || 'Tap a star to rate your experience:',
    emailFooterNote: m.review_email_footer_note || 'Your review may be featured on our site to help other event planners.',
    reminderSubject: m.review_reminder_subject || 'We\'d love to hear about {{eventTitle}}!',
    reminderHeadline: m.review_reminder_headline || 'We\'d still love to hear from you!',
    reminderBody: m.review_reminder_body || 'A little while ago you hosted {{eventTitle}} with Ryvite. We\'d really appreciate hearing about your experience — it helps us improve and helps other hosts discover what\'s possible.\n\nIt only takes a minute!',
    reminderCtaText: m.review_reminder_cta_text || 'Tap a star to rate your experience:',
    reminderFooterNote: m.review_reminder_footer_note || 'Your review may be featured on our site to help other event planners.'
  };
}

function buildStarRatingHtmlCron(reviewUrl, promptText) {
  const prompt = promptText || 'Tap a star to rate your experience:';
  const starPath = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
  let html = `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 4px;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#1A1A2E;">${prompt}</p>
    </td></tr><tr><td align="center">
      <table cellpadding="0" cellspacing="0" style="display:inline-table;"><tr>`;
  for (let i = 1; i <= 5; i++) {
    const url = reviewUrl + (reviewUrl.includes('?') ? '&' : '?') + 'rating=' + i;
    html += `<td style="padding:0 4px;" align="center">
          <a href="${url}" style="text-decoration:none;display:inline-block;" title="${i} star${i > 1 ? 's' : ''}">
            <svg width="40" height="40" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${starPath}" fill="#FFB74D" stroke="#E8A33D" stroke-width="0.5"/></svg>
          </a>
        </td>`;
  }
  html += `</tr><tr>`;
  for (let i = 1; i <= 5; i++) {
    html += `<td align="center" style="padding:2px 4px 0;"><span style="font-size:11px;color:#888;">${i}</span></td>`;
  }
  html += `</tr></table></td></tr></table>`;
  return html;
}

function buildConfigurableReviewEmail(firstName, headline, bodyText, ctaText, footerNote, reviewUrl) {
  const bodyParagraphs = bodyText.split('\n').filter(p => p.trim()).map(
    p => `<p style="margin:0 0 16px;font-size:15px;color:#555;line-height:1.6;">${p}</p>`
  ).join('\n    ');
  const starsHtml = buildStarRatingHtmlCron(reviewUrl, ctaText);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#E94560,#FF6B6B);padding:32px 32px 24px;text-align:center;">
    <div style="margin-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#fff;letter-spacing:0.5px;">Ryvite</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">${headline}</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;line-height:1.6;">Hey ${firstName},</p>
    ${bodyParagraphs}
    ${starsHtml}
    <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:1.5;text-align:center;">${footerNote}</p>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
    <p style="margin:0;font-size:12px;color:#aaa;">Ryvite — AI-Powered Custom Invitations</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function processReviewRequests() {
  let sent = 0;
  let reminders = 0;

  // Load configurable settings
  const settings = await loadReviewEmailSettings();

  // Skip entirely if review emails are disabled
  if (!settings.emailEnabled) return { sent: 0, reminders: 0, skipped: 'disabled' };

  // 1. Find eligible events: published, paid, event_date passed N days ago, has attending guests, no existing request
  const delayMs = settings.delayDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(Date.now() - delayMs).toISOString();

  const { data: eligibleEvents, error } = await supabaseAdmin
    .from('events')
    .select('id, title, user_id, event_type, event_date')
    .eq('status', 'published')
    .eq('payment_status', 'paid')
    .lt('event_date', cutoffDate)
    .limit(20);

  if (!error && eligibleEvents && eligibleEvents.length > 0) {
    // Filter out events that already have review requests
    const eventIds = eligibleEvents.map(e => e.id);
    const { data: existingRequests } = await supabaseAdmin
      .from('review_requests')
      .select('event_id')
      .in('event_id', eventIds);

    const existingEventIds = new Set((existingRequests || []).map(r => r.event_id));
    const newEvents = eligibleEvents.filter(e => !existingEventIds.has(e.id));

    for (const event of newEvents) {
      try {
        // Check if event has at least 1 attending guest
        const { count } = await supabaseAdmin
          .from('guests')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', event.id)
          .eq('status', 'attending');

        if (!count || count === 0) continue;

        // Get host email
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('email, display_name')
          .eq('id', event.user_id)
          .single();

        if (!profile?.email) continue;

        const token = crypto.randomUUID();

        await supabaseAdmin.from('review_requests').insert({
          user_id: event.user_id,
          event_id: event.id,
          token,
          status: 'sent',
          sent_at: new Date().toISOString()
        });

        // Send review request email using configurable template
        if (resend) {
          const reviewUrl = `https://www.ryvite.com/v2/review/?token=${token}`;
          const firstName = profile.display_name?.split(' ')[0] || 'there';
          const replaceVars = (str) => str.replace(/\{\{eventTitle\}\}/g, event.title).replace(/\{\{firstName\}\}/g, firstName);
          const emailSubject = replaceVars(settings.emailSubject);

          const emailResult = await resend.emails.send({
            from: 'Ryvite <hello@ryvite.com>',
            to: profile.email,
            subject: emailSubject,
            html: buildConfigurableReviewEmail(firstName, replaceVars(settings.emailHeadline), replaceVars(settings.emailBody), replaceVars(settings.emailCtaText), replaceVars(settings.emailFooterNote), reviewUrl)
          });

          // Log to notification_log for engagement tracking
          await supabaseAdmin.from('notification_log').insert({
            event_id: event.id,
            user_id: event.user_id,
            channel: 'email',
            recipient: profile.email,
            subject: emailSubject,
            status: 'sent',
            provider_id: emailResult?.data?.id || null,
            email_type: 'review_request',
            sent_at: new Date().toISOString()
          }).catch(() => {});
        }

        sent++;
      } catch (err) {
        console.error(`Error sending review request for event ${event.id}:`, err);
      }
    }
  }

  // 2. Send reminders: requests sent N days ago with no reminder yet and not completed
  if (!settings.reminderEnabled) return { sent, reminders: 0 };

  const reminderDelayMs = settings.reminderDelayDays * 24 * 60 * 60 * 1000;
  const reminderCutoff = new Date(Date.now() - reminderDelayMs).toISOString();

  const { data: dueReminders } = await supabaseAdmin
    .from('review_requests')
    .select(`
      id, user_id, event_id, token,
      events!inner(title),
      profiles!inner(email, display_name)
    `)
    .eq('status', 'sent')
    .lt('sent_at', reminderCutoff)
    .is('reminder_sent_at', null)
    .limit(20);

  if (dueReminders && dueReminders.length > 0) {
    for (const req of dueReminders) {
      try {
        if (!req.profiles?.email) continue;

        if (resend) {
          const reviewUrl = `https://www.ryvite.com/v2/review/?token=${req.token}`;
          const firstName = req.profiles.display_name?.split(' ')[0] || 'there';
          const eventTitle = req.events?.title || 'your event';
          const replaceVars = (str) => str.replace(/\{\{eventTitle\}\}/g, eventTitle).replace(/\{\{firstName\}\}/g, firstName);

          const reminderSubject = replaceVars(settings.reminderSubject);
          const emailResult = await resend.emails.send({
            from: 'Ryvite <hello@ryvite.com>',
            to: req.profiles.email,
            subject: reminderSubject,
            html: buildConfigurableReviewEmail(firstName, replaceVars(settings.reminderHeadline), replaceVars(settings.reminderBody), replaceVars(settings.reminderCtaText), replaceVars(settings.reminderFooterNote), reviewUrl)
          });

          // Log to notification_log for engagement tracking
          await supabaseAdmin.from('notification_log').insert({
            event_id: req.event_id,
            user_id: req.user_id,
            channel: 'email',
            recipient: req.profiles.email,
            subject: reminderSubject,
            status: 'sent',
            provider_id: emailResult?.data?.id || null,
            email_type: 'review_reminder',
            sent_at: new Date().toISOString()
          }).catch(() => {});
        }

        await supabaseAdmin
          .from('review_requests')
          .update({ status: 'reminded', reminder_sent_at: new Date().toISOString() })
          .eq('id', req.id);

        reminders++;
      } catch (err) {
        console.error(`Error sending review reminder ${req.id}:`, err);
      }
    }
  }

  return { sent, reminders };
}

function buildReviewRequestEmailCron(firstName, eventTitle, reviewUrl) {
  const starsHtml = buildStarRatingHtmlCron(reviewUrl);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#E94560,#FF6B6B);padding:32px 32px 24px;text-align:center;">
    <div style="margin-bottom:14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#fff;letter-spacing:0.5px;">Ryvite</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">How was ${eventTitle}?</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1A1A2E;line-height:1.6;">Hey ${firstName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#555;line-height:1.6;">We hope your event was amazing! We'd love to hear about your experience using Ryvite. Your feedback helps other hosts discover what's possible.</p>
    <p style="margin:0 0 8px;font-size:15px;color:#555;line-height:1.6;">It only takes a minute — tap a star below:</p>
    ${starsHtml}
    <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:1.5;text-align:center;">Your review may be featured on our site to help other event planners.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
    <p style="margin:0;font-size:12px;color:#aaa;">Ryvite — AI-Powered Custom Invitations</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ---- Job D: Process abandoned draft follow-up emails ----

function buildAbandonmentEmail(firstName, eventTitle, editUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background-color:#f5f5f5;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background-color:#1A1A2E;padding:32px 40px;border-radius:16px 16px 0 0;text-align:center;">
    <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;color:#FFFAF5;font-size:28px;font-weight:700;">
      Need a Hand?
    </h1>
  </td></tr>
  <tr><td style="background-color:#FFFAF5;padding:40px;">
    <p style="margin:0 0 16px;color:#1A1A2E;font-size:16px;line-height:1.6;">
      Hey ${firstName},
    </p>
    <p style="margin:0 0 24px;color:#1A1A2E;font-size:16px;line-height:1.6;">
      We noticed your event <strong>${eventTitle}</strong> is still a work in progress. No rush \u2014 but we wanted to make sure you know we\u2019re here if you need anything.
    </p>
    <div style="background-color:#F0F7FF;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
      <p style="margin:0;color:#1A1A2E;font-size:15px;line-height:1.6;">
        Pick up right where you left off \u2014 your draft is saved and ready to go.
      </p>
    </div>
    <div style="text-align:center;margin:32px 0;">
      <a href="${editUrl}" style="display:inline-block;background-color:#E94560;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:16px;font-weight:600;">
        Continue Editing
      </a>
    </div>
    <p style="margin:0;color:#6B7280;font-size:14px;line-height:1.6;text-align:center;">
      Need help? Just reply to this email \u2014 we\u2019d love to assist.
    </p>
  </td></tr>
  <tr><td style="background-color:#1A1A2E;padding:20px 40px;border-radius:0 0 16px 16px;text-align:center;">
    <p style="margin:0;color:#6B7280;font-size:12px;">Built with love for Rylan</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function processAbandonedDrafts() {
  if (!resend) return { sent: 0 };

  let sent = 0;

  // Find draft events created 24-48h ago (48h cap prevents processing ancient drafts)
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: draftEvents, error } = await supabaseAdmin
    .from('events')
    .select('id, title, user_id, created_at, settings')
    .eq('status', 'draft')
    .lt('created_at', cutoff24h)
    .gt('created_at', cutoff48h)
    .limit(20);

  if (error || !draftEvents || draftEvents.length === 0) return { sent: 0 };

  for (const event of draftEvents) {
    try {
      // Check if abandonment email already sent (subject contains "still in draft")
      const { count } = await supabaseAdmin
        .from('notification_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', event.id)
        .ilike('subject', '%still in draft%');

      if (count > 0) continue;

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, display_name')
        .eq('id', event.user_id)
        .single();

      if (!profile?.email) continue;

      const firstName = profile.display_name?.split(' ')[0] || 'there';
      const eventTitle = event.title || 'your event';
      const creationStep = event.settings?.creation_step || 0;
      const editUrl = `https://www.ryvite.com/v2/create/?eventId=${event.id}&step=${creationStep}`;
      const subject = `Your event \u201c${eventTitle}\u201d is still in draft \u2014 need help?`;

      const emailResult = await resend.emails.send({
        from: 'Ryvite <hello@ryvite.com>',
        to: profile.email,
        subject,
        html: buildAbandonmentEmail(firstName, eventTitle, editUrl)
      });

      await supabaseAdmin.from('notification_log').insert({
        event_id: event.id,
        user_id: event.user_id,
        guest_id: null,
        channel: 'email',
        recipient: profile.email,
        subject,
        status: 'sent',
        provider_id: emailResult?.data?.id || null,
        email_type: 'abandonment_nudge',
        sent_at: new Date().toISOString()
      });

      sent++;
    } catch (err) {
      console.error(`Abandonment email error for event ${event.id}:`, err);
    }
  }

  return { sent };
}

// ---- Main Handler ----

export default async function handler(req, res) {
  // Verify cron secret — Vercel sends this automatically for cron jobs
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [reminderResults, digestResults, reviewResults, abandonmentResults] = await Promise.all([
      processDueReminders(),
      processRsvpDigests(),
      processReviewRequests(),
      processAbandonedDrafts()
    ]);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      reminders: reminderResults,
      digests: digestResults,
      reviews: reviewResults,
      abandonedDrafts: abandonmentResults
    });
  } catch (err) {
    console.error('SMS cron error:', err);
    return res.status(500).json({ success: false, error: 'Cron job failed' });
  }
}
