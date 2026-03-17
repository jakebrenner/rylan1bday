import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Allow up to 120s for diagnosis + fix
export const config = { maxDuration: 120 };

// AI model pricing per 1M tokens — must match billing.js, generate-theme.js, ratings.js, admin.js
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

// Model escalation chain
const ESCALATION_MODELS = [
  'claude-haiku-4-5-20251001',  // Tier 1: fast + cheap for simple CSS fixes
  'claude-sonnet-4-6',          // Tier 2: complex layout/design understanding
];

const DIAGNOSIS_MODEL = 'claude-haiku-4-5-20251001';

// ═══════════════════════════════════════════════════════════════════
// Theme validation — duplicated from generate-theme.js (Vercel constraint)
// ═══════════════════════════════════════════════════════════════════
function validateThemeIntegrity(theme) {
  const issues = [];
  const html = theme.theme_html || '';
  const css = theme.theme_css || '';

  if (!css.trim()) {
    issues.push('css_empty');
  } else if (css.trim().length < 100) {
    issues.push('css_too_short');
  } else {
    const hasSelectorAndRule = /[.#\w@:][^{]*\{[^}]+\}/s.test(css);
    if (!hasSelectorAndRule) issues.push('css_no_rules');
  }

  if (!html.trim()) {
    issues.push('html_empty');
  } else {
    const hasStructure = /<(div|section|main|header|article)\b/i.test(html);
    if (!hasStructure) issues.push('html_no_structure');
  }

  if (css && html) {
    const cssClasses = [...new Set((css.match(/\.([a-zA-Z][\w-]*)/g) || []).map(c => c.substring(1)))];
    const htmlContent = html.toLowerCase();
    if (cssClasses.length > 0) {
      const matchCount = cssClasses.filter(c => htmlContent.includes(c.toLowerCase())).length;
      const matchRatio = matchCount / cssClasses.length;
      if (matchRatio < 0.2) issues.push('css_html_mismatch');
    }
  }

  if (css) {
    const opens = (css.match(/\{/g) || []).length;
    const closes = (css.match(/\}/g) || []).length;
    if (opens !== closes) issues.push('css_unclosed_braces');
  }

  if (css.includes('```') || html.includes('```')) issues.push('markdown_fences');
  if (html.startsWith('"') || html.startsWith('{')) issues.push('html_json_leak');
  if (css && /@import\s+url\(/i.test(css)) issues.push('css_stray_import');

  if (css) {
    const keyframeBlocks = css.match(/@keyframes\s+[\w-]+\s*\{/g);
    if (keyframeBlocks) {
      keyframeBlocks.forEach(kf => {
        const startIdx = css.indexOf(kf);
        let depth = 0, i = startIdx;
        for (; i < css.length; i++) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) issues.push('css_malformed_keyframes');
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

function repairTheme(theme, issues) {
  if (issues.includes('markdown_fences')) {
    theme.theme_css = (theme.theme_css || '').replace(/```(?:css)?\s*/g, '').replace(/```\s*/g, '');
    theme.theme_html = (theme.theme_html || '').replace(/```(?:html)?\s*/g, '').replace(/```\s*/g, '');
  }
  if (issues.includes('html_json_leak')) {
    let h = theme.theme_html;
    h = h.replace(/^["']?\s*/, '');
    h = h.replace(/["']\s*$/, '');
    theme.theme_html = h;
  }
  if (issues.includes('css_unclosed_braces')) {
    const opens = (theme.theme_css.match(/\{/g) || []).length;
    const closes = (theme.theme_css.match(/\}/g) || []).length;
    if (opens > closes) theme.theme_css += '}'.repeat(opens - closes);
  }
  if (issues.includes('css_empty') || issues.includes('css_too_short')) {
    const styleBlocks = (theme.theme_html || '').match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleBlocks) {
      const extracted = styleBlocks.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
      if (extracted.trim().length > (theme.theme_css || '').trim().length) {
        theme.theme_css = extracted;
        theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      }
    }
  }
  if (issues.includes('css_stray_import')) {
    const importMatches = (theme.theme_css || '').match(/@import\s+url\(['"]?([^'"\)]+)['"]?\);?\s*/g);
    if (importMatches) {
      const fontUrl = importMatches[0].match(/url\(['"]?([^'"\)]+)['"]?\)/);
      if (fontUrl && !theme.theme_config?.googleFontsImport) {
        if (!theme.theme_config) theme.theme_config = {};
        theme.theme_config.googleFontsImport = "@import url('" + fontUrl[1] + "');";
      }
      theme.theme_css = theme.theme_css.replace(/@import\s+url\([^)]+\);?\s*/g, '');
    }
  }
  if (issues.includes('css_malformed_keyframes')) {
    theme.theme_css = theme.theme_css.replace(/@keyframes\s+[\w-]+\s*\{[^}]*$/gm, '');
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { healLogId, eventThemeId, eventId, triggerType, triggerDetails, feedback, sync } = req.body;

  if (!eventThemeId) {
    return res.status(400).json({ success: false, error: 'eventThemeId required' });
  }

  const startTime = Date.now();

  try {
    // 1. Load the theme
    const { data: theme, error: themeErr } = await supabase
      .from('event_themes')
      .select('id, event_id, html, css, config, model, is_active, admin_rating, auto_healed')
      .eq('id', eventThemeId)
      .single();

    if (themeErr || !theme) {
      await updateHealLog(healLogId, 'failed', { error_message: 'Theme not found' });
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }

    // Skip if admin rated it highly (likely subjective preference, not a bug)
    if (theme.admin_rating && theme.admin_rating >= 4) {
      await updateHealLog(healLogId, 'failed', { error_message: 'Theme has high admin rating — likely subjective' });
      return res.status(200).json({ success: false, reason: 'high_admin_rating' });
    }

    // 2. Load error reports for context
    const { data: errorReports } = await supabase
      .from('theme_error_reports')
      .select('error_type, error_details, severity, device_info, page_context')
      .eq('event_theme_id', eventThemeId)
      .order('created_at', { ascending: false })
      .limit(20);

    // 3. Load any user ratings/feedback for context
    const { data: ratings } = await supabase
      .from('invite_ratings')
      .select('rating, feedback, rater_type')
      .eq('event_theme_id', eventThemeId)
      .order('created_at', { ascending: false })
      .limit(5);

    // Normalize theme to validation format
    const themeObj = {
      theme_html: theme.html,
      theme_css: theme.css,
      theme_config: theme.config || {}
    };

    // 4. Try rule-based repair first (free, instant)
    const { valid: wasValid, issues } = validateThemeIntegrity(themeObj);
    if (!wasValid && issues.length > 0) {
      repairTheme(themeObj, issues);
      const { valid: nowValid } = validateThemeIntegrity(themeObj);
      if (nowValid) {
        // Rule-based fix worked!
        const result = await applyFix(theme, themeObj, healLogId, 'rule_based', issues.join(', '), null, 0, 0, startTime);
        return res.status(200).json(result);
      }
    }

    // 5. AI-powered diagnosis + fix with escalation
    const errorContext = buildErrorContext(errorReports, ratings, feedback);

    for (let i = 0; i < ESCALATION_MODELS.length; i++) {
      const model = ESCALATION_MODELS[i];
      const fixTier = i === 0 ? 'haiku' : 'sonnet';

      console.log(`[self-heal] Attempting ${fixTier} fix with ${model} for theme ${eventThemeId}`);

      // Update heal log to in_progress
      if (healLogId) {
        await supabase.from('self_heal_log')
          .update({ status: 'in_progress', fix_tier: fixTier, model_used: model })
          .eq('id', healLogId);
      }

      try {
        const fixResult = await attemptAIFix(model, themeObj, errorContext, fixTier);

        if (fixResult.success) {
          const result = await applyFix(
            theme, fixResult.fixedTheme, healLogId, fixTier,
            fixResult.diagnosis, model,
            fixResult.inputTokens, fixResult.outputTokens, startTime
          );
          return res.status(200).json(result);
        }

        // Fix didn't pass validation — escalate to next model
        console.log(`[self-heal] ${fixTier} fix failed validation, escalating...`);
      } catch (aiErr) {
        console.error(`[self-heal] ${fixTier} fix error:`, aiErr.message);
      }
    }

    // All models failed — escalate to admin
    await updateHealLog(healLogId, 'escalated', {
      error_message: 'All automatic fix attempts failed',
      latency_ms: Date.now() - startTime
    });

    return res.status(200).json({
      success: false,
      status: 'escalated',
      message: 'Issue has been escalated for manual review'
    });

  } catch (err) {
    console.error('[self-heal] Fatal error:', err);
    await updateHealLog(healLogId, 'failed', { error_message: err.message });
    return res.status(500).json({ success: false, error: 'Self-heal failed' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI FIX ATTEMPT
// ═══════════════════════════════════════════════════════════════════
async function attemptAIFix(model, themeObj, errorContext, fixTier) {
  const systemPrompt = `You are a CSS/HTML repair specialist for a mobile-first invitation platform called Ryvite.
Your job is to fix rendering issues in AI-generated invite themes while preserving the original design intent.

RULES:
1. Fix ONLY the identified issues. Do NOT redesign, restyle, or change the creative direction.
2. The .rsvp-slot element MUST exist in the HTML — it's where the RSVP form gets injected.
3. The .details-slot element should exist for event details injection.
4. All CSS must be valid — no unclosed braces, no stray @imports after rules.
5. Google Fonts @import must go in config.googleFontsImport, NOT in the CSS.
6. Designs must work on mobile (393px width). No horizontal overflow.
7. All animations must use only CSS (no JavaScript). @keyframes must have properly nested braces.
8. Keep all existing SVG illustrations, animations, and decorative elements intact.
9. Do NOT add or remove content — only fix structural/rendering issues.

RESPONSE FORMAT — you MUST respond with valid JSON only:
{
  "diagnosis": "Brief description of what was wrong",
  "changes_made": "Brief description of fixes applied",
  "theme_html": "...the complete fixed HTML...",
  "theme_css": "...the complete fixed CSS...",
  "config": { "googleFontsImport": "...", "primaryColor": "...", "secondaryColor": "...", "accentColor": "..." }
}`;

  const userPrompt = `Fix the following invite theme. Here are the issues detected:

${errorContext}

CURRENT THEME HTML:
\`\`\`html
${themeObj.theme_html}
\`\`\`

CURRENT THEME CSS:
\`\`\`css
${themeObj.theme_css}
\`\`\`

CURRENT CONFIG:
${JSON.stringify(themeObj.theme_config || {}, null, 2)}

Return the fixed theme as JSON. Fix ONLY the issues listed above — keep everything else identical.`;

  const response = await client.messages.create({
    model,
    max_tokens: fixTier === 'haiku' ? 8000 : 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const responseText = response.content?.[0]?.text || '';

  // Parse the JSON response
  let parsed;
  try {
    // Strip markdown fences if present
    let cleaned = responseText.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }
    if (!parsed) {
      return { success: false, inputTokens, outputTokens };
    }
  }

  if (!parsed.theme_html || !parsed.theme_css) {
    return { success: false, inputTokens, outputTokens };
  }

  // Validate the fix
  const fixedTheme = {
    theme_html: parsed.theme_html,
    theme_css: parsed.theme_css,
    theme_config: parsed.config || themeObj.theme_config || {}
  };

  const { valid, issues } = validateThemeIntegrity(fixedTheme);

  // If the fix has issues, try repairing those too
  if (!valid) {
    repairTheme(fixedTheme, issues);
    const { valid: nowValid } = validateThemeIntegrity(fixedTheme);
    if (!nowValid) {
      return { success: false, inputTokens, outputTokens };
    }
  }

  return {
    success: true,
    fixedTheme,
    diagnosis: parsed.diagnosis || parsed.changes_made || 'AI fix applied',
    inputTokens,
    outputTokens
  };
}

// ═══════════════════════════════════════════════════════════════════
// APPLY FIX — save as new active theme version
// ═══════════════════════════════════════════════════════════════════
async function applyFix(originalTheme, fixedTheme, healLogId, fixTier, diagnosis, model, inputTokens, outputTokens, startTime) {
  const latencyMs = Date.now() - startTime;
  const costCents = model ? calcCostCents(model, inputTokens, outputTokens) : 0;
  const eventId = originalTheme.event_id;

  // Get current max version for this event
  const { data: versions } = await supabase
    .from('event_themes')
    .select('version')
    .eq('event_id', eventId)
    .order('version', { ascending: false })
    .limit(1);

  const newVersion = (versions?.[0]?.version || 0) + 1;

  // Deactivate old theme
  await supabase
    .from('event_themes')
    .update({ is_active: false })
    .eq('event_id', eventId)
    .eq('is_active', true);

  // Insert new healed theme
  const { data: newTheme, error: insertErr } = await supabase
    .from('event_themes')
    .insert({
      event_id: eventId,
      html: fixedTheme.theme_html,
      css: fixedTheme.theme_css,
      config: fixedTheme.theme_config || originalTheme.config || {},
      model: model || originalTheme.model,
      version: newVersion,
      is_active: true,
      auto_healed: true,
      healed_from_id: originalTheme.id
    })
    .select('id, html, css, config')
    .single();

  if (insertErr) {
    console.error('[self-heal] Failed to save healed theme:', insertErr);
    // Re-activate old theme
    await supabase.from('event_themes').update({ is_active: true }).eq('id', originalTheme.id);
    await updateHealLog(healLogId, 'failed', { error_message: 'Failed to save: ' + insertErr.message });
    return { success: false, error: 'Failed to save healed theme' };
  }

  // Update heal log
  await updateHealLog(healLogId, 'success', {
    new_theme_id: newTheme.id,
    fix_tier: fixTier,
    diagnosis,
    fix_description: diagnosis,
    model_used: model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: latencyMs,
    cost_cents: costCents
  });

  // Update error reports to mark as healed
  await supabase
    .from('theme_error_reports')
    .update({
      auto_heal_status: 'healed',
      auto_heal_result: { model_used: model || 'rule_based', fix_tier: fixTier, new_theme_id: newTheme.id }
    })
    .eq('event_theme_id', originalTheme.id)
    .is('auto_heal_status', null);

  return {
    success: true,
    status: 'healed',
    fixTier,
    diagnosis,
    newThemeId: newTheme.id,
    newHtml: newTheme.html,
    newCss: newTheme.css,
    newConfig: newTheme.config,
    latencyMs,
    costCents
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function buildErrorContext(errorReports, ratings, additionalFeedback) {
  let context = '';

  if (errorReports?.length > 0) {
    context += 'CLIENT-SIDE ERROR REPORTS:\n';
    const grouped = {};
    errorReports.forEach(er => {
      if (!grouped[er.error_type]) grouped[er.error_type] = [];
      grouped[er.error_type].push(er);
    });
    Object.entries(grouped).forEach(([type, reports]) => {
      context += `- ${type} (${reports.length}x): ${JSON.stringify(reports[0].error_details)}\n`;
      if (reports[0].device_info) {
        context += `  Device: ${JSON.stringify(reports[0].device_info)}\n`;
      }
    });
  }

  if (ratings?.length > 0) {
    context += '\nUSER RATINGS:\n';
    ratings.forEach(r => {
      context += `- ${r.rating}/5 stars${r.feedback ? ': "' + r.feedback + '"' : ''} (${r.rater_type})\n`;
    });
  }

  if (additionalFeedback) {
    context += `\nADDITIONAL FEEDBACK: "${additionalFeedback}"\n`;
  }

  if (!context) {
    context = 'No specific error reports available. Please review the HTML/CSS for common issues:\n'
      + '- Missing .rsvp-slot element\n'
      + '- Layout overflow on mobile (393px)\n'
      + '- Broken CSS (unclosed braces, stray @imports)\n'
      + '- Missing .details-slot element\n';
  }

  return context;
}

async function updateHealLog(healLogId, status, data = {}) {
  if (!healLogId) return;
  try {
    await supabase.from('self_heal_log')
      .update({ status, ...data })
      .eq('id', healLogId);
  } catch (err) {
    console.error('[self-heal] Failed to update heal log:', err);
  }
}

function calcCostCents(model, inputTokens, outputTokens) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return Math.round(rawCost * 100);
}
