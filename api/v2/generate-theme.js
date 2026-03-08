import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-20250514';

async function getThemeModel() {
  try {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'theme_model')
      .single();
    return data?.value || DEFAULT_THEME_MODEL;
  } catch {
    return DEFAULT_THEME_MODEL;
  }
}

const SYSTEM_PROMPT = `You are Ryvite's invite designer — an expert at turning natural language event descriptions into beautiful, custom HTML/CSS invite themes.

## YOUR TASK
Generate a complete, self-contained HTML invite page for the event described. The output should be production-ready HTML + CSS that renders a beautiful, mobile-responsive invitation.

## OUTPUT FORMAT
Return a JSON object with exactly these keys:
{
  "theme_html": "...",
  "theme_css": "...",
  "theme_config": {
    "primaryColor": "#hex",
    "secondaryColor": "#hex",
    "accentColor": "#hex",
    "backgroundColor": "#hex",
    "textColor": "#hex",
    "fontHeadline": "Font Name",
    "fontBody": "Font Name",
    "mood": "one-word mood descriptor",
    "googleFontsImport": "@import url('...')"
  }
}

## CRITICAL — MANDATORY STRUCTURE
The generated invite MUST always include ALL of the following sections. These are non-negotiable — the platform depends on this exact structure to function. Creative freedom applies to visual design ONLY, never to omitting required sections.

### Required sections (in this order):
1. **Header area** — visual impact (background, pattern, gradient, decorative elements)
2. **Event title** — large, prominent, styled
3. **Date & time** — clearly displayed
4. **Location** — venue name and address
5. **Additional details** — dress code, description, or any other event info provided
6. **RSVP form section** — This is MANDATORY. You MUST include:
   - A \`<div class="rsvp-slot">\` container
   - Inside it, a prominent, styled RSVP button: \`<button class="rsvp-button">RSVP Now</button>\`
   - If the user has custom RSVP fields, show labels for each field inside the rsvp-slot as placeholder text (e.g., "Name", "Email", "Dietary Restrictions") — these indicate what the real form will collect
   - Style the rsvp-button to be visually prominent — it's the primary call-to-action
   - The platform replaces this div's contents with a real form at runtime, but the button MUST exist in the theme HTML

### RSVP button styling requirements:
- Full-width or near-full-width within the card
- High contrast against the background
- Large enough to be easily tappable on mobile (min 48px height)
- Styled consistently with the overall theme (use theme colors, fonts)
- Add hover/active states in CSS

## DESIGN RULES
1. The invite must be a single vertical card, centered, max-width 393px (iPhone width)
2. **MOBILE-FIRST** — this will be viewed primarily on phones:
   - Design for 393px viewport width (iPhone 15)
   - All text must be readable without zooming (body min 14px, headings 24-32px)
   - Generous padding (20-24px sides) — never let content touch screen edges
   - Buttons min 48px tall, full-width, single-line text
   - Stack all sections vertically — no side-by-side layouts
   - Keep card max-width 393px so it fills the phone screen naturally
   - Touch targets minimum 44x44px
   - Use relative units (em, rem, %, vw) where appropriate
3. Use Google Fonts only (include the @import in theme_config.googleFontsImport)
4. All images should use CSS gradients, SVG patterns, or emoji — do NOT reference external image URLs
5. Use CSS custom properties for colors so the user can tweak them later
6. Add subtle CSS animations (fade-ins, gentle floating) but nothing distracting
7. The design should feel unique and custom — NOT like a template
8. Keep overall height reasonable — the invite should fit in ~3-4 phone screen scrolls maximum

## WHAT NOT TO DO
- No JavaScript in the output
- No external image URLs or CDN references (except Google Fonts)
- No iframes or embedded content
- No fixed positioning
- NEVER omit the RSVP button section — this is the most important functional element

## INSPIRATION IMAGES
If the user provides inspiration images, analyze them for:
- Color palette (dominant and accent colors)
- Visual mood (elegant, playful, rustic, modern, etc.)
- Textures and patterns
- Typography style cues
- Overall aesthetic direction
Incorporate these visual cues into your design.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify session
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages } = req.body;

  if (!eventId || !eventDetails) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const effectivePrompt = prompt || `Create a beautiful invite for a ${eventDetails.eventType || 'event'}`;


  // Rate limiting: 5 per hour per user
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('generation_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('status', 'success')
    .gte('created_at', oneHourAgo);

  if (count >= 5) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 5 generations per hour.' });
  }

  const themeModel = await getThemeModel();
  const startTime = Date.now();

  try {
    // Build RSVP fields description
    let rsvpFieldsDesc = 'Default fields: Name, Email, RSVP Status (Attending/Declined/Maybe)';
    if (rsvpFields?.length > 0) {
      rsvpFieldsDesc += '\nCustom fields: ' + rsvpFields.map(f => `${f.label} (${f.field_type}${f.is_required ? ', required' : ''})`).join(', ');
    }

    let userMessage = `Create an invite theme for this event:

**Event Details:**
- Title: ${eventDetails.title}
- Date: ${eventDetails.eventDate}
- End Date: ${eventDetails.endDate || 'Not specified'}
- Location: ${eventDetails.locationName}${eventDetails.locationAddress ? `, ${eventDetails.locationAddress}` : ''}
- Dress Code: ${eventDetails.dressCode || 'Not specified'}
- Event Type: ${eventDetails.eventType}

**RSVP Form Fields (must appear in the RSVP section):**
${rsvpFieldsDesc}

**Creative Direction:**
${effectivePrompt}`;

    if (feedback) {
      userMessage += `\n\n**Feedback on previous version (incorporate this):**\n${feedback}`;
    }

    if (inspirationImages?.length > 0) {
      userMessage += `\n\n**Visual Inspiration:** I've provided ${inspirationImages.length} image(s) as inspiration for color palette and mood.`;
    }

    const messageContent = inspirationImages?.length > 0
      ? [
          { type: 'text', text: userMessage },
          ...inspirationImages.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: img }
          }))
        ]
      : [{ type: 'text', text: userMessage }];

    const response = await client.messages.create({
      model: themeModel,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }]
    });

    const latency = Date.now() - startTime;
    const contentBlock = response.content[0];
    let themeText = contentBlock.type === 'text' ? contentBlock.text : '';

    // Parse JSON response — handle various wrapping patterns
    themeText = themeText.trim();
    // Remove ```json ... ``` wrapping (may have leading/trailing text)
    const jsonBlockMatch = themeText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) {
      themeText = jsonBlockMatch[1].trim();
    }
    // Try to find the JSON object if there's surrounding prose
    if (!themeText.startsWith('{')) {
      const firstBrace = themeText.indexOf('{');
      const lastBrace = themeText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        themeText = themeText.substring(firstBrace, lastBrace + 1);
      }
    }
    const theme = JSON.parse(themeText);

    if (!theme.theme_html || !theme.theme_css || !theme.theme_config) {
      throw new Error('Invalid theme response from Claude');
    }

    // Determine next version number
    const { data: existingThemes } = await supabase
      .from('event_themes')
      .select('id, version')
      .eq('event_id', eventId)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;

    // Deactivate any currently active theme for this event
    await supabase
      .from('event_themes')
      .update({ is_active: false })
      .eq('event_id', eventId)
      .eq('is_active', true);

    // Insert new theme as active
    const { data: newTheme, error: themeError } = await supabase
      .from('event_themes')
      .insert({
        event_id: eventId,
        version: nextVersion,
        is_active: true,
        prompt: effectivePrompt,
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config,
        model: themeModel,
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        latency_ms: latency
      })
      .select()
      .single();

    if (themeError) {
      throw new Error('Failed to save theme: ' + themeError.message);
    }

    // Log successful generation
    await supabase.from('generation_log').insert({
      event_id: eventId,
      user_id: user.id,
      prompt: effectivePrompt,
      model: themeModel,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      latency_ms: latency,
      status: 'success'
    });

    return res.status(200).json({
      success: true,
      theme: {
        id: newTheme.id,
        version: newTheme.version,
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config
      },
      metadata: {
        model: themeModel,
        latencyMs: latency,
        tokens: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens
        }
      }
    });
  } catch (err) {
    console.error('Theme generation error:', err);

    // Log error
    await supabase.from('generation_log').insert({
      event_id: eventId,
      user_id: user.id,
      prompt: effectivePrompt,
      model: themeModel,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - startTime,
      status: 'error',
      error: err.message
    });

    return res.status(500).json({
      error: 'Failed to generate theme',
      message: err.message
    });
  }
}
