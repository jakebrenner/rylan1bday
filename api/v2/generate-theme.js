import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Theme generation model — balance cost vs quality
// Options: 'claude-haiku-4-5-20251001' (cheapest), 'claude-sonnet-4-20250514' (best quality)
const THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-20250514';

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

## DESIGN RULES
1. The invite must be a single vertical card, centered, max-width 480px
2. Mobile-first: must look perfect on phones (320px+)
3. Include these sections in order:
   - Header area (visual impact — background, pattern, or gradient)
   - Event title (large, styled)
   - Date + time
   - Location (with link if provided)
   - Additional details (dress code, etc.)
   - An RSVP button area (just a styled placeholder div with class="rsvp-slot" — the app injects the real form)
4. Use Google Fonts only (include the @import in theme_config.googleFontsImport)
5. All images should use CSS gradients, SVG patterns, or emoji — do NOT reference external image URLs
6. Use CSS custom properties for colors so the user can tweak them later
7. Add subtle CSS animations (fade-ins, gentle floating) but nothing distracting
8. The design should feel unique and custom — NOT like a template

## WHAT NOT TO DO
- No JavaScript in the output
- No external image URLs or CDN references (except Google Fonts)
- No iframes or embedded content
- No fixed positioning
- Don't repeat the event details — they'll be injected dynamically
- Don't include an actual form — the RSVP form is injected by the platform

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

  const { eventId, prompt, eventDetails, inspirationImages } = req.body;

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

  const startTime = Date.now();

  try {
    let userMessage = `Create an invite theme for this event:

**Event Details:**
- Title: ${eventDetails.title}
- Date: ${eventDetails.eventDate}
- End Date: ${eventDetails.endDate || 'Not specified'}
- Location: ${eventDetails.locationName}${eventDetails.locationAddress ? `, ${eventDetails.locationAddress}` : ''}
- Dress Code: ${eventDetails.dressCode || 'Not specified'}
- Event Type: ${eventDetails.eventType}

**Creative Direction:**
${effectivePrompt}`;

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
      model: THEME_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }]
    });

    const latency = Date.now() - startTime;
    const contentBlock = response.content[0];
    let themeText = contentBlock.type === 'text' ? contentBlock.text : '';

    // Parse JSON response (handle ```json wrapping)
    themeText = themeText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
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
        model: THEME_MODEL,
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
      model: THEME_MODEL,
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
        model: THEME_MODEL,
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
      model: THEME_MODEL,
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
