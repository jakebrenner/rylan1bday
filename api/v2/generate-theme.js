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
  "theme_thankyou_html": "...",
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

### Required sections (in this order) — each MUST use the specified data attributes:
1. **Header area** — visual impact (background, pattern, gradient, decorative elements)
2. **Event title** — large, prominent, styled. The element containing the title text MUST have \`data-field="title"\`
3. **Date & time** — clearly displayed. The container holding date/time info MUST have \`data-field="datetime"\`. Format the date/time naturally (e.g., "March 22, 2026 at 1:00 PM"). If an end date/time is provided, show it as a range (e.g., "March 22, 2026 · 1:00 PM – 8:00 PM" or "March 22 – March 23, 2026").
4. **Location** — venue name and address. The container MUST have \`data-field="location"\`. Show both venue name and address if both are provided.
5. **Additional details** — dress code, description, or any other event info. If a dress code is provided, it MUST be displayed in its own styled section with \`data-field="dresscode"\`. Do NOT omit dress code if it is provided. If dress code is "Not specified", omit the dress code section entirely.
6. **RSVP form section** — This is MANDATORY. You MUST include:
   - A \`<div class="rsvp-slot">\` container
   - Inside it, ONLY a styled RSVP button: \`<button class="rsvp-button">RSVP Now</button>\`
   - Do NOT put any form fields (inputs, selects, labels) inside rsvp-slot — the platform injects the real form at runtime
   - The rsvp-slot div should contain ONLY the rsvp-button, nothing else
   - Style the rsvp-button to be visually prominent — it's the primary call-to-action

### Data attribute requirements (CRITICAL for the platform to update content dynamically):
- \`data-field="title"\` — on the element containing the event title text
- \`data-field="datetime"\` — on the container with date/time information
- \`data-field="location"\` — on the container with location information
- \`data-field="dresscode"\` — on the container with dress code info (omit entirely if no dress code)
These attributes allow the platform to update content when the user edits event details.

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
3. **TEXT CONTRAST IS CRITICAL** — every piece of text must be easily readable against its background:
   - Aim for WCAG AA contrast ratio (4.5:1 for body text, 3:1 for large headings)
   - Light text on dark backgrounds, dark text on light backgrounds — never light-on-light or dark-on-dark
   - When using gradient or image backgrounds, add a semi-transparent overlay or text-shadow to guarantee readability
   - Form labels, placeholder text, and input text in the RSVP section must have strong contrast against the form background
   - Test mentally: if the background is pastel/light, use dark text; if the background is vivid/dark, use white or very light text
   - Button text must contrast sharply with the button background color
4. Use Google Fonts only (include the @import in theme_config.googleFontsImport)
5. All images should use CSS gradients, SVG patterns, or emoji — do NOT reference external image URLs
6. Use CSS custom properties for colors so the user can tweak them later
7. Add subtle CSS animations (fade-ins, gentle floating) but nothing distracting
8. The design should feel unique and custom — NOT like a template
9. Keep overall height reasonable — the invite should fit in ~3-4 phone screen scrolls maximum

## THANK YOU PAGE (theme_thankyou_html)
Generate a matching thank you / confirmation page that shares the SAME visual design as the invite. This page is shown after a guest RSVPs.

### Requirements:
- Use the SAME CSS (theme_css applies to both pages) — same backgrounds, gradients, patterns, decorative elements
- Use the same fonts, colors, and overall aesthetic
- Include these sections:
  1. A celebratory heading (e.g., "You're all set!", "See you there!", etc.) — style it like the invite title
  2. A confirmation message with placeholders: \`<span class="thankyou-guest">Guest</span>\` for the guest name and \`<span class="thankyou-event">Event</span>\` for the event title (the platform replaces these at runtime)
  3. An "Add to Calendar" section with class \`calendar-buttons\`: \`<div class="calendar-buttons"><button class="cal-btn" data-cal="google">Google Calendar</button><button class="cal-btn" data-cal="apple">Apple Calendar</button><button class="cal-btn" data-cal="outlook">Outlook</button><button class="cal-btn" data-cal="yahoo">Yahoo Calendar</button></div>\` — This section is REQUIRED and must ALWAYS be included. Never omit the calendar buttons.
  4. A "Made with Love by Ryvite" footer — the word "Ryvite" should be wrapped in \`<a href="/" style="color:inherit;text-decoration:none;">Ryvite</a>\`
- Keep it vertically centered, max-width 393px, same card style as the invite
- Reuse CSS classes from the invite theme where possible (backgrounds, card containers, etc.)
- Should feel like a natural continuation of the invite — same world, same aesthetic

## WHAT NOT TO DO
- No JavaScript in the output
- No external image URLs or CDN references (except Google Fonts)
- No iframes or embedded content
- No fixed positioning
- NEVER omit the RSVP button section — this is the most important functional element
- NEVER put form inputs, selects, textareas, labels, or field placeholders inside the \`.rsvp-slot\` div — ONLY the \`<button class="rsvp-button">\` goes there. The platform injects the complete form at runtime.
- NEVER omit data-field attributes on required sections (title, datetime, location, dresscode)

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

  const action = req.query?.action || req.body?.action || 'generate';
  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages, tweakInstructions, currentHtml, currentCss, currentConfig, photoBase64, photoUrl } = req.body;

  // --- TWEAK MODE: stream response via SSE to avoid timeouts ---
  if (action === 'tweak') {
    if (!eventId || !currentHtml || !currentCss || !tweakInstructions) {
      return res.status(400).json({ error: 'Missing required fields for tweak' });
    }

    const themeModel = await getThemeModel();
    const startTime = Date.now();

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Build event context for the AI
      let eventContext = '';
      if (eventDetails) {
        eventContext = `\n**Current Event Details:**
- Title: ${eventDetails.title || 'Not set'}
- Start: ${eventDetails.eventDate || 'Not set'}
- End: ${eventDetails.endDate || 'Not set'}
- Location: ${eventDetails.locationName || 'Not set'}${eventDetails.locationAddress ? `, ${eventDetails.locationAddress}` : ''}
- Dress Code: ${eventDetails.dressCode || 'Not set'}
`;
      }
      if (rsvpFields?.length > 0) {
        eventContext += `\n**Current RSVP Fields:** ${rsvpFields.map(f => `${f.label} (${f.field_type}${f.is_required ? ', required' : ''})`).join(', ')}\n`;
      }

      let tweakMessage = `Here is an existing invite theme. The user is using the chat designer to modify their invite.
${eventContext}
**Current HTML:**
\`\`\`html
${currentHtml}
\`\`\`

**Current CSS:**
\`\`\`css
${currentCss}
\`\`\`

**Current Config:**
\`\`\`json
${JSON.stringify(currentConfig || {})}
\`\`\`

**User's message:**
${tweakInstructions}

IMPORTANT: The .rsvp-slot div must contain ONLY a <button class="rsvp-button"> — the platform injects the real RSVP form at runtime. Do NOT add any form inputs, selects, textareas, or labels inside .rsvp-slot.`;

      if (photoUrl) {
        tweakMessage += `\n\nThe user has uploaded a photo they want incorporated into the design. Use this EXACT URL in an <img> tag: ${photoUrl}\nPlace the photo prominently in the design where it makes sense (e.g., header area, hero section, or a dedicated photo section). Style it with appropriate sizing (max-width: 100%), border-radius, and any CSS that fits the theme.`;
      } else if (photoBase64) {
        tweakMessage += `\n\nThe user has also provided a photo they want incorporated into the design. Use this image as an inline base64 data URI in an <img> tag where it makes sense for the design.`;
      }

      const existingThankyou = currentConfig?.thankyouHtml || '';
      if (existingThankyou) {
        tweakMessage += `\n\n**Current Thank You Page HTML:**\n\`\`\`html\n${existingThankyou}\n\`\`\`\nIf your changes affect the visual style (colors, fonts, spacing, backgrounds), update the thank you page to match. If the change is content-only (e.g., changing text, adding an element to the invite), you may set theme_thankyou_html to null to keep it unchanged.`;
      }

      tweakMessage += `\n\nReturn the updated theme as a JSON object: { "theme_html": "...", "theme_css": "...", "theme_thankyou_html": "..." or null if unchanged, "theme_config": { ... }, "chat_response": "Brief friendly message about what you changed" }. Make ONLY the changes the user requested — keep everything else exactly the same. If the thank you page doesn't need changes, set theme_thankyou_html to null.`;

      const messageContent = photoBase64 && !photoUrl
        ? [
            { type: 'text', text: tweakMessage },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } }
          ]
        : [{ type: 'text', text: tweakMessage }];

      // Stream the response from Claude
      sendSSE('status', { phase: 'generating' });

      const tweakSystemPrompt = `You are Ryvite's expert invite designer. You modify event invite themes based on the user's instructions via a conversational chat interface.

## YOUR ROLE
Users will ask you to update their invite design — this includes BOTH visual changes AND event content changes. Users may:
- Add or update location, address, dress code, or other event details
- Add or modify RSVP form fields (dietary restrictions, plus-ones, song requests, etc.)
- Change colors, fonts, backgrounds, layout, spacing
- Add photos, decorative elements, or completely change the style

## OUTPUT FORMAT
Return ONLY a valid JSON object with these keys:
{
  "theme_html": "...",
  "theme_css": "...",
  "theme_thankyou_html": "..." or null if unchanged,
  "theme_config": { ... },
  "chat_response": "A brief, friendly message (1-2 sentences) describing what you changed. Use a conversational tone."
}

## CRITICAL RULES

### Data attributes (REQUIRED on all key elements):
- \`data-field="title"\` — on the element containing the event title
- \`data-field="datetime"\` — on the container with date/time info
- \`data-field="location"\` — on the container with location info
- \`data-field="dresscode"\` — on the container with dress code info
These allow the platform to update content dynamically. Always preserve these.

### RSVP form section:
- The \`.rsvp-slot\` div must contain ONLY a \`<button class="rsvp-button">\` — NO form inputs, labels, or fields
- The platform injects the real RSVP form at runtime
- When users mention RSVP fields (e.g., "add a dietary restrictions field"), acknowledge it in chat_response but do NOT add form inputs to the HTML

### Design rules:
- Max-width 393px, mobile-first design
- WCAG AA text contrast (4.5:1 body, 3:1 headings)
- Google Fonts only (include @import in theme_config.googleFontsImport)
- No JavaScript, no external images (except Google Fonts and user-uploaded photos)
- Make minimal changes — only what the user asked for, keep everything else exactly the same
- The thank you page must match the invite's aesthetic`;

      const stream = client.messages.stream({
        model: themeModel,
        max_tokens: 16384,
        system: tweakSystemPrompt,
        messages: [{ role: 'user', content: messageContent }]
      });

      // Accumulate the full response while streaming progress
      let fullText = '';
      let chunkCount = 0;

      stream.on('text', (text) => {
        fullText += text;
        chunkCount++;
        // Send progress every 20 chunks to keep connection alive without flooding
        if (chunkCount % 10 === 0) {
          sendSSE('progress', { chunks: chunkCount, bytes: fullText.length });
        }
      });

      // Wait for stream to complete
      const finalMessage = await stream.finalMessage();
      const latency = Date.now() - startTime;

      sendSSE('status', { phase: 'saving' });

      // Parse the accumulated text
      let themeText = fullText.trim();
      const jsonBlockMatch = themeText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (jsonBlockMatch) themeText = jsonBlockMatch[1].trim();
      if (!themeText.startsWith('{')) {
        const firstBrace = themeText.indexOf('{');
        const lastBrace = themeText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) themeText = themeText.substring(firstBrace, lastBrace + 1);
      }

      // Attempt to repair truncated JSON if parsing fails
      let theme;
      try {
        theme = JSON.parse(themeText);
      } catch (parseErr) {
        // Try to repair: close any unclosed strings and braces
        let repaired = themeText;
        // Count unmatched quotes — if odd, close the string
        const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
        if (quoteCount % 2 !== 0) repaired += '"';
        // Close any unclosed braces/brackets
        let braceDepth = 0, bracketDepth = 0;
        let inString = false;
        for (let i = 0; i < repaired.length; i++) {
          const ch = repaired[i];
          if (ch === '"' && (i === 0 || repaired[i-1] !== '\\')) inString = !inString;
          if (!inString) {
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
            else if (ch === '[') bracketDepth++;
            else if (ch === ']') bracketDepth--;
          }
        }
        for (let i = 0; i < bracketDepth; i++) repaired += ']';
        for (let i = 0; i < braceDepth; i++) repaired += '}';
        try {
          theme = JSON.parse(repaired);
        } catch (e2) {
          throw new Error('Failed to parse theme JSON: ' + parseErr.message);
        }
      }

      if (!theme.theme_html || !theme.theme_css) {
        throw new Error('Invalid tweak response');
      }

      // Merge config — use null for unchanged thank you page
      const tweakConfig = theme.theme_config || currentConfig || {};
      if (theme.theme_thankyou_html && theme.theme_thankyou_html !== null) {
        tweakConfig.thankyouHtml = theme.theme_thankyou_html;
      } else if (currentConfig?.thankyouHtml) {
        tweakConfig.thankyouHtml = currentConfig.thankyouHtml;
      }

      // Save as new version
      const { data: existingThemes } = await supabase
        .from('event_themes')
        .select('id, version')
        .eq('event_id', eventId)
        .order('version', { ascending: false })
        .limit(1);

      const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;

      await supabase
        .from('event_themes')
        .update({ is_active: false })
        .eq('event_id', eventId)
        .eq('is_active', true);

      const { data: newTheme, error: themeError } = await supabase
        .from('event_themes')
        .insert({
          event_id: eventId,
          version: nextVersion,
          is_active: true,
          prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
          html: theme.theme_html,
          css: theme.theme_css,
          config: tweakConfig,
          model: themeModel,
          input_tokens: finalMessage.usage?.input_tokens || 0,
          output_tokens: finalMessage.usage?.output_tokens || 0,
          latency_ms: latency
        })
        .select()
        .single();

      if (themeError) throw new Error('Failed to save theme: ' + themeError.message);

      await supabase.from('generation_log').insert({
        event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
        model: themeModel, input_tokens: finalMessage.usage?.input_tokens || 0,
        output_tokens: finalMessage.usage?.output_tokens || 0, latency_ms: latency, status: 'success'
      });

      // Send the final result as an SSE event
      sendSSE('done', {
        success: true,
        theme: { id: newTheme.id, version: newTheme.version, html: theme.theme_html, css: theme.theme_css, config: tweakConfig },
        chatResponse: theme.chat_response || null
      });

      return res.end();
    } catch (err) {
      console.error('Theme tweak error:', err);
      try {
        await supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + (tweakInstructions || '').substring(0, 200),
          model: themeModel, input_tokens: 0, output_tokens: 0, latency_ms: Date.now() - startTime, status: 'error', error: err.message
        });
      } catch {}
      sendSSE('error', { error: 'Failed to tweak theme', message: err.message });
      return res.end();
    }
  }

  if (!eventId || !eventDetails) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const effectivePrompt = prompt || `Create a beautiful invite for a ${eventDetails.eventType || 'event'}`;


  // Rate limiting: 20 per hour per user
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('generation_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('status', 'success')
    .gte('created_at', oneHourAgo);

  if (count >= 20) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 20 generations per hour.' });
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
- Start Date/Time: ${eventDetails.eventDate || 'Not specified'}
- End Date/Time: ${eventDetails.endDate || 'Not specified'}
- Location Name: ${eventDetails.locationName || 'Not specified'}
- Location Address: ${eventDetails.locationAddress || 'Not specified'}
- Dress Code: ${eventDetails.dressCode || 'Not specified'}
- Event Type: ${eventDetails.eventType}

**RSVP Form — IMPORTANT:**
The platform will inject a fully functional RSVP form into the \`.rsvp-slot\` container at runtime. You must ONLY place a styled \`<button class="rsvp-button">\` inside the \`.rsvp-slot\` div. Do NOT generate any form inputs, selects, labels, or field placeholders inside \`.rsvp-slot\` — the platform handles all form rendering.

The following fields will be in the injected form (for your awareness of what the RSVP section will look like, but do NOT render them):
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

    // Store thank you HTML in config to avoid DB schema change
    if (theme.theme_thankyou_html) {
      theme.theme_config.thankyouHtml = theme.theme_thankyou_html;
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

    // Log error (don't let logging failure mask the real error)
    try {
      await supabase.from('generation_log').insert({
        event_id: eventId,
        user_id: user.id,
        prompt: effectivePrompt,
        model: themeModel,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: Date.now() - startTime,
        status: 'error',
        error: (err.message || '').substring(0, 500)
      });
    } catch (logErr) {
      console.error('Failed to log generation error:', logErr);
    }

    return res.status(500).json({
      error: 'Failed to generate theme',
      message: err.message || 'Unknown error'
    });
  }
}
