import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { reportApiError } from './lib/error-reporter.js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// AI model pricing per 1M tokens — must match billing.js, generate-theme.js, chat.js, admin.js, ratings.js
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
  'gpt-4.1':                   { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':              { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':              { input: 0.10, output: 0.40 },
  'o3':                        { input: 2.00, output: 8.00 },
  'o4-mini':                   { input: 1.10, output: 4.40 },
};

function calcCost(model, inputTokens, outputTokens) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCents = ((inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000) * 100;
  return Math.round(rawCents * 100) / 100;
}

// ── Auth helper (same pattern as generate-theme.js) ──
async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Extract client metadata from request headers + client-sent device info ──
function getClientMeta(req, clientDeviceInfo) {
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  const geo = {};
  if (req.headers['x-vercel-ip-country']) geo.country = req.headers['x-vercel-ip-country'];
  if (req.headers['x-vercel-ip-country-region']) geo.region = req.headers['x-vercel-ip-country-region'];
  if (req.headers['x-vercel-ip-city']) geo.city = decodeURIComponent(req.headers['x-vercel-ip-city'] || '');
  if (req.headers['x-vercel-ip-latitude']) geo.latitude = req.headers['x-vercel-ip-latitude'];
  if (req.headers['x-vercel-ip-longitude']) geo.longitude = req.headers['x-vercel-ip-longitude'];
  const userAgent = (req.headers['user-agent'] || '').substring(0, 500);

  // Merge server headers with client-sent device info
  return {
    user_agent: clientDeviceInfo?.user_agent || userAgent,
    client_ip: ip,
    client_geo: Object.keys(geo).length > 0 ? geo : null,
    screen_width: clientDeviceInfo?.screen_width || null,
    screen_height: clientDeviceInfo?.screen_height || null,
    viewport_width: clientDeviceInfo?.viewport_width || null,
    viewport_height: clientDeviceInfo?.viewport_height || null,
    device_pixel_ratio: clientDeviceInfo?.device_pixel_ratio || null,
    platform: clientDeviceInfo?.platform || null,
    touch: clientDeviceInfo?.touch || null,
    connection: clientDeviceInfo?.connection || null
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';
  try {

  // ── LOG DESIGN CHAT MESSAGE (real-time persistence) ──
  if (action === 'logChatMessage' && req.method === 'POST') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { eventId, role, content, themeVersionIndex, metadata } = req.body;
    if (!eventId || !role || content === undefined) {
      return res.status(400).json({ error: 'eventId, role, and content are required' });
    }

    // Skip system messages (loading spinners, etc.) — they're transient
    if (role === 'system') return res.status(200).json({ success: true, skipped: true });

    const { error } = await supabase.from('chat_messages').insert({
      user_id: user.id,
      session_id: eventId, // Use eventId as session_id for design chat
      event_id: eventId,
      phase: 'design',
      role,
      content: (content || '').substring(0, 5000),
      model: metadata?.model || null,
      input_tokens: 0,
      output_tokens: 0
    });

    if (error) {
      console.error('[quality-monitor] Chat message insert failed:', error.message);
      return res.status(500).json({ error: 'Failed to save chat message' });
    }

    return res.status(200).json({ success: true });
  }

  // ── REPORT QUALITY INCIDENT ──
  if (action === 'reportIncident' && req.method === 'POST') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { eventId, eventThemeId, triggerType, triggerData, themeSnapshot, validationResults, clientDeviceInfo } = req.body;
    if (!eventId || !triggerType) {
      return res.status(400).json({ error: 'eventId and triggerType are required' });
    }

    const validTriggers = ['low_rating', 'broken_render', 'high_gtp', 'user_complaint', 'content_warning', 'auto_heal_failure'];
    if (!validTriggers.includes(triggerType)) {
      return res.status(400).json({ error: 'Invalid triggerType' });
    }

    // Deduplicate: don't create another incident for same event+trigger within 5 minutes
    const { data: recentIncident } = await supabase
      .from('quality_incidents')
      .select('id')
      .eq('event_id', eventId)
      .eq('trigger_type', triggerType)
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .limit(1);

    if (recentIncident?.length > 0) {
      return res.status(200).json({ success: true, incidentId: recentIncident[0].id, deduplicated: true });
    }

    // Build client_meta from request headers + client-sent device info
    const clientMeta = getClientMeta(req, clientDeviceInfo);

    // Fetch recent design chat for this event
    let chatSnapshot = null;
    try {
      const { data: chatMessages } = await supabase
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('event_id', eventId)
        .eq('phase', 'design')
        .order('created_at', { ascending: false })
        .limit(30);
      if (chatMessages?.length > 0) {
        chatSnapshot = chatMessages.reverse(); // Chronological order
      }
    } catch (e) {
      console.warn('[quality-monitor] Failed to fetch chat snapshot:', e.message);
    }

    // Create incident
    const row = {
      event_id: eventId,
      event_theme_id: eventThemeId || null,
      user_id: user.id,
      trigger_type: triggerType,
      trigger_data: triggerData || null,
      design_chat_snapshot: chatSnapshot,
      theme_snapshot: themeSnapshot || null,
      validation_results: validationResults || null,
      client_meta: clientMeta,
      resolution_type: 'unresolved'
    };

    let { data: incident, error: insertErr } = await supabase
      .from('quality_incidents')
      .insert(row)
      .select('id')
      .single();

    // If client_meta column doesn't exist yet, retry without it
    if (insertErr && insertErr.message && (insertErr.message.includes('client_meta') || insertErr.message.includes('column'))) {
      delete row.client_meta;
      ({ data: incident, error: insertErr } = await supabase
        .from('quality_incidents')
        .insert(row)
        .select('id')
        .single());
    }

    if (insertErr) {
      console.error('[quality-monitor] Incident insert failed:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create incident' });
    }

    // Return immediately — diagnosis happens in background
    res.status(200).json({ success: true, incidentId: incident.id });

    // ── BACKGROUND: AI Diagnosis + Auto-Heal ──
    try {
      await diagnoseAndHeal(incident.id, {
        eventId, eventThemeId, triggerType, triggerData,
        themeSnapshot, validationResults, chatSnapshot,
        userId: user.id
      });
    } catch (e) {
      console.error('[quality-monitor] Background diagnosis failed:', e.message);
    }

    return;
  }

  // ── CHECK FOR HEALED THEME (client polls after reporting incident) ──
  if (action === 'checkHealedTheme' && req.method === 'GET') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const eventId = req.query.eventId;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });

    // Find the most recent auto-healed incident for this event
    const { data: incident } = await supabase
      .from('quality_incidents')
      .select('id, ai_diagnosis, resolution_type, resolution_data')
      .eq('event_id', eventId)
      .eq('user_id', user.id)
      .eq('resolution_type', 'auto_healed')
      .order('resolved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!incident || !incident.resolution_data?.new_theme_id) {
      return res.status(200).json({ healed: false });
    }

    // Fetch the healed theme
    const { data: healedTheme } = await supabase
      .from('event_themes')
      .select('id, version, html, css, config')
      .eq('id', incident.resolution_data.new_theme_id)
      .single();

    if (!healedTheme) {
      return res.status(200).json({ healed: false });
    }

    return res.status(200).json({
      healed: true,
      incidentId: incident.id,
      diagnosis: incident.ai_diagnosis,
      newTheme: healedTheme
    });
  }

  // ── REPORT GUEST INCIDENT (no auth required — guests aren't logged in) ──
  if (action === 'reportGuestIncident' && req.method === 'POST') {
    const { eventId, slug, triggerType, triggerData, themeSnapshot, clientDeviceInfo } = req.body;
    if (!eventId) {
      return res.status(400).json({ error: 'eventId is required' });
    }

    // Rate limit: max 1 incident per IP per event per 10 minutes
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
    const { data: recentGuestIncident } = await supabase
      .from('quality_incidents')
      .select('id')
      .eq('event_id', eventId)
      .eq('trigger_type', 'guest_broken_render')
      .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
      .limit(1);

    if (recentGuestIncident?.length > 0) {
      return res.status(200).json({ success: true, deduplicated: true });
    }

    const clientMeta = getClientMeta(req, clientDeviceInfo);

    const { data: incident, error: insertErr } = await supabase
      .from('quality_incidents')
      .insert({
        event_id: eventId,
        user_id: null,
        trigger_type: 'guest_broken_render',
        trigger_data: { ...(triggerData || {}), slug: slug || '' },
        theme_snapshot: themeSnapshot || null,
        client_meta: clientMeta,
        resolution_type: 'unresolved'
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[quality-monitor] Guest incident insert failed:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create incident' });
    }

    console.log('[quality-monitor] Guest incident created:', { incidentId: incident.id, eventId, slug, ip: clientIp });
    return res.status(200).json({ success: true, incidentId: incident.id });
  }

  // ── ADMIN RETRY HEAL (re-run diagnoseAndHeal on an existing incident) ──
  if (action === 'adminRetryHeal' && req.method === 'POST') {
    const { incidentId } = req.body;
    if (!incidentId) return res.status(400).json({ error: 'incidentId required' });

    console.log('[adminRetryHeal] Starting for incident:', incidentId);

    const { data: incident, error: fetchErr } = await supabase
      .from('quality_incidents')
      .select('*')
      .eq('id', incidentId)
      .single();

    if (fetchErr) {
      console.error('[adminRetryHeal] Fetch error:', fetchErr.message);
      return res.status(404).json({ error: 'Incident not found: ' + fetchErr.message });
    }
    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    console.log('[adminRetryHeal] Incident loaded:', {
      id: incident.id,
      trigger: incident.trigger_type,
      eventId: incident.event_id,
      hasThemeSnapshot: !!incident.theme_snapshot,
      hasHtml: !!(incident.theme_snapshot?.html),
      hasCss: !!(incident.theme_snapshot?.css)
    });

    // If theme_snapshot is missing or has no HTML, we can't diagnose
    if (!incident.theme_snapshot?.html && !incident.theme_snapshot?.css) {
      // Try to fetch current theme from event_themes
      let themeSnapshot = incident.theme_snapshot || {};
      if (incident.event_id) {
        const { data: theme } = await supabase
          .from('event_themes')
          .select('html, css, config')
          .eq('event_id', incident.event_id)
          .eq('is_active', true)
          .single();
        if (theme) {
          themeSnapshot = { html: theme.html, css: theme.css, config: theme.config };
          console.log('[adminRetryHeal] Loaded theme from event_themes');
        }
      }
      if (!themeSnapshot.html) {
        return res.status(400).json({ error: 'No theme HTML available for this incident. Cannot diagnose.' });
      }
      // Update incident with the theme snapshot for future retries
      await supabase.from('quality_incidents').update({ theme_snapshot: themeSnapshot }).eq('id', incidentId);
      incident.theme_snapshot = themeSnapshot;
    }

    // Build context from stored incident data
    const ctx = {
      eventId: incident.event_id,
      eventThemeId: incident.event_theme_id,
      triggerType: incident.trigger_type,
      triggerData: incident.trigger_data,
      themeSnapshot: incident.theme_snapshot,
      validationResults: incident.validation_results,
      chatSnapshot: incident.design_chat_snapshot,
      userId: incident.user_id
    };

    // Clear previous resolution/diagnosis for a fresh retry
    await supabase.from('quality_incidents').update({
      resolution_type: null, resolution_data: null, resolved_at: null,
      ai_diagnosis: null, ai_diagnosis_model: null, diagnosis_tokens: null
    }).eq('id', incidentId);

    // Run synchronously so admin sees result
    try {
      console.log('[adminRetryHeal] Running diagnoseAndHeal...');
      await diagnoseAndHeal(incidentId, ctx);
      console.log('[adminRetryHeal] diagnoseAndHeal completed');

      // Re-fetch to see if it was healed
      const { data: updated } = await supabase
        .from('quality_incidents')
        .select('resolution_type, ai_diagnosis, resolution_data')
        .eq('id', incidentId)
        .single();

      console.log('[adminRetryHeal] Result:', {
        resolution: updated?.resolution_type,
        hasDiagnosis: !!updated?.ai_diagnosis,
        hasNewTheme: !!updated?.resolution_data?.new_theme_id
      });

      const healed = updated?.resolution_type === 'auto_healed';
      return res.status(200).json({
        success: true,
        healed,
        resolution: updated?.resolution_type,
        diagnosis: updated?.ai_diagnosis || null,
        newThemeId: updated?.resolution_data?.new_theme_id || null
      });
    } catch (e) {
      console.error('[adminRetryHeal] Failed:', e.message, e.stack);
      await supabase.from('quality_incidents').update({
        resolution_type: 'escalated',
        ai_diagnosis: 'Admin retry heal error: ' + e.message,
        resolution_data: { error: e.message, stack: (e.stack || '').substring(0, 500), admin_retry: true }
      }).eq('id', incidentId);
      return res.status(200).json({
        success: true,
        healed: false,
        resolution: 'escalated',
        diagnosis: 'Heal failed: ' + e.message
      });
    }
  }

  // ── FIX USER-REPORTED ISSUE (synchronous — user is waiting) ──
  if (action === 'fixUserReportedIssue' && req.method === 'POST') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { eventId, eventThemeId, userDescription, themeSnapshot, validationResults, cssIssues, attemptNumber, designChatHistory: chatHistory } = req.body;
    if (!eventId || !userDescription) {
      return res.status(400).json({ error: 'eventId and userDescription are required' });
    }

    try { // Outer try/catch — ensures we always return JSON, never a 500 plain text error

    const fixModel = 'claude-sonnet-4-6';
    const startTime = Date.now();

    // Log incident
    const clientMeta = getClientMeta(req);
    const { data: incident } = await supabase
      .from('quality_incidents')
      .insert({
        event_id: eventId,
        event_theme_id: eventThemeId || null,
        user_id: user.id,
        trigger_type: 'user_complaint',
        trigger_data: { userDescription, attemptNumber: attemptNumber || 1, cssIssues: cssIssues || [] },
        theme_snapshot: themeSnapshot || null,
        validation_results: validationResults || null,
        client_meta: clientMeta,
        resolution_type: 'unresolved'
      })
      .select('id')
      .single()
      .then(r => r, e => {
        console.error('[quality-monitor] User complaint incident insert failed:', e?.message || e);
        return { data: null };
      });

    // Fetch event details
    const { data: event } = await supabase
      .from('events')
      .select('title, event_date, event_type, location_name')
      .eq('id', eventId)
      .single();

    const htmlContent = themeSnapshot?.html || '';
    const cssContent = themeSnapshot?.css || '';
    const configContent = themeSnapshot?.config || {};
    const cssIssuesList = (cssIssues || []).join(', ') || 'none detected';
    const attemptNum = attemptNumber || 1;

    try {
      const resp = await client.messages.create({
        model: fixModel,
        max_tokens: 16000,
        system: `You are a CSS/HTML expert fixing display issues in AI-generated event invitations.
The user has reported a visual problem. You have their invite's full HTML and CSS.

STRUCTURAL RULES (do NOT violate):
- MUST keep: <div class="rsvp-slot"></div>, <div class="details-slot"></div>, element with data-field="title"
- MUST keep: all existing text content and structural elements
- CSS @import for Google Fonts MUST be the very first line of CSS
- Mobile-first: designed for 393px viewport width
- No <script> tags, no external resources except Google Fonts
- All animations must be CSS-only (no JS)

REPAIR APPROACH:
- Prefer minimal CSS changes over full rewrites
- If the issue is purely visual (contrast, visibility, positioning), fix ONLY the CSS
- If the issue is structural (missing elements, broken HTML), fix both HTML and CSS
- Preserve the overall design aesthetic — only change what's broken`,
        messages: [{ role: 'user', content: `The user reported this issue with their ${event?.event_type || 'event'} invite ("${event?.title || 'Untitled'}"):

USER COMPLAINT: "${userDescription}"
${attemptNum > 1 ? `\nThis is attempt #${attemptNum} — previous fix attempts did not resolve the issue. Try a different approach.` : ''}

Automated validation detected these CSS issues: ${cssIssuesList}

Current theme HTML:
${htmlContent}

Current theme CSS:
${cssContent}

Current config: ${JSON.stringify(configContent)}

Return a JSON object (no markdown fences):
{
  "fixed": true,
  "html": "the complete fixed HTML (include ALL content, not just changed parts)",
  "css": "the complete fixed CSS (include @import on first line if needed)",
  "config": { "backgroundColor": "...", "textColor": "...", "fontBody": "...", "fontHeadline": "...", "primaryColor": "...", "googleFontsImport": "..." },
  "explanation": "Brief explanation of what was fixed (1-2 sentences, user-friendly)"
}

If the issue is unfixable without a complete redesign, return:
{
  "fixed": false,
  "explanation": "Why this can't be fixed with a patch",
  "suggestion": "What to tell the user"
}` }]
      });

      const fixTokens = {
        input: resp.usage?.input_tokens || 0,
        output: resp.usage?.output_tokens || 0
      };

      // Parse response
      const rawText = resp.content[0]?.text?.trim() || '';
      const cleaned = rawText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
      let fixResult;
      try {
        fixResult = JSON.parse(cleaned);
      } catch (parseErr) {
        // Try to extract JSON from the response
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          fixResult = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('Could not parse AI response as JSON');
        }
      }

      // Log to generation_log for cost tracking
      await supabase.from('generation_log').insert({
        event_id: eventId,
        user_id: user.id,
        prompt: 'Support fix (user_complaint): ' + userDescription.substring(0, 200),
        model: fixModel,
        input_tokens: fixTokens.input,
        output_tokens: fixTokens.output,
        latency_ms: Date.now() - startTime,
        status: fixResult.fixed ? 'success' : 'failed',
        is_tweak: true,
        event_type: event?.event_type || ''
      });

      // Track cost
      const fixCostCents = calcCost(fixModel, fixTokens.input, fixTokens.output);
      if (eventId) {
        try { await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: fixCostCents }); } catch(_) {}
      }

      if (!fixResult.fixed) {
        // Update incident as escalated
        if (incident?.id) {
          await supabase.from('quality_incidents').update({
            ai_diagnosis: fixResult.explanation || 'Could not fix',
            ai_diagnosis_model: fixModel,
            diagnosis_tokens: fixTokens,
            resolution_type: 'escalated'
          }).eq('id', incident.id);
        }

        return res.status(200).json({
          success: true,
          fixed: false,
          diagnosis: fixResult.explanation,
          message: fixResult.suggestion || "I wasn't able to fix this issue automatically."
        });
      }

      // Validate the fixed output
      const fixedHtml = fixResult.html || htmlContent;
      const fixedCss = fixResult.css || cssContent;
      const fixedConfig = fixResult.config || configContent;

      const hasRsvp = fixedHtml.includes('rsvp-slot');
      const hasDetails = fixedHtml.includes('details-slot');
      const hasTitle = fixedHtml.includes('data-field="title"') || fixedHtml.includes("data-field='title'");
      const healCssIssues = validateHealedCss(fixedHtml, fixedCss);

      if (!hasRsvp || !hasDetails || !hasTitle || healCssIssues.length > 0) {
        console.warn('[quality-monitor] Support fix failed validation:', { hasRsvp, hasDetails, hasTitle, healCssIssues });
        if (incident?.id) {
          await supabase.from('quality_incidents').update({
            ai_diagnosis: 'Fix generated but failed validation: ' + healCssIssues.join(', '),
            ai_diagnosis_model: fixModel,
            resolution_type: 'escalated'
          }).eq('id', incident.id);
        }
        return res.status(200).json({
          success: true,
          fixed: false,
          diagnosis: 'The fix I generated had some issues of its own. Let me try a different approach.',
          message: 'The AI fix had validation issues — try describing the problem differently.'
        });
      }

      // Save as new theme version
      const { data: existingThemes } = await supabase
        .from('event_themes').select('version').eq('event_id', eventId)
        .order('version', { ascending: false }).limit(1);
      const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;

      await supabase.from('event_themes').update({ is_active: false })
        .eq('event_id', eventId).eq('is_active', true);

      const { data: newTheme, error: themeErr } = await supabase
        .from('event_themes').insert({
          event_id: eventId, version: nextVersion, is_active: true,
          html: fixedHtml, css: fixedCss, config: fixedConfig,
          model: fixModel,
          input_tokens: fixTokens.input, output_tokens: fixTokens.output,
          latency_ms: Date.now() - startTime,
          prompt: 'Support fix: ' + userDescription.substring(0, 500)
        }).select('id').single();

      if (themeErr) {
        console.error('[quality-monitor] Support fix theme save failed:', themeErr.message);
        return res.status(200).json({
          success: true,
          fixed: false,
          diagnosis: 'Fixed the issue but failed to save — please try again.',
          message: 'Save error'
        });
      }

      // Update incident as resolved
      if (incident?.id) {
        await supabase.from('quality_incidents').update({
          ai_diagnosis: fixResult.explanation,
          ai_diagnosis_model: fixModel,
          diagnosis_tokens: fixTokens,
          resolution_type: 'auto_healed',
          resolution_data: {
            new_theme_id: newTheme.id, model_used: fixModel,
            action_taken: 'user_reported_fix', userDescription,
            latencyMs: Date.now() - startTime
          },
          resolved_at: new Date().toISOString()
        }).eq('id', incident.id);
      }

      return res.status(200).json({
        success: true,
        fixed: true,
        theme: { id: newTheme.id, html: fixedHtml, css: fixedCss, config: fixedConfig, version: nextVersion },
        diagnosis: fixResult.explanation,
        message: fixResult.explanation
      });

    } catch (aiErr) {
      console.error('[quality-monitor] Support fix AI call failed:', aiErr.message);
      if (incident?.id) {
        await supabase.from('quality_incidents').update({
          ai_diagnosis: 'AI fix call failed: ' + aiErr.message,
          resolution_type: 'escalated'
        }).eq('id', incident.id);
      }
      return res.status(200).json({
        success: true,
        fixed: false,
        diagnosis: 'I ran into an issue trying to fix this. Let me escalate to the team.',
        message: aiErr.message
      });
    }

    } catch (outerErr) { // Outer catch — prevents Vercel from returning a generic 500 plain text error
      console.error('[quality-monitor] fixUserReportedIssue outer error:', outerErr);
      return res.status(200).json({
        success: true,
        fixed: false,
        diagnosis: "I ran into a technical issue. Can you try describing the problem differently?",
        message: outerErr.message || 'Internal error'
      });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('Quality monitor API error:', err);
    await reportApiError({ endpoint: '/api/v2/quality-monitor', action: action || 'unknown', error: err, requestBody: req.body, req }).catch(() => {});
    return res.status(500).json({ error: 'Server error' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PATTERN DETECTION
// After diagnosis, check if this root cause has hit a threshold
// that warrants a suggested prompt rule change.
// ═══════════════════════════════════════════════════════════════════
async function checkForPatterns(rootCause, incidentId) {
  if (!rootCause || rootCause === 'unknown') return;

  try {
    // Count incidents with same root cause in last 24 hours
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: count24h } = await supabase
      .from('quality_incidents')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since24h)
      .filter('ai_diagnosis', 'neq', null);

    // We need to do a more specific query — filter by rootCause in JSONB
    // Supabase doesn't support direct JSONB text field filtering easily, so query and filter
    const { data: recentDiagnosed } = await supabase
      .from('quality_incidents')
      .select('id, ai_diagnosis, event_id, client_meta')
      .gte('created_at', since24h)
      .not('ai_diagnosis', 'is', null)
      .limit(100);

    // ai_diagnosis is a TEXT field containing the diagnosis string, not the full JSON
    // The rootCause is stored in the diagnosis response but we only save the text.
    // We need to check if a suggested_rule for this rootCause already exists recently
    const { data: existingSuggestion } = await supabase
      .from('suggested_rules')
      .select('id')
      .eq('root_cause', rootCause)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (existingSuggestion?.length > 0) return; // Already suggested recently

    // Count incidents with this rootCause — we'll use trigger_data or check a pattern
    // Since rootCause is not directly queryable (it's in the AI response),
    // use a simpler heuristic: count broken_render incidents in 24h
    const { data: brokenRenders } = await supabase
      .from('quality_incidents')
      .select('id, trigger_type')
      .gte('created_at', since24h)
      .eq('trigger_type', 'broken_render');

    const incidentCount = (brokenRenders || []).length;
    if (incidentCount < 5) return; // Not enough to suggest a pattern

    // Generate a suggested rule via Haiku
    const suggestion = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `We've seen ${incidentCount} broken render quality incidents in the last 24 hours on our invite design platform. The most recent root cause was "${rootCause}".

Suggest a concise rule (1-2 sentences) to add to our AI prompt's design instructions to prevent this type of rendering issue. The rule should be actionable for an AI generating HTML/CSS invite designs.

Return ONLY the rule text, no explanation or formatting.`
      }]
    });

    const ruleText = (suggestion.content[0]?.text || '').trim();
    // Log suggestRule AI call to generation_log for cost tracking
    await supabase.from('generation_log').insert({
      event_id: null, user_id: null,
      prompt: 'QM suggestRule: ' + rootCause,
      model: 'claude-haiku-4-5-20251001',
      input_tokens: suggestion.usage?.input_tokens || 0,
      output_tokens: suggestion.usage?.output_tokens || 0,
      latency_ms: 0, status: 'success', is_tweak: false
    });
    if (!ruleText || ruleText.length > 500) return;

    // Collect affected browsers from recent incidents
    const affectedBrowsers = [...new Set(
      (recentDiagnosed || [])
        .map(i => {
          const ua = i.client_meta?.user_agent || '';
          if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
          if (ua.includes('Chrome')) return 'Chrome';
          if (ua.includes('Firefox')) return 'Firefox';
          return 'Other';
        })
        .filter(Boolean)
    )];

    const affectedEvents = new Set((recentDiagnosed || []).map(i => i.event_id).filter(Boolean)).size;

    await supabase.from('suggested_rules').insert({
      root_cause: rootCause,
      trigger_pattern: `${rootCause} x${incidentCount} in 24h`,
      suggested_text: ruleText,
      source_incidents: [incidentId],
      incident_count: incidentCount,
      affected_events: affectedEvents,
      affected_browsers: affectedBrowsers,
      status: 'pending'
    });

    console.log('[quality-monitor] Suggested rule created for pattern:', rootCause, '—', ruleText.substring(0, 80));
  } catch (e) {
    console.warn('[quality-monitor] Pattern check failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI DIAGNOSIS + AUTO-HEAL
// Runs in background after incident creation.
// 1. Haiku diagnoses the root cause from theme snapshot + chat + validation
// 2. If healable, Sonnet regenerates or repairs the theme
// 3. Updates incident with diagnosis + resolution
// ═══════════════════════════════════════════════════════════════════
async function diagnoseAndHeal(incidentId, ctx) {
  const diagnosisModel = 'claude-haiku-4-5-20251001';
  const startTime = Date.now();

  // Build diagnosis context
  const htmlPreview = ctx.themeSnapshot?.html
    ? ctx.themeSnapshot.html.substring(0, 3000) + (ctx.themeSnapshot.html.length > 3000 ? '\n...[truncated]' : '')
    : '[no HTML]';
  const cssPreview = ctx.themeSnapshot?.css
    ? ctx.themeSnapshot.css.substring(0, 2000) + (ctx.themeSnapshot.css.length > 2000 ? '\n...[truncated]' : '')
    : '[no CSS]';
  const chatPreview = ctx.chatSnapshot
    ? ctx.chatSnapshot.slice(-10).map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`).join('\n')
    : '[no chat history]';

  let diagnosis;
  let diagnosisTokens = { input: 0, output: 0 };

  try {
    // Build issue-specific context for smarter diagnosis
    const cssIssuesList = ctx.triggerData?.cssIssues || ctx.validationResults?.client?.cssIssues || [];
    const missingElements = ctx.triggerData?.missing || ctx.validationResults?.client?.missing || [];
    const issueContext = cssIssuesList.length > 0
      ? `\nClient-detected CSS visual issues: ${cssIssuesList.join(', ')}\n(e.g., "invisible_title" = title has opacity<0.1, "low_contrast_title" = text/bg contrast ratio <2:1, "low_contrast_rsvp_form" = RSVP form labels unreadable on dark background, "offscreen_rsvp" = RSVP section outside viewport, "tiny_details" = details section too small to see)`
      : '';
    const missingContext = missingElements.length > 0
      ? `\nMissing DOM elements: ${missingElements.join(', ')}`
      : '';

    const resp = await client.messages.create({
      model: diagnosisModel,
      max_tokens: 500,
      system: 'You are a CSS/HTML quality analyst for an invite design platform. Diagnose issues with generated invites. Return ONLY a JSON object, no markdown.',
      messages: [{ role: 'user', content: `Analyze this invite that triggered a "${ctx.triggerType}" quality incident.

Trigger details: ${JSON.stringify(ctx.triggerData || {})}
Validation issues: ${JSON.stringify(ctx.validationResults || {})}${issueContext}${missingContext}

Theme HTML (first 3KB):
${htmlPreview}

Theme CSS (first 2KB):
${cssPreview}

Recent chat:
${chatPreview}

Return JSON:
{
  "diagnosis": "Plain English explanation of what went wrong (2-3 sentences)",
  "rootCause": "css_missing" | "css_broken" | "css_invisible" | "css_offscreen" | "css_contrast" | "content_truncated" | "structure_broken" | "render_error" | "style_mismatch" | "user_dissatisfaction" | "unknown",
  "severity": "critical" | "major" | "minor",
  "canAutoHeal": true or false,
  "healStrategy": "regenerate" | "css_repair" | "content_inject" | null,
  "healInstructions": "Specific CSS fix instructions if healStrategy is css_repair (e.g., 'set .rsvp-slot opacity to 1, change title color to #1a1a1a for contrast'). For regenerate, describe what the new design must avoid. Null if canAutoHeal is false.",
  "cssPropertiesToFix": ["list of specific CSS property:value pairs to change, e.g. '.rsvp-slot { opacity: 1; }' — only for css_repair strategy"]
}` }]
    });

    diagnosisTokens = {
      input: resp.usage?.input_tokens || 0,
      output: resp.usage?.output_tokens || 0
    };

    const text = resp.content[0]?.text?.trim() || '';
    const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
    diagnosis = JSON.parse(cleaned);
  } catch (e) {
    console.error('[quality-monitor] Diagnosis AI call failed:', e.message);
    diagnosis = {
      diagnosis: 'AI diagnosis failed: ' + e.message,
      rootCause: 'unknown',
      severity: 'major',
      canAutoHeal: false,
      healStrategy: null,
      healInstructions: null
    };
  }

  // Save diagnosis to incident
  await supabase.from('quality_incidents').update({
    ai_diagnosis: diagnosis.diagnosis,
    ai_diagnosis_model: diagnosisModel,
    diagnosis_tokens: diagnosisTokens
  }).eq('id', incidentId);

  // Log diagnosis AI call to generation_log for cost tracking
  await supabase.from('generation_log').insert({
    event_id: ctx.eventId || null,
    user_id: ctx.userId || null,
    prompt: 'QM diagnosis (' + ctx.triggerType + '): ' + (diagnosis.rootCause || 'unknown'),
    model: diagnosisModel,
    input_tokens: diagnosisTokens.input,
    output_tokens: diagnosisTokens.output,
    latency_ms: Date.now() - startTime,
    status: 'success',
    is_tweak: true,
    event_type: ''
  });
  if (ctx.eventId) {
    const diagCostCents = calcCost(diagnosisModel, diagnosisTokens.input, diagnosisTokens.output);
    try { await supabase.rpc('increment_event_cost', { p_event_id: ctx.eventId, p_cost_cents: diagCostCents }); } catch(_) {}
  }

  console.log('[quality-monitor] Diagnosis complete:', {
    incidentId,
    rootCause: diagnosis.rootCause,
    severity: diagnosis.severity,
    canAutoHeal: diagnosis.canAutoHeal,
    latencyMs: Date.now() - startTime
  });

  // ── Check for recurring patterns → generate suggested rules ──
  try {
    await checkForPatterns(diagnosis.rootCause, incidentId);
  } catch (e) {
    console.warn('[quality-monitor] Pattern check failed:', e.message);
  }

  // ── AUTO-HEAL if possible ──
  if (diagnosis.canAutoHeal && diagnosis.healStrategy && ctx.eventId) {
    try {
      await attemptAutoHeal(incidentId, ctx, diagnosis);
    } catch (e) {
      console.error('[quality-monitor] Auto-heal failed:', e.message);
      await supabase.from('quality_incidents').update({
        resolution_type: 'escalated',
        resolution_data: { error: e.message, healStrategy: diagnosis.healStrategy }
      }).eq('id', incidentId);
    }
  }
}

async function attemptAutoHeal(incidentId, ctx, diagnosis) {
  // Use Sonnet for regeneration (more capable than Haiku for design)
  const healModel = 'claude-sonnet-4-6';
  const startTime = Date.now();

  // Fetch event details + custom fields for full regeneration context
  const { data: event } = await supabase
    .from('events')
    .select('title, event_date, event_type, location_name, location_address, dress_code')
    .eq('id', ctx.eventId)
    .single();

  if (!event) {
    throw new Error('Event not found: ' + ctx.eventId);
  }

  // Fetch custom RSVP fields for this event
  const { data: customFields } = await supabase
    .from('event_custom_fields')
    .select('field_key, label, field_type, is_required')
    .eq('event_id', ctx.eventId)
    .order('sort_order', { ascending: true });

  const eventContext = `Event: "${event.title}" (${event.event_type || 'event'})
Date: ${event.event_date || 'TBD'}
Location: ${event.location_name || 'TBD'}${event.location_address ? ' — ' + event.location_address : ''}
${event.dress_code ? 'Dress code: ' + event.dress_code : ''}
RSVP fields: Name (required), Email, Phone, RSVP Status (required)${customFields?.length ? ', ' + customFields.map(f => f.label + ' (' + f.field_type + (f.is_required ? ', required' : '') + ')').join(', ') : ''}`;

  // Platform contract for healed themes — the AI MUST follow these rules
  const HEAL_PLATFORM_RULES = `## PLATFORM CONTRACT — MANDATORY RULES

### PAGE STRUCTURE (4 required sections):
1. **THEMATIC HEADER** — Animated or illustrated SVG element specific to the event type
2. **HERO SECTION** — Large display headline with event title. Element MUST have data-field="title" attribute.
3. **DETAILS SLOT** — \`<div class="details-slot"></div>\` — MUST be COMPLETELY EMPTY. The platform injects event details (date, time, location, dress code) at runtime. NEVER put text, icons, or labels inside.
4. **RSVP SLOT** — \`<div class="rsvp-slot"></div>\` — MUST be COMPLETELY EMPTY. The platform injects RSVP form fields (name input, status dropdown, custom fields, submit button) at runtime. NEVER put buttons, links, "RSVP Now", or ANY content inside. NEVER create a click-to-reveal pattern.

### RSVP SLOT CSS — CRITICAL (platform injects form elements at runtime)
You MUST include ALL of these CSS rules styled to match your theme:
\`\`\`
.rsvp-slot { display: flex; flex-direction: column; width: 100%; color: [#FFFFFF on dark bg, #1A1A1A on light bg]; }
.rsvp-slot input, .rsvp-slot select, .rsvp-slot textarea { background: [rgba(255,255,255,0.15) on dark, rgba(0,0,0,0.05) on light]; border: 1px solid [theme-appropriate]; border-radius: [theme-appropriate]; padding: 12px 14px; font-size: 14px; color: [contrasting]; width: 100%; }
.rsvp-slot label { font-size: 13px; font-weight: 600; color: [contrasting]; margin-bottom: 4px; }
.rsvp-slot .rsvp-submit { width: 100%; min-height: 52px; background: [accent color]; color: [contrasting]; border: none; border-radius: [theme-appropriate]; font-size: 16px; font-weight: 600; cursor: pointer; }
.rsvp-slot .rsvp-form-group { margin-bottom: 14px; }
\`\`\`

### DETAILS SLOT CSS — CRITICAL (platform injects detail items at runtime)
\`\`\`
.details-slot { background: [theme-appropriate]; border-radius: [theme-appropriate]; padding: 20px; margin: 16px 0; }
.detail-item { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.detail-icon { font-size: 20px; }
.detail-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; color: [contrasting]; }
.detail-value { font-size: 15px; font-weight: 500; color: [contrasting]; }
\`\`\`

### TECHNICAL CONSTRAINTS
- Max-width: 393px (iPhone viewport), centered
- Min 48px padding-top (clears iPhone notch/Dynamic Island)
- Text: min 14px body, WCAG AA contrast (4.5:1 body, 3:1 headings)
- Generous padding: 20-24px sides
- CSS animations only, NO JavaScript
- No fixed positioning, no iframes
- 3-5 phone screen scrolls of height
- Source all fonts from Google Fonts (include @import in googleFontsImport)
- NEVER use Inter, Roboto, Open Sans, Lato, Arial, or system fonts

### TEXT CONTRAST — NEVER VIOLATE
- EVERY text must have sufficient contrast against its background
- On dark/colored backgrounds: use #FFFFFF or #FAFAFA for text
- On light backgrounds: use #1A1A1A or darker
- Button text MUST contrast against button background`;

  let healPrompt;
  if (diagnosis.healStrategy === 'css_repair') {
    // If we have specific CSS properties to fix, attempt a surgical patch first
    const hasSurgicalFix = Array.isArray(diagnosis.cssPropertiesToFix) && diagnosis.cssPropertiesToFix.length > 0;

    if (hasSurgicalFix) {
      // Try surgical CSS patch without AI — just apply the fixes directly
      try {
        let patchedCss = ctx.themeSnapshot?.css || '';
        let patchApplied = false;
        for (const fix of diagnosis.cssPropertiesToFix) {
          // Parse "selector { property: value; }" format
          const fixMatch = fix.match(/([^{]+)\{\s*([^}]+)\}/);
          if (fixMatch) {
            const selector = fixMatch[1].trim();
            const properties = fixMatch[2].trim();
            // Find the selector in CSS and append/replace properties
            const selRegex = new RegExp('(' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*') + '\\s*\\{)([^}]*)(\\})', 'i');
            if (selRegex.test(patchedCss)) {
              // Parse individual properties to replace
              const propPairs = properties.split(';').filter(p => p.trim());
              for (const prop of propPairs) {
                const [propName] = prop.split(':').map(s => s.trim());
                if (propName) {
                  const propReplace = new RegExp(propName.replace(/[-]/g, '[-]') + '\\s*:[^;]+;?', 'gi');
                  patchedCss = patchedCss.replace(selRegex, (match, open, rules, close) => {
                    if (propReplace.test(rules)) {
                      return open + rules.replace(propReplace, prop.trim() + ';') + close;
                    }
                    return open + rules + ' ' + prop.trim() + ';' + close;
                  });
                  patchApplied = true;
                }
              }
            }
          }
        }

        if (patchApplied) {
          console.log('[quality-monitor] Surgical CSS patch applied without AI call');
          const healedTheme = {
            html: ctx.themeSnapshot?.html || '',
            css: patchedCss,
            config: ctx.themeSnapshot?.config || {}
          };

          // Full validation before saving
          const structuralIssues = validateHealedStructure(healedTheme.html, healedTheme.css);
          if (structuralIssues.length === 0) {
            const { data: existingThemes } = await supabase
              .from('event_themes').select('version').eq('event_id', ctx.eventId)
              .order('version', { ascending: false }).limit(1);
            const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;
            await supabase.from('event_themes').update({ is_active: false })
              .eq('event_id', ctx.eventId).eq('is_active', true);
            const { data: newTheme, error: themeErr } = await supabase
              .from('event_themes').insert({
                event_id: ctx.eventId, version: nextVersion, is_active: true,
                html: healedTheme.html, css: healedTheme.css, config: healedTheme.config,
                model: 'css_patch_no_ai', input_tokens: 0, output_tokens: 0,
                latency_ms: Date.now() - startTime,
                prompt: 'Surgical CSS patch: ' + diagnosis.cssPropertiesToFix.join('; ')
              }).select('id').single();
            if (!themeErr && newTheme) {
              await supabase.from('quality_incidents').update({
                resolution_type: 'auto_healed',
                resolution_data: {
                  new_theme_id: newTheme.id, model_used: 'css_patch_no_ai',
                  action_taken: 'surgical_css_patch', cssFixes: diagnosis.cssPropertiesToFix,
                  latencyMs: Date.now() - startTime
                },
                resolved_at: new Date().toISOString()
              }).eq('id', incidentId);
              console.log('[quality-monitor] Surgical CSS patch saved:', newTheme.id);
              return; // Done — no AI needed
            }
          } else {
            console.warn('[quality-monitor] Surgical patch still has issues:', structuralIssues);
          }
        }
      } catch (e) {
        console.warn('[quality-monitor] Surgical CSS patch failed, falling back to AI:', e.message);
      }
    }

    healPrompt = `Fix the CSS for this invite. The diagnosis says: "${diagnosis.diagnosis}"
${hasSurgicalFix ? '\nSpecific CSS fixes needed:\n' + diagnosis.cssPropertiesToFix.join('\n') : ''}
${diagnosis.healInstructions ? '\nInstructions: ' + diagnosis.healInstructions : ''}

${eventContext}

Current CSS:
${ctx.themeSnapshot?.css || '[empty]'}

Current HTML structure (first 2KB):
${(ctx.themeSnapshot?.html || '').substring(0, 2000)}

IMPORTANT: The CSS MUST include styling for platform-injected elements:
- .rsvp-slot (flex column, full width, contrasting text color)
- .rsvp-slot input, .rsvp-slot select, .rsvp-slot textarea (styled form inputs)
- .rsvp-slot label (styled labels)
- .rsvp-slot .rsvp-submit (prominent submit button, min-height 52px)
- .rsvp-slot .rsvp-form-group (field groups with margin)
- .details-slot, .detail-item, .detail-icon, .detail-label, .detail-value (event details)

Return ONLY the fixed CSS (no JSON wrapper, no markdown fences). Ensure all selectors match HTML classes, no unclosed braces, and Google Fonts @import is included if needed.`;
  } else {
    // regenerate or content_inject — full theme regeneration with complete platform rules
    healPrompt = `The previous invite generation for this event was broken and needs a complete rebuild.

${eventContext}

Diagnosis of what went wrong: "${diagnosis.diagnosis}"
${diagnosis.healInstructions ? 'Fix instructions: ' + diagnosis.healInstructions : ''}

${HEAL_PLATFORM_RULES}

Generate a COMPLETE, beautiful, working invite following ALL platform rules above.

Return JSON with keys IN THIS ORDER (CSS first to avoid truncation):
{
  "theme_css": "complete CSS including .rsvp-slot, .details-slot, .detail-item, .detail-icon, .detail-label, .detail-value, .rsvp-slot input, .rsvp-slot select, .rsvp-slot label, .rsvp-slot .rsvp-submit, .rsvp-slot .rsvp-form-group styling",
  "theme_config": { "primaryColor": "#hex", "secondaryColor": "#hex", "accentColor": "#hex", "backgroundColor": "#hex", "textColor": "#hex", "fontHeadline": "Creative Google Font", "fontBody": "Readable Google Font", "mood": "one-word", "googleFontsImport": "@import url('...')" },
  "theme_html": "complete HTML with data-field=title element, empty <div class=details-slot></div>, empty <div class=rsvp-slot></div>"
}`;
  }

  const resp = await client.messages.create({
    model: healModel,
    max_tokens: 12000,
    system: `You are an expert HTML/CSS designer for mobile event invitations on the Ryvite platform.

CRITICAL PLATFORM RULES:
- .rsvp-slot and .details-slot must be COMPLETELY EMPTY divs — the platform injects form fields and event details at runtime
- NEVER put buttons, text, "RSVP Now", or ANY content inside .rsvp-slot or .details-slot
- You MUST style the platform-injected elements in CSS: .rsvp-slot input, .rsvp-slot select, .rsvp-slot label, .rsvp-slot .rsvp-submit, .rsvp-slot .rsvp-form-group, .detail-item, .detail-icon, .detail-label, .detail-value
- All text must have WCAG AA contrast against its background
- Max-width 393px, mobile-first design

Return ONLY what is requested — no commentary or explanation.`,
    messages: [{ role: 'user', content: healPrompt }]
  });

  const text = resp.content[0]?.text?.trim() || '';
  const healTokens = {
    input: resp.usage?.input_tokens || 0,
    output: resp.usage?.output_tokens || 0
  };

  let healedTheme;

  if (diagnosis.healStrategy === 'css_repair') {
    // CSS-only fix — apply to existing theme
    const fixedCss = text.replace(/^```(?:css)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
    healedTheme = {
      html: ctx.themeSnapshot?.html || '',
      css: fixedCss,
      config: ctx.themeSnapshot?.config || {}
    };
  } else {
    // Full regeneration — parse JSON response
    try {
      const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
      const parsed = JSON.parse(cleaned);
      healedTheme = {
        html: parsed.theme_html || parsed.html || '',
        css: parsed.theme_css || parsed.css || '',
        config: parsed.theme_config || parsed.config || {}
      };
    } catch (e) {
      throw new Error('Failed to parse healed theme: ' + e.message);
    }
  }

  // Comprehensive validation: structure + CSS visual + platform compliance
  const allIssues = validateHealedStructure(healedTheme.html, healedTheme.css);

  if (allIssues.length > 0) {
    console.warn('[quality-monitor] Healed theme still has issues:', allIssues);
    await supabase.from('quality_incidents').update({
      resolution_type: 'escalated',
      resolution_data: {
        healStrategy: diagnosis.healStrategy,
        model: healModel,
        healedButStillBroken: true,
        issues: allIssues
      }
    }).eq('id', incidentId);
    return;
  }

  // Save healed theme as new version
  const { data: existingThemes } = await supabase
    .from('event_themes')
    .select('version')
    .eq('event_id', ctx.eventId)
    .order('version', { ascending: false })
    .limit(1);

  const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;

  // Deactivate current active theme
  await supabase
    .from('event_themes')
    .update({ is_active: false })
    .eq('event_id', ctx.eventId)
    .eq('is_active', true);

  const { data: newTheme, error: themeErr } = await supabase
    .from('event_themes')
    .insert({
      event_id: ctx.eventId,
      version: nextVersion,
      is_active: true,
      html: healedTheme.html,
      css: healedTheme.css,
      config: healedTheme.config,
      model: healModel,
      input_tokens: healTokens.input,
      output_tokens: healTokens.output,
      latency_ms: Date.now() - startTime,
      prompt: 'Auto-heal: ' + (diagnosis.healStrategy || 'regenerate')
    })
    .select('id')
    .single();

  if (themeErr) {
    throw new Error('Failed to save healed theme: ' + themeErr.message);
  }

  // Log to generation_log
  await supabase.from('generation_log').insert({
    event_id: ctx.eventId,
    user_id: ctx.userId,
    prompt: 'Auto-heal (' + diagnosis.healStrategy + '): ' + (diagnosis.diagnosis || '').substring(0, 200),
    model: healModel,
    input_tokens: healTokens.input,
    output_tokens: healTokens.output,
    latency_ms: Date.now() - startTime,
    status: 'success',
    is_tweak: true,
    event_type: ''
  });

  // Increment event cost for the auto-heal generation
  const healCostCents = calcCost(healModel, healTokens.input, healTokens.output);
  if (ctx.eventId) {
    try { await supabase.rpc('increment_event_cost', { p_event_id: ctx.eventId, p_cost_cents: healCostCents }); } catch(_) {}
  }

  // Update incident as resolved
  await supabase.from('quality_incidents').update({
    resolution_type: 'auto_healed',
    resolution_data: {
      new_theme_id: newTheme.id,
      model_used: healModel,
      action_taken: diagnosis.healStrategy,
      tokens: healTokens,
      costCents: healCostCents,
      latencyMs: Date.now() - startTime
    },
    resolved_at: new Date().toISOString()
  }).eq('id', incidentId);

  console.log('[quality-monitor] Auto-heal complete:', {
    incidentId,
    newThemeId: newTheme.id,
    strategy: diagnosis.healStrategy,
    model: healModel,
    costCents: healCostCents,
    latencyMs: Date.now() - startTime
  });
}

// ═══════════════════════════════════════════════════════════════════
// COMPREHENSIVE HEALED THEME VALIDATION
// Checks structure, platform compliance, CSS completeness, and visual
// rendering to ensure healed themes are 100% functional invites.
// ═══════════════════════════════════════════════════════════════════
function validateHealedStructure(html, css) {
  const issues = [];
  if (!html) { issues.push('html_empty'); return issues; }
  if (!css) { issues.push('css_empty'); return issues; }

  // 1. Required structural elements exist
  const hasRsvpSlot = /class\s*=\s*["'][^"']*\brsvp-slot\b/.test(html);
  const hasDetailsSlot = /class\s*=\s*["'][^"']*\bdetails-slot\b/.test(html);
  const hasTitle = /data-field\s*=\s*["']title["']/.test(html);
  if (!hasRsvpSlot) issues.push('missing_rsvp_slot');
  if (!hasDetailsSlot) issues.push('missing_details_slot');
  if (!hasTitle) issues.push('missing_title_field');

  // 2. rsvp-slot must be EMPTY (no buttons, text, or child elements inside)
  // Match <div class="rsvp-slot">...</div> and check contents
  const rsvpSlotMatch = html.match(/<div[^>]*class\s*=\s*["'][^"']*\brsvp-slot\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (rsvpSlotMatch) {
    const rsvpContent = rsvpSlotMatch[1].trim();
    if (rsvpContent.length > 0) {
      issues.push('rsvp_slot_not_empty');
    }
  }

  // 3. details-slot must be EMPTY
  const detailsSlotMatch = html.match(/<div[^>]*class\s*=\s*["'][^"']*\bdetails-slot\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (detailsSlotMatch) {
    const detailsContent = detailsSlotMatch[1].trim();
    if (detailsContent.length > 0) {
      issues.push('details_slot_not_empty');
    }
  }

  // 4. CSS must include styling for platform-injected RSVP form elements
  const hasRsvpInputStyle = /\.rsvp-slot\s+(?:input|select)/i.test(css) || /\.rsvp-slot\s*(?:input|select)/i.test(css);
  const hasRsvpLabelStyle = /\.rsvp-slot\s+label/i.test(css) || /\.rsvp-slot\s*label/i.test(css);
  const hasRsvpSubmitStyle = /\.rsvp-(?:submit|slot\s+\.rsvp-submit|slot\s*\.rsvp-submit)/i.test(css);
  const hasRsvpFormGroupStyle = /\.rsvp-form-group/i.test(css);
  if (!hasRsvpInputStyle) issues.push('css_missing_rsvp_input_style');
  if (!hasRsvpLabelStyle) issues.push('css_missing_rsvp_label_style');
  if (!hasRsvpSubmitStyle) issues.push('css_missing_rsvp_submit_style');
  if (!hasRsvpFormGroupStyle) issues.push('css_missing_rsvp_form_group_style');

  // 5. CSS must include styling for platform-injected event details
  const hasDetailItemStyle = /\.detail-item/i.test(css);
  const hasDetailValueStyle = /\.detail-value/i.test(css);
  if (!hasDetailItemStyle) issues.push('css_missing_detail_item_style');
  if (!hasDetailValueStyle) issues.push('css_missing_detail_value_style');

  // 6. CSS visual rendering checks (from validateHealedCss)
  const cssVisualIssues = validateHealedCss(html, css);
  issues.push(...cssVisualIssues);

  // 7. Minimum CSS size — too short means broken/incomplete
  if (css.length < 200) issues.push('css_too_short');

  // 8. HTML structure — must have actual DOM structure
  if (!/<(?:div|section|main|header|article)/i.test(html)) issues.push('html_no_structure');

  return issues;
}

// ═══════════════════════════════════════════════════════════════════
// CSS VISUAL VALIDATION (subset of generate-theme.js validateThemeIntegrity)
// Checks healed output for the same visual rendering issues that the
// main generation pipeline detects. Prevents saving a "healed" theme
// that still has the same CSS bugs.
// ═══════════════════════════════════════════════════════════════════
function validateHealedCss(html, css) {
  const issues = [];
  if (!css || !html) return issues;

  // Invisible text — color matching background-color
  const ruleBlocks = css.match(/[^{}]+\{[^}]+\}/g) || [];
  for (const rule of ruleBlocks) {
    const colorMatch = rule.match(/(?:^|;\s*)color\s*:\s*([^;!}]+)/i);
    const bgMatch = rule.match(/background(?:-color)?\s*:\s*([^;!}]+)/i);
    if (colorMatch && bgMatch) {
      const c = colorMatch[1].trim().toLowerCase().replace(/\s+/g, '');
      const bg = bgMatch[1].trim().toLowerCase().replace(/\s+/g, '');
      if (c === bg && !bg.includes('gradient') && !bg.includes('url(')) {
        issues.push('css_invisible_text');
        break;
      }
    }
  }

  // Offscreen positioning
  if (/(?:left|right|top|margin-left|margin-right|transform)\s*:\s*-(?:9{3,}|[5-9]\d{3,})px/i.test(css)) {
    issues.push('css_offscreen_content');
  }
  if (/translate[XY]?\s*\(\s*-(?:9{3,}|[1-9]\d{3,})px/i.test(css)) {
    issues.push('css_offscreen_content');
  }

  // Key element issues — display:none, visibility:hidden, opacity:0, zero dimensions
  const keySelectors = ['rsvp-slot', 'details-slot', 'rsvp-button'];
  const cssNoMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  const cssNoMediaKf = cssNoMedia.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');

  for (const sel of keySelectors) {
    const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');

    // display:none
    const dnMatch = cssNoMedia.match(selRegex);
    if (dnMatch && /display\s*:\s*none/i.test(dnMatch[1])) {
      issues.push('css_display_none_' + sel);
    }

    // visibility:hidden
    const vhMatch = cssNoMediaKf.match(selRegex);
    if (vhMatch && /visibility\s*:\s*hidden/i.test(vhMatch[1])) {
      issues.push('css_visibility_hidden_' + sel);
    }

    // opacity:0 without restoring animation
    const opMatch = css.match(selRegex);
    if (opMatch && /opacity\s*:\s*0\s*[;!}]/i.test(opMatch[1])) {
      const animName = opMatch[1].match(/animation(?:-name)?\s*:\s*([\w-]+)/i);
      if (!animName) {
        issues.push('css_opacity_zero_' + sel);
      }
    }

    // Zero dimensions
    if (opMatch && /(?:width|height)\s*:\s*0(?:px)?\s*(?:[;!}]|$)/i.test(opMatch[1])) {
      issues.push('css_zero_dimension_' + sel);
    }
  }

  return issues;
}
