import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || '';

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

    const { eventId, eventThemeId, triggerType, triggerData, themeSnapshot, validationResults } = req.body;
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
    const { data: incident, error: insertErr } = await supabase
      .from('quality_incidents')
      .insert({
        event_id: eventId,
        event_theme_id: eventThemeId || null,
        user_id: user.id,
        trigger_type: triggerType,
        trigger_data: triggerData || null,
        design_chat_snapshot: chatSnapshot,
        theme_snapshot: themeSnapshot || null,
        validation_results: validationResults || null,
        resolution_type: 'unresolved'
      })
      .select('id')
      .single();

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

  return res.status(400).json({ error: 'Unknown action: ' + action });
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
    const resp = await client.messages.create({
      model: diagnosisModel,
      max_tokens: 500,
      system: 'You are a CSS/HTML quality analyst for an invite design platform. Diagnose issues with generated invites. Return ONLY a JSON object, no markdown.',
      messages: [{ role: 'user', content: `Analyze this invite that triggered a "${ctx.triggerType}" quality incident.

Trigger details: ${JSON.stringify(ctx.triggerData || {})}
Validation issues: ${JSON.stringify(ctx.validationResults || {})}

Theme HTML (first 3KB):
${htmlPreview}

Theme CSS (first 2KB):
${cssPreview}

Recent chat:
${chatPreview}

Return JSON:
{
  "diagnosis": "Plain English explanation of what went wrong (2-3 sentences)",
  "rootCause": "css_missing" | "css_broken" | "content_truncated" | "structure_broken" | "render_error" | "style_mismatch" | "user_dissatisfaction" | "unknown",
  "severity": "critical" | "major" | "minor",
  "canAutoHeal": true or false,
  "healStrategy": "regenerate" | "css_repair" | "content_inject" | null,
  "healInstructions": "Specific instructions for the healing AI if canAutoHeal is true, null otherwise"
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

  console.log('[quality-monitor] Diagnosis complete:', {
    incidentId,
    rootCause: diagnosis.rootCause,
    severity: diagnosis.severity,
    canAutoHeal: diagnosis.canAutoHeal,
    latencyMs: Date.now() - startTime
  });

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

  // Fetch event details for regeneration context
  const { data: event } = await supabase
    .from('events')
    .select('title, event_date, event_type, location_name, location_address, dress_code')
    .eq('id', ctx.eventId)
    .single();

  if (!event) {
    throw new Error('Event not found: ' + ctx.eventId);
  }

  let healPrompt;
  if (diagnosis.healStrategy === 'css_repair') {
    healPrompt = `Fix the CSS for this invite. The diagnosis says: "${diagnosis.diagnosis}"

Current CSS:
${ctx.themeSnapshot?.css || '[empty]'}

Current HTML structure (first 2KB):
${(ctx.themeSnapshot?.html || '').substring(0, 2000)}

Return ONLY the fixed CSS (no JSON wrapper, no markdown fences). Ensure all selectors match HTML classes, no unclosed braces, and Google Fonts @import is included if needed.`;
  } else {
    // regenerate or content_inject — full theme regeneration
    healPrompt = `The previous invite generation for "${event.title}" (${event.event_type || 'event'}) was broken. Diagnosis: "${diagnosis.diagnosis}"
${diagnosis.healInstructions ? '\nSpecific fix instructions: ' + diagnosis.healInstructions : ''}

Generate a COMPLETE, working invite with ALL required elements:
1. A title element with data-field="title" containing "${event.title}"
2. A <div class="details-slot"></div> where event details will be injected
3. A <div class="rsvp-slot"><button class="rsvp-button">RSVP Now!</button></div>
4. Full CSS with proper selectors, colors, fonts, and layout
5. Mobile-friendly (max-width: 393px)

Return JSON:
{
  "theme_html": "complete HTML",
  "theme_css": "complete CSS",
  "theme_config": { "primaryColor": "...", "backgroundColor": "...", "textColor": "...", "fontBody": "...", "fontHeadline": "...", "googleFontsImport": "@import url('...')" }
}`;
  }

  const resp = await client.messages.create({
    model: healModel,
    max_tokens: 8000,
    system: 'You are an expert HTML/CSS designer for mobile event invitations. Generate beautiful, complete, working invite designs. Return ONLY what is requested — no commentary.',
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

  // Validate the healed theme has required elements
  const hasRsvp = healedTheme.html.includes('rsvp-slot');
  const hasDetails = healedTheme.html.includes('details-slot');
  const hasTitle = healedTheme.html.includes('data-field="title"');

  if (!hasRsvp || !hasDetails || !hasTitle) {
    console.warn('[quality-monitor] Healed theme still missing elements. rsvp:', hasRsvp, 'details:', hasDetails, 'title:', hasTitle);
    // Don't save a broken heal — mark as escalated
    await supabase.from('quality_incidents').update({
      resolution_type: 'escalated',
      resolution_data: {
        healStrategy: diagnosis.healStrategy,
        model: healModel,
        healedButStillBroken: true,
        missing: { rsvp: !hasRsvp, details: !hasDetails, title: !hasTitle }
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
  }).catch(e => console.error('[quality-monitor] Generation log failed:', e.message));

  // Update incident as resolved
  const healCostCents = calcCost(healModel, healTokens.input, healTokens.output);
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
