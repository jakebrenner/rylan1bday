import { createClient } from '@supabase/supabase-js';
import { checkAndChargeSmsUsage } from './billing.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3/sms/send';
const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
const SMS_COST_CENTS = 10;

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

  await checkAndChargeSmsUsage(userId).catch(err => {
    console.error('SMS billing check failed:', err);
  });

  return smsRecords.length;
}

// ---- Job A: Process due reminders ----

async function processDueReminders() {
  const now = new Date().toISOString();

  // Find all pending reminders that are due
  const { data: dueReminders, error } = await supabaseAdmin
    .from('sms_reminders')
    .select('*, events!inner(id, title, user_id, event_date, location_name)')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .limit(50); // Process in batches to stay within timeout

  if (error || !dueReminders || dueReminders.length === 0) {
    return { reminders: 0, messages: 0 };
  }

  let totalMessages = 0;

  for (const reminder of dueReminders) {
    try {
      // Fetch guests with phones who are attending or haven't declined
      const { data: guests } = await supabaseAdmin
        .from('guests')
        .select('id, name, phone, status')
        .eq('event_id', reminder.event_id)
        .not('phone', 'is', null)
        .in('status', ['attending', 'maybe', 'invited']);

      const validGuests = (guests || []).filter(g => toE164(g.phone) !== null);

      if (validGuests.length === 0) {
        // No guests to remind — mark as sent with 0 recipients
        await supabaseAdmin
          .from('sms_reminders')
          .update({ status: 'sent', sent_at: now, recipients_count: 0 })
          .eq('id', reminder.id);
        continue;
      }

      // Build messages with {name} placeholder support
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

        totalMessages += recorded;

        await supabaseAdmin
          .from('sms_reminders')
          .update({ status: 'sent', sent_at: now, recipients_count: validGuests.length })
          .eq('id', reminder.id);
      } else {
        console.error(`Reminder ${reminder.id} failed:`, result.error);
        await supabaseAdmin
          .from('sms_reminders')
          .update({ status: 'failed' })
          .eq('id', reminder.id);
      }
    } catch (err) {
      console.error(`Error processing reminder ${reminder.id}:`, err);
      await supabaseAdmin
        .from('sms_reminders')
        .update({ status: 'failed' })
        .eq('id', reminder.id);
    }
  }

  return { reminders: dueReminders.length, messages: totalMessages };
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

// ---- Main Handler ----

export default async function handler(req, res) {
  // Verify cron secret — Vercel sends this automatically for cron jobs
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [reminderResults, digestResults] = await Promise.all([
      processDueReminders(),
      processRsvpDigests()
    ]);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      reminders: reminderResults,
      digests: digestResults
    });
  } catch (err) {
    console.error('SMS cron error:', err);
    return res.status(500).json({ success: false, error: 'Cron job failed' });
  }
}
