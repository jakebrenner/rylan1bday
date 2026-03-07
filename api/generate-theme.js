import Anthropic from '@anthropic-ai/sdk';
import { verifySessionToken } from './auth.js';

const client = new Anthropic();
const GAS_URL = process.env.GAS_URL;

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

async function callGAS(action, data) {
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action, ...data }),
    redirect: 'follow'
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/^[a-zA-Z_]\w*\(([\s\S]+)\)$/);
    if (match) return JSON.parse(match[1]);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify session token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = verifySessionToken(authHeader.slice(7));
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const { eventId, userId, prompt, eventDetails, inspirationImages } = req.body;

  if (!eventId || !userId || !prompt || !eventDetails) {
    return res.status(400).json({ error: 'Missing required fields' });
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
${prompt}`;

    if (inspirationImages && inspirationImages.length > 0) {
      userMessage += `\n\n**Visual Inspiration:** I've provided ${inspirationImages.length} image(s) as inspiration for color palette and mood.`;
    }

    const messageContent = inspirationImages && inspirationImages.length > 0
      ? [
          { type: 'text', text: userMessage },
          ...inspirationImages.map(img => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: img
            }
          }))
        ]
      : [{ type: 'text', text: userMessage }];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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

    // Log generation (fire and forget)
    callGAS('logGeneration', {
      eventId,
      userId,
      prompt,
      model: 'claude-sonnet-4-20250514',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs: latency,
      status: 'success'
    });

    // Update event with theme (fire and forget)
    callGAS('updateEvent', {
      eventId,
      userId,
      themeHtml: theme.theme_html,
      themeCss: theme.theme_css,
      themeConfig: JSON.stringify(theme.theme_config)
    });

    return res.status(200).json({
      success: true,
      theme: {
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config
      },
      metadata: {
        model: 'claude-sonnet-4-20250514',
        latencyMs: latency,
        tokens: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens
        }
      }
    });
  } catch (err) {
    console.error('Theme generation error:', err);

    // Log error (fire and forget)
    callGAS('logGeneration', {
      eventId,
      userId,
      prompt,
      model: 'claude-sonnet-4-20250514',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      status: 'error',
      error: err.message
    });

    return res.status(500).json({
      error: 'Failed to generate theme',
      message: err.message
    });
  }
}
