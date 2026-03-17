import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Max error reports before auto-triggering self-heal for a theme
const ERROR_THRESHOLD = 3;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

  // ── REPORT RENDERING ERROR (no auth — called from client health checks) ──
  if (action === 'report' && req.method === 'POST') {
    const { eventId, eventThemeId, errors, pageContext, deviceInfo, themeHtmlHash, fingerprint } = req.body;

    if (!eventThemeId || !errors || !Array.isArray(errors) || errors.length === 0) {
      return res.status(400).json({ success: false, error: 'eventThemeId and errors[] required' });
    }

    // Deduplicate: check if we already have a report with same hash + error types recently
    if (themeHtmlHash && fingerprint) {
      const { count } = await supabase
        .from('theme_error_reports')
        .select('id', { count: 'exact', head: true })
        .eq('theme_html_hash', themeHtmlHash)
        .eq('fingerprint', fingerprint)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

      if (count > 0) {
        return res.status(200).json({ success: true, deduplicated: true });
      }
    }

    // Classify severity
    const hasCritical = errors.some(e =>
      e.type === 'missing_element' && (e.detail === '.rsvp-slot' || e.detail === 'data-field=title')
    );

    // Insert error reports
    const rows = errors.map(err => ({
      event_id: eventId || null,
      event_theme_id: eventThemeId,
      error_type: err.type,
      error_details: err.detail ? (typeof err.detail === 'object' ? err.detail : { detail: err.detail }) : {},
      page_context: pageContext || 'invite_page',
      device_info: deviceInfo || null,
      theme_html_hash: themeHtmlHash || null,
      severity: err.type === 'missing_element' ? 'critical' : (err.type === 'layout_overflow' ? 'warning' : 'info'),
      fingerprint: fingerprint || null
    }));

    const { error: insertErr } = await supabase
      .from('theme_error_reports')
      .insert(rows);

    if (insertErr) {
      console.error('Error saving error report:', insertErr);
      return res.status(500).json({ success: false, error: 'Failed to save report' });
    }

    // Check if we should trigger self-heal
    let healTriggered = false;
    if (hasCritical) {
      // Critical errors trigger immediate self-heal
      healTriggered = await triggerSelfHeal(eventId, eventThemeId, 'critical_error', {
        errorTypes: errors.map(e => e.type),
        errorCount: errors.length
      });
    } else {
      // Check total unique error types for this theme
      const { count: totalErrors } = await supabase
        .from('theme_error_reports')
        .select('id', { count: 'exact', head: true })
        .eq('event_theme_id', eventThemeId);

      if (totalErrors >= ERROR_THRESHOLD) {
        healTriggered = await triggerSelfHeal(eventId, eventThemeId, 'error_report', {
          errorTypes: errors.map(e => e.type),
          errorCount: totalErrors
        });
      }
    }

    return res.status(200).json({ success: true, errorsLogged: rows.length, healTriggered });
  }

  // ── SAVE DESIGN CHAT MESSAGES ──
  if (action === 'saveChatMessages' && req.method === 'POST') {
    const { eventId, eventThemeId, messages } = req.body;

    if (!eventId || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'eventId and messages[] required' });
    }

    // Get current max message_index for this event
    const { data: existing } = await supabase
      .from('design_chat_logs')
      .select('message_index')
      .eq('event_id', eventId)
      .order('message_index', { ascending: false })
      .limit(1);

    const startIndex = existing?.length > 0 ? existing[0].message_index + 1 : 0;

    const rows = messages.map((msg, i) => ({
      event_id: eventId,
      event_theme_id: eventThemeId || null,
      message_index: startIndex + i,
      role: msg.role || 'user',
      content: (msg.content || '').substring(0, 50000), // cap at 50k chars
      tier_used: msg.tierUsed || null,
      metadata: msg.metadata || {}
    }));

    const { error: insertErr } = await supabase
      .from('design_chat_logs')
      .insert(rows);

    if (insertErr) {
      console.error('Error saving chat messages:', insertErr);
      return res.status(500).json({ success: false, error: 'Failed to save messages' });
    }

    return res.status(200).json({ success: true, messagesSaved: rows.length });
  }

  // ── GET CHAT LOG FOR AN EVENT (admin use) ──
  if (action === 'getChatLog' && req.method === 'GET') {
    const eventId = req.query.eventId;
    if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

    const { data, error } = await supabase
      .from('design_chat_logs')
      .select('*')
      .eq('event_id', eventId)
      .order('message_index', { ascending: true });

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(200).json({ success: true, messages: data || [] });
  }

  // ── GET ERROR REPORTS FOR A THEME (admin use) ──
  if (action === 'getErrors' && req.method === 'GET') {
    const eventThemeId = req.query.eventThemeId;
    if (!eventThemeId) return res.status(400).json({ success: false, error: 'eventThemeId required' });

    const { data, error } = await supabase
      .from('theme_error_reports')
      .select('*')
      .eq('event_theme_id', eventThemeId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(200).json({ success: true, errors: data || [] });
  }

  return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
}

// Trigger self-heal by calling the self-heal endpoint
async function triggerSelfHeal(eventId, eventThemeId, triggerType, triggerDetails) {
  try {
    // Check cooldown: max 1 heal attempt per theme per 24 hours
    const { count } = await supabase
      .from('self_heal_log')
      .select('id', { count: 'exact', head: true })
      .eq('original_theme_id', eventThemeId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (count > 0) {
      console.log('[self-heal] Skipping — cooldown active for theme', eventThemeId);
      return false;
    }

    // Create a pending heal log entry
    const { data: healLog, error: healErr } = await supabase
      .from('self_heal_log')
      .insert({
        event_id: eventId,
        original_theme_id: eventThemeId,
        trigger_type: triggerType,
        trigger_details: triggerDetails,
        status: 'pending'
      })
      .select('id')
      .single();

    if (healErr) {
      console.error('[self-heal] Failed to create heal log:', healErr);
      return false;
    }

    // Call self-heal asynchronously (for error-report triggers — not blocking the user)
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://www.ryvite.com';

    fetch(`${baseUrl}/api/v2/self-heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        healLogId: healLog.id,
        eventThemeId,
        eventId,
        triggerType,
        triggerDetails
      })
    }).catch(err => console.error('[self-heal] Async trigger failed:', err));

    return true;
  } catch (err) {
    console.error('[self-heal] triggerSelfHeal error:', err);
    return false;
  }
}
