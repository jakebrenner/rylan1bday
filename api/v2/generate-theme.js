import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-6';

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

const SYSTEM_PROMPT = `You are an elite invitation designer who creates breathtaking, one-of-a-kind HTML/CSS digital invitations. Every invite you create should look like it was crafted by a top design agency — not generated from a template.

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

## DESIGN PHILOSOPHY — BE CREATIVE, NOT TEMPLATED
Your #1 goal is to make every invite feel **completely unique**. Avoid falling into the same layout pattern. Here's what makes a great invite:

- **Creative typography** — Play with font sizes dramatically. The event name or a key word might be HUGE (60-100px+). Mix fonts expressively. Use letter-spacing, text-transform, and font-weight as design tools.
- **Visual storytelling** — Use the event theme to drive the entire visual language. A beach party should FEEL like the beach. A formal gala should ooze elegance. A kid's birthday should be bursting with joy and whimsy.
- **Decorative richness** — Scatter emoji, CSS-drawn shapes, SVG illustrations, confetti, dots, lines, patterns, and flourishes throughout the design. Don't just put them in a header — weave them into the whole page.
- **Varied layouts** — Break out of the "title → date → location → RSVP" stack. Try:
  - Overlapping elements and layered compositions
  - Icon + text rows for details instead of plain text blocks
  - Creative dividers (wavy lines, dashed borders, emoji rows, decorative SVGs)
  - Background sections that shift color, texture, or pattern
  - Cards within cards, floating badges, ribbon-style labels
  - Split the title into multiple styled lines with different sizes/weights
- **Full-page backgrounds** — The whole page should be designed, not just a card on a white background. Use gradients, patterns, textures, or color that extends edge-to-edge.
- **Personality through details** — Add small delightful touches: a subtle animation, a clever emoji placement, a hand-drawn-style border, a spotlight effect on the title.

## REQUIRED ELEMENTS (include all, but layout freely)
You have FULL creative freedom over layout, order, and presentation. But these elements must exist somewhere in the invite:

1. **Event title** — the element with the title text MUST have \`data-field="title"\`
2. **Date & time** — container MUST have \`data-field="datetime"\`. Format naturally (e.g., "Saturday, March 22, 2026 · 1:00 PM – 3:00 PM")
3. **Location** — container MUST have \`data-field="location"\`. Show venue name and address.
4. **Dress code** (if provided) — container MUST have \`data-field="dresscode"\`. Omit entirely if dress code is "Not specified".
5. **RSVP section** — MUST include \`<div class="rsvp-slot"><button class="rsvp-button">...</button></div>\`. The rsvp-slot MUST contain ONLY the button — no form fields. The platform injects the real form at runtime. Make the button text fun and on-theme (not just "RSVP Now").

The data-field attributes are required so the platform can update content dynamically.

## TECHNICAL CONSTRAINTS
- Max-width 393px (iPhone), centered, mobile-first
- Text must be readable: min 14px body, WCAG AA contrast ratios
- Generous padding — content never touches edges
- RSVP button: min 48px height, prominent, high contrast, with hover states
- Google Fonts only (via @import in googleFontsImport)
- Use CSS gradients, SVGs, shapes, and emoji for visuals — NO external image URLs
- CSS custom properties for colors
- **CSS ANIMATIONS ARE KEY** — Every invite should feel alive and premium. Include meaningful animations:
  - Entrance animations: elements should fade in, slide up, or scale in as the page loads (use @keyframes + animation-delay to stagger them)
  - Ambient motion: subtle floating, gentle pulsing, rotating decorative elements, twinkling/sparkling effects
  - Interactive touches: hover effects on buttons, cards that lift on hover
  - Decorative animation: drifting confetti, floating bubbles/shapes, swaying elements, parallax-like layered motion
  - Use animation-delay to create a choreographed reveal — title first, then details, then RSVP button
  - Keep animations smooth (use transform and opacity for performance) and tasteful — enhance, don't distract
- No JavaScript in the output
- No fixed positioning, no iframes
- NEVER put form inputs/selects/labels inside \`.rsvp-slot\`
- Keep height reasonable — fits in ~3-5 phone screen scrolls

## THANK YOU PAGE (theme_thankyou_html)
Generate a beautiful, polished thank you page that feels like a premium continuation of the invite. Same CSS applies to both.

Requirements:
- **Same visual world** — identical backgrounds, gradients, patterns, decorative elements, fonts, colors
- A **celebratory heading** that's creative and on-theme (not generic "Thank you!")
- Confirmation text with \`<span class="thankyou-guest">Guest</span>\` and \`<span class="thankyou-event">Event</span>\` placeholders
- **Calendar buttons — MUST be beautifully styled, not plain/default buttons:**
  \`<div class="calendar-buttons"><button class="cal-btn" data-cal="google">Google Calendar</button><button class="cal-btn" data-cal="apple">Apple Calendar</button><button class="cal-btn" data-cal="outlook">Outlook</button><button class="cal-btn" data-cal="yahoo">Yahoo Calendar</button></div>\`
  - Style them as elegant pills, rounded cards, or icon-style buttons that match the invite aesthetic
  - Use the theme's colors, fonts, and border styles
  - Add subtle hover effects and transitions
  - Consider a 2x2 grid or horizontal scroll layout — NOT an ugly vertical stack of plain buttons
  - Each button should feel intentionally designed, with proper padding, border-radius, and spacing
  - NEVER leave them as unstyled browser-default buttons — this ruins the premium feel
- Footer: "Made with Love by Ryvite" where Ryvite is \`<a href="/" style="color:inherit;text-decoration:none;">Ryvite</a>\`
- Max-width 393px
- Include entrance animations on the thank you page too — the guest just RSVP'd, make it feel celebratory!
- The thank you page should feel just as polished as the invite — NOT an afterthought

## INSPIRATION IMAGES
If provided, analyze them for color palette, visual mood, textures, typography style, and overall aesthetic. Use these as strong creative direction.`;

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
- The thank you page must match the invite's aesthetic — it should feel equally polished and premium
- Calendar buttons on the thank you page should be beautifully styled (pills, rounded cards, or icon-style) — NEVER plain unstyled buttons
- Preserve and enhance CSS animations — every invite should feel alive with entrance animations, ambient motion, and interactive hover effects`;

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

  if (count >= 100) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 100 generations per hour.' });
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
