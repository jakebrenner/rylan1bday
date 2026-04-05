import { createClient } from '@supabase/supabase-js';
import { reportApiError } from './lib/error-reporter.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Valid event types (from DESIGN_DNA in generate-theme.js) ──
const VALID_EVENT_TYPES = [
  'kidsBirthday', 'adultBirthday', 'babyShower', 'engagement', 'wedding',
  'graduation', 'holiday', 'dinnerParty', 'retirement', 'anniversary',
  'sports', 'bridalShower', 'corporate', 'other'
];

// ── Rate limiting (in-memory, resets on cold start — acceptable for serverless) ──
const rateLimitMap = new Map();
const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count <= RATE_LIMIT;
}

// ── Auto-repair (mirrors generate-theme.js repairTheme logic) ──
function repairTemplate(html, css) {
  const repairs = [];

  // Strip markdown fences
  if (css.includes('```') || html.includes('```')) {
    css = css.replace(/```(?:css)?\s*/g, '').replace(/```\s*/g, '');
    html = html.replace(/```(?:html)?\s*/g, '').replace(/```\s*/g, '');
    repairs.push('stripped_markdown_fences');
  }

  // Close unclosed CSS braces
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  if (opens > closes) {
    css += '}'.repeat(opens - closes);
    repairs.push('closed_css_braces');
  }

  // Inject missing data-field="title" on first h1
  if (!/data-field\s*=\s*["']title["']/.test(html)) {
    const headingMatch = html.match(/<(h[12])\b([^>]*)>/i);
    if (headingMatch) {
      const tag = headingMatch[0];
      if (!tag.includes('data-field')) {
        html = html.replace(tag, tag.replace('>', ' data-field="title">'));
        repairs.push('injected_title_field');
      }
    }
  }

  // Inject missing .rsvp-slot
  if (!/class\s*=\s*["'][^"']*\brsvp-slot\b/.test(html)) {
    const bodyClose = html.lastIndexOf('</body>');
    if (bodyClose > 0) {
      html = html.slice(0, bodyClose) + '<div class="rsvp-slot"></div>\n' + html.slice(bodyClose);
    } else {
      html = html + '\n<div class="rsvp-slot"></div>';
    }
    repairs.push('injected_rsvp_slot');
  }

  // Inject missing .details-slot before .rsvp-slot
  if (!/class\s*=\s*["'][^"']*\bdetails-slot\b/.test(html)) {
    const rsvpIdx = html.indexOf('rsvp-slot');
    if (rsvpIdx > 0) {
      const beforeRsvp = html.lastIndexOf('<', rsvpIdx);
      if (beforeRsvp >= 0) {
        html = html.slice(0, beforeRsvp) + '<div class="details-slot"></div>\n' + html.slice(beforeRsvp);
        repairs.push('injected_details_slot');
      }
    } else {
      const bodyClose = html.lastIndexOf('</body>');
      if (bodyClose > 0) {
        html = html.slice(0, bodyClose) + '<div class="details-slot"></div>\n' + html.slice(bodyClose);
      } else {
        html = html + '\n<div class="details-slot"></div>';
      }
      repairs.push('injected_details_slot');
    }
  }

  // Strip hallucinated <img> tags (non-Supabase, non-data: URLs)
  let strippedImgs = 0;
  html = html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, function(match, src) {
    if (src.includes('/storage/v1/object/') || src.startsWith('data:')) return match;
    strippedImgs++;
    return '';
  });
  if (strippedImgs > 0) repairs.push('stripped_' + strippedImgs + '_hallucinated_images');

  return { html, css, repairs };
}

// ── Validation (mirrors generate-theme.js validateThemeIntegrity) ──
function validateTemplate(html, css, name, eventType, metadata) {
  const errors = [];

  // Required fields
  if (!name || !name.trim()) errors.push('missing_name');
  if (!eventType) errors.push('missing_event_type');
  else if (!VALID_EVENT_TYPES.includes(eventType)) errors.push('invalid_event_type: ' + eventType);
  if (!html || !html.trim()) errors.push('missing_html');
  if (!css || !css.trim()) errors.push('missing_css');

  // Short-circuit if no content to validate
  if (!html || !css) return { valid: false, errors };

  // HTML minimum length
  if (html.trim().length < 2000) errors.push('html_too_short (min 2000 chars, got ' + html.trim().length + ')');

  // CSS minimum length
  if (css.trim().length < 200) errors.push('css_too_short (min 200 chars, got ' + css.trim().length + ')');

  // CSS brace integrity
  const cssOpens = (css.match(/\{/g) || []).length;
  const cssCloses = (css.match(/\}/g) || []).length;
  if (cssOpens !== cssCloses) errors.push('css_mismatched_braces (opens: ' + cssOpens + ', closes: ' + cssCloses + ')');

  // Platform elements
  if (!/class\s*=\s*["'][^"']*\brsvp-slot\b/.test(html)) errors.push('missing_rsvp_slot');
  if (!/class\s*=\s*["'][^"']*\bdetails-slot\b/.test(html)) errors.push('missing_details_slot');
  if (!/data-field\s*=\s*["']title["']/.test(html)) errors.push('missing_title_field');

  // No <script> tags
  if (/<script\b/i.test(html)) errors.push('contains_script_tag');

  // No inline event handlers
  if (/\bon(click|load|error|mouseover|mouseout|focus|blur|submit|change|input|keydown|keyup|keypress)\s*=/i.test(html)) {
    errors.push('contains_inline_event_handler');
  }

  // No external image URLs (only supabase storage and data: URIs)
  const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const img of imgMatches) {
    const srcMatch = img.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
      const src = srcMatch[1];
      if (!src.includes('/storage/v1/object/') && !src.startsWith('data:')) {
        errors.push('external_image_url');
        break;
      }
    }
  }

  // No markdown fences
  if (css.includes('```') || html.includes('```')) errors.push('contains_markdown_fences');

  // Google Fonts only for @import
  const importMatches = css.match(/@import\s+url\(['"]?([^'"\)]+)['"]?\)/g) || [];
  for (const imp of importMatches) {
    if (!imp.includes('fonts.googleapis.com')) {
      errors.push('non_google_font_import');
      break;
    }
  }
  // Also check HTML for @import
  const htmlImports = html.match(/@import\s+url\(['"]?([^'"\)]+)['"]?\)/g) || [];
  for (const imp of htmlImports) {
    if (!imp.includes('fonts.googleapis.com')) {
      errors.push('non_google_font_import_in_html');
      break;
    }
  }

  // Metadata array validation
  if (metadata) {
    if (metadata.colors !== undefined && !Array.isArray(metadata.colors)) errors.push('metadata.colors_must_be_array');
    if (metadata.fonts !== undefined && !Array.isArray(metadata.fonts)) errors.push('metadata.fonts_must_be_array');
    if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) errors.push('metadata.tags_must_be_array');
  }

  return { valid: errors.length === 0, errors };
}

// ── GitHub push (fire-and-forget) ──
async function pushToGithub(template, styleId) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return;
  try {
    const date = new Date().toISOString().split('T')[0];
    const slug = template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = `templates/imported/${date}/${template.event_type}/${slug}.json`;
    const content = Buffer.from(JSON.stringify({ ...template, style_library_id: styleId }, null, 2)).toString('base64');
    await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Import template: ${template.name}`, content })
    });
  } catch { /* silent — non-critical */ }
}

// ── Process a single template ──
async function processTemplate(template, batchId) {
  const { name, event_type, html: rawHtml, css: rawCss, metadata } = template || {};

  // Auto-repair first
  const repaired = repairTemplate(rawHtml || '', rawCss || '');
  const html = repaired.html;
  const css = repaired.css;
  const repairs = repaired.repairs;

  // Validate
  const validation = validateTemplate(html, css, name, event_type, metadata);

  if (!validation.valid) {
    // Log failure
    try {
      await supabase.from('template_import_log').insert({
        batch_id: batchId || null,
        template_name: name || 'unknown',
        event_type: event_type || null,
        status: 'validation_failed',
        validation_errors: validation.errors,
        source: 'pipeline'
      });
    } catch { /* non-critical */ }

    return {
      name: name || 'unknown',
      status: 'validation_failed',
      errors: validation.errors,
      repairs
    };
  }

  // Build combined HTML (style_library stores full HTML with embedded <style>)
  const combinedHtml = '<style>\n' + css + '\n</style>\n' + html;

  // Generate ID (matching admin.js saveStyleItem pattern)
  const id = 'style_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // Build row
  const row = {
    id,
    name,
    description: (metadata && metadata.mood) || '',
    html: combinedHtml,
    tags: (metadata && Array.isArray(metadata.tags)) ? metadata.tags : [],
    event_types: [event_type],
    design_notes: '',
    added_by: 'pipeline',
    status: 'pending_review',
    source: 'pipeline',
    admin_rating: 3,
    imported_at: new Date().toISOString(),
    metadata: metadata || {},
    design_group_id: id
  };

  // Insert into style_library
  let { error } = await supabase.from('style_library').insert(row);
  // Retry without newer columns if they don't exist yet
  if (error && (error.message?.includes('design_group_id') || error.message?.includes('status') || error.message?.includes('source') || error.message?.includes('metadata') || error.message?.includes('imported_at'))) {
    delete row.design_group_id;
    delete row.status;
    delete row.source;
    delete row.metadata;
    delete row.imported_at;
    ({ error } = await supabase.from('style_library').insert(row));
  }

  if (error) {
    // Log insert failure
    try {
      await supabase.from('template_import_log').insert({
        batch_id: batchId || null,
        template_name: name,
        event_type: event_type,
        status: 'insert_failed',
        validation_errors: [error.message],
        source: 'pipeline'
      });
    } catch { /* non-critical */ }

    return {
      name,
      status: 'insert_failed',
      errors: [error.message],
      repairs
    };
  }

  // Log success
  try {
    await supabase.from('template_import_log').insert({
      batch_id: batchId || null,
      template_name: name,
      event_type: event_type,
      status: 'success',
      style_library_id: id,
      source: 'pipeline'
    });
  } catch { /* non-critical */ }

  // Fire-and-forget GitHub push
  pushToGithub(template, id).catch(() => {});

  return {
    name,
    status: 'success',
    id,
    repairs
  };
}

// ── Main handler ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Auth: API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.TEMPLATE_IMPORT_API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }

    // Rate limiting
    if (!checkRateLimit(apiKey)) {
      return res.status(429).json({ error: 'Rate limit exceeded (50 requests/hour)' });
    }

    const action = req.query.action || req.body?.action;

    // ── Single import ──
    if (action === 'import') {
      const template = req.body.template || req.body;
      const result = await processTemplate(template, null);

      if (result.status === 'success') {
        return res.status(200).json({
          success: true,
          id: result.id,
          repairs: result.repairs
        });
      } else {
        return res.status(422).json({
          success: false,
          errors: result.errors,
          repairs: result.repairs
        });
      }
    }

    // ── Batch import ──
    if (action === 'batch-import') {
      const templates = req.body.templates;
      if (!Array.isArray(templates) || templates.length === 0) {
        return res.status(400).json({ error: 'templates array is required' });
      }
      if (templates.length > 20) {
        return res.status(400).json({ error: 'Max 20 templates per batch' });
      }

      const batchId = 'batch_' + Date.now();
      const details = [];
      let imported = 0;
      let failed = 0;

      for (const template of templates) {
        const result = await processTemplate(template, batchId);
        details.push(result);
        if (result.status === 'success') imported++;
        else failed++;
      }

      return res.status(200).json({
        success: true,
        batch_id: batchId,
        imported,
        failed,
        total: templates.length,
        details
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use "import" or "batch-import".' });

  } catch (err) {
    console.error('Template import error:', err);
    await reportApiError({
      endpoint: '/api/v2/template-import',
      action: req.query?.action || req.body?.action || 'unknown',
      error: err,
      requestBody: req.body,
      req
    }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
