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
        client_meta: clientMeta,
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

  return res.status(400).json({ error: 'Unknown action: ' + action });
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
      ? `\nClient-detected CSS visual issues: ${cssIssuesList.join(', ')}\n(e.g., "invisible_title" = title has opacity<0.1, "low_contrast_title" = text/bg contrast ratio <2:1, "offscreen_rsvp" = RSVP section outside viewport, "tiny_details" = details section too small to see)`
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
          // Skip the AI heal entirely — use the patched CSS
          const healedTheme = {
            html: ctx.themeSnapshot?.html || '',
            css: patchedCss,
            config: ctx.themeSnapshot?.config || {}
          };

          // Validate and save (same flow as below)
          const hasRsvp = healedTheme.html.includes('rsvp-slot');
          const hasDetails = healedTheme.html.includes('details-slot');
          const hasTitle = healedTheme.html.includes('data-field="title"');
          if (hasRsvp && hasDetails && hasTitle) {
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
          }
        }
      } catch (e) {
        console.warn('[quality-monitor] Surgical CSS patch failed, falling back to AI:', e.message);
      }
    }

    healPrompt = `Fix the CSS for this invite. The diagnosis says: "${diagnosis.diagnosis}"
${hasSurgicalFix ? '\nSpecific CSS fixes needed:\n' + diagnosis.cssPropertiesToFix.join('\n') : ''}
${diagnosis.healInstructions ? '\nInstructions: ' + diagnosis.healInstructions : ''}

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

  // Validate the healed theme has required elements AND no CSS visual issues
  const hasRsvp = healedTheme.html.includes('rsvp-slot');
  const hasDetails = healedTheme.html.includes('details-slot');
  const hasTitle = healedTheme.html.includes('data-field="title"');
  const structuralOk = hasRsvp && hasDetails && hasTitle;

  // Run CSS visual checks on the healed output to prevent healing with same bugs
  const cssVisualIssues = validateHealedCss(healedTheme.html, healedTheme.css);

  if (!structuralOk || cssVisualIssues.length > 0) {
    console.warn('[quality-monitor] Healed theme still has issues.',
      'structural:', { rsvp: hasRsvp, details: hasDetails, title: hasTitle },
      'cssVisual:', cssVisualIssues);
    await supabase.from('quality_incidents').update({
      resolution_type: 'escalated',
      resolution_data: {
        healStrategy: diagnosis.healStrategy,
        model: healModel,
        healedButStillBroken: true,
        missing: { rsvp: !hasRsvp, details: !hasDetails, title: !hasTitle },
        cssVisualIssues
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
