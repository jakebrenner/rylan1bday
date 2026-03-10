import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDER_EMAIL = 'jake@getmrkt.com';

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const email = user.email.toLowerCase();
  if (email === FOUNDER_EMAIL) return user;

  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();

  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return user;
  }

  return null;
}

// ── Import the same DESIGN_DNA and SYSTEM_PROMPT from generate-theme.js ──
const DESIGN_DNA = {
  kidsBirthday: {
    label: 'Kids Birthday (Ages 0-10)',
    photoTreatment: 'Circular crops in a bobbing row, each with a differently colored SVG birthday hat.',
    decorative: 'Animated floating balloons, confetti bursts, bunting flags.',
    typography: 'Bold, rounded display font (e.g. Fredoka One, Baloo 2, Lilita One).',
    colorPhilosophy: 'Dominant palette of 4-5 fully saturated colors, no grays.',
    motion: 'Floating/falling elements on infinite loop. Confetti burst energy.',
    standout: 'Baby/kid faces with bouncing birthday hats in a playful row'
  },
  adultBirthday: { label: 'Adult / Milestone Birthday', photoTreatment: 'Full-bleed editorial panel with stylized overlay.', decorative: 'Atmospheric texture matching the era/tone.', typography: 'Era-appropriate or bold editorial font.', colorPhilosophy: '2-3 dominant colors with deliberate restraint OR excess.', motion: 'Tone-appropriate: champagne bubble float, spotlight sweep.', standout: 'The milestone number as a massive typographic hero element' },
  babyShower: { label: 'Baby Shower / Sip & See', photoTreatment: 'Softly rounded oval frames with floral wreath overlay.', decorative: 'Watercolor wash backgrounds, botanical elements.', typography: 'Elegant script paired with refined serif.', colorPhilosophy: 'Soft, limited palette (2-3 colors + cream/white).', motion: 'Gentle petal/leaf fall, slow dreamy fade-ins.', standout: 'Lush floral wreath framing the baby name' },
  engagement: { label: 'Engagement Party', photoTreatment: 'Large, styled hero image of the couple.', decorative: 'Floating rings, botanical elements, abstract ink strokes.', typography: 'Romantic script + modern sans.', colorPhilosophy: 'Derived from couple photo tones, romantic palette.', motion: 'Hearts or sparkle particles floating.', standout: 'Couple photo with names in large display typography' },
  wedding: { label: 'Wedding / Reception', photoTreatment: 'Full-width hero with sophisticated overlay.', decorative: 'Minimal and intentional — botanical borders, geometric patterns.', typography: 'Distinguished pairing (e.g. Cormorant Garamond + Jost).', colorPhilosophy: '2 colors max + neutrals.', motion: 'Very subtle — slow fade-ins, gentle parallax feel.', standout: 'Couple names in breathtaking display typography' },
  graduation: { label: 'Graduation Party', photoTreatment: 'Prominent hero treatment with school colors.', decorative: 'Falling diplomas, confetti mortarboards.', typography: 'Bold, confident display font.', colorPhilosophy: 'School colors as accent, bold celebratory palette.', motion: 'Paper toss animation feel. Mortarboards floating.', standout: 'Graduate name with massive milestone text' },
  holiday: { label: 'Holiday Party', photoTreatment: 'Atmospheric hero (Christmas/NYE) or themed borders.', decorative: 'Holiday-SPECIFIC atmospheric animation.', typography: 'Match the holiday emotional register.', colorPhilosophy: 'Holiday palette with a modern TWIST.', motion: 'Holiday-specific ambient: snow, fireworks, leaves.', standout: 'Holiday-specific atmospheric animation' },
  dinnerParty: { label: 'Dinner Party / Cocktail Hour', photoTreatment: 'Atmospheric hero with soft vignette.', decorative: 'Texture-first: linen, marble, dark wood, candlelight.', typography: 'Editorial pairing — unexpected but refined.', colorPhilosophy: 'Deep wines, warm golds, cream, charcoal.', motion: 'Minimal — slow reveals, candlelight flicker.', standout: 'Rich, textured background that sets mood' },
  retirement: { label: 'Retirement Party', photoTreatment: 'Prominent, respectful hero treatment.', decorative: 'Achievement badges, timeline elements.', typography: 'Authoritative and warm serif or display font.', colorPhilosophy: 'Distinguished: navy/gold, deep green/cream.', motion: 'Meaningful and measured entrance animations.', standout: 'Years-of-service counter or career timeline' },
  anniversary: { label: 'Anniversary Party', photoTreatment: 'Then and now side-by-side or styled hero.', decorative: 'Romantic but not saccharine. Gold accents.', typography: 'Romantic but confident and warm.', colorPhilosophy: 'Gold/warm neutrals for milestone years.', motion: 'Gentle sparkle, elegant fade-in choreography.', standout: 'Then and now photo treatment or milestone number' },
  sports: { label: 'Sports / Watch Party', photoTreatment: 'Host photo in team gear with gradient overlay.', decorative: 'Dynamic: stadium lights, score-ticker aesthetic.', typography: 'Bold, condensed, athletic display fonts.', colorPhilosophy: 'Team colors with maximum energy.', motion: 'Stadium light sweep, scoreboard-style reveals.', standout: 'Stadium scoreboard header with team colors' },
  bridalShower: { label: 'Bridal Shower', photoTreatment: 'Engagement photo as elegant hero.', decorative: 'Floral illustration elements — lush, garden party.', typography: 'Script + elegant sans or serif.', colorPhilosophy: 'Blush, champagne, sage, and cream.', motion: 'Floating petals, gentle botanical sway.', standout: 'Lush, hand-illustrated-style floral elements' },
  corporate: { label: 'Corporate Event', photoTreatment: 'Brand-aligned hero treatment.', decorative: 'Geometric patterns, subtle gradients.', typography: 'Clean, modern sans-serif pairing.', colorPhilosophy: 'Brand colors or sophisticated neutral + accent.', motion: 'Subtle, professional entrance animations.', standout: 'Clean, modern premium design' },
  other: { label: 'Custom Event', photoTreatment: 'Style based on event description.', decorative: 'Match the event mood.', typography: 'Fonts matching event emotional register.', colorPhilosophy: 'Derived from the creative direction.', motion: 'Match the energy level of the event.', standout: 'Whatever makes this event feel special' }
};

function buildEventTypeContext(eventType) {
  const dna = DESIGN_DNA[eventType] || DESIGN_DNA.other;
  let context = `\n## EVENT-SPECIFIC DESIGN DNA (${dna.label})`;
  context += `\n- **Photo treatment**: ${dna.photoTreatment}`;
  context += `\n- **Decorative elements**: ${dna.decorative}`;
  context += `\n- **Typography**: ${dna.typography}`;
  context += `\n- **Color philosophy**: ${dna.colorPhilosophy}`;
  context += `\n- **Animation/Motion**: ${dna.motion}`;
  context += `\n- **Standout visual element**: ${dna.standout}`;
  return context;
}

// Extract CSS and structural summary from HTML to reduce token usage (~60% savings)
function extractStyleEssence(html) {
  // Extract <style> block contents
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = styleMatch ? styleMatch[1].trim() : '';

  // Extract structural summary: tag hierarchy, class names, key text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  // Get all class names used
  const classNames = [...new Set((body.match(/class="([^"]+)"/g) || []).map(m => m.replace(/class="(.+)"/, '$1')))];

  // Get section structure (top-level divs and semantic elements)
  const sections = [];
  const sectionRegex = /<(div|section|header|main|footer|nav)\s[^>]*class="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = sectionRegex.exec(body)) !== null) {
    sections.push(`<${match[1]} class="${match[2]}">`);
  }

  // Extract Google Fonts imports
  const fontImports = (html.match(/@import\s+url\([^)]+\)/g) || []).join('\n');
  const fontLinks = (html.match(/<link[^>]*fonts\.googleapis[^>]*>/g) || []).join('\n');

  let summary = '';
  if (fontImports || fontLinks) summary += `Fonts:\n${fontImports}\n${fontLinks}\n\n`;
  if (sections.length > 0) summary += `Structure:\n${sections.join('\n')}\n\n`;
  if (classNames.length > 0) summary += `Classes: ${classNames.join(', ')}\n\n`;
  if (css) summary += `CSS:\n\`\`\`css\n${css}\n\`\`\``;

  return summary;
}

// Build style context for prompt injection
function buildStyleContext(selected) {
  let context = '\n\n## STYLE REFERENCE LIBRARY\nThe following are design references we admire. Study the CSS patterns, color palettes, typography choices, animation techniques, and structural approaches. Use them as strong creative inspiration — do NOT copy verbatim.\n\n';

  selected.forEach((item, i) => {
    context += `### Reference ${i + 1}: "${item.name}"\n`;
    if (item.description) context += `Description: ${item.description}\n`;
    if (item.eventTypes?.length > 0) context += `Event types: ${item.eventTypes.join(', ')}\n`;
    if (item.designNotes) context += `Design notes (from our team): ${item.designNotes}\n`;
    context += '\n' + extractStyleEssence(item.html) + '\n\n';
  });

  return context;
}

// The same SYSTEM_PROMPT used in generate-theme.js
const SYSTEM_PROMPT = `You are building a production-grade, single-file HTML event invite and RSVP page. This page must be visually extraordinary — better than Evite, Paperless Post, Canva, or any other existing provider. It should feel like it was designed by a top creative studio, not generated by AI.

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
    "googleFontsImport": "@import url('...')",
    "loadingPun": "A short, fun, on-theme pun shown while the RSVP is submitting"
  }
}

## CRITICAL DESIGN PHILOSOPHY
- This must be UNFORGETTABLE. Every spacing, shadow, border-radius, and animation timing must feel intentional and designed.
- Choose a clear aesthetic direction and execute it with total commitment.
- Bold maximalism and refined minimalism both work — the failure mode is neither.
- NEVER produce a generic or "bootstrap-looking" layout.
- Use unexpected moments: overlapping elements, asymmetric composition, color blocks that break the grid, type that surprises.

## TYPOGRAPHY RULES
- Source all fonts from Google Fonts only (include @import in googleFontsImport)
- Choose a BOLD, characterful display font that matches the event's emotional register
- Pair with a warm, readable body font — NEVER Inter, Roboto, Arial, or any system default
- Typography should do heavy creative lifting, not just label things
- Vary weight, scale, case, and tracking deliberately — type IS the design

## PAGE STRUCTURE
Build the page with these sections (creative freedom on visual execution):

1. **THEMATIC HEADER** — An animated or illustrated element specific to this event type.
2. **HERO SECTION** — Large display headline with event title/names/tagline. Photo treatment if photos provided.
3. **EVENT DETAILS** — Icon + text layout for date, time, location.
4. **RSVP SECTION** — \`.rsvp-slot\` with ONLY a styled \`<button class="rsvp-button">\`.

## REQUIRED DATA ATTRIBUTES
- \`data-field="title"\` — on the element containing the event title text
- \`data-field="datetime"\` — on the container with date/time information
- \`data-field="location"\` — on the container with location information
- \`data-field="dresscode"\` — on the container with dress code (omit if not specified)
- \`data-field="host"\` — on the element showing host name(s), if included

## ANIMATION RULES
- **Ambient background**: floating/falling elements on infinite loop, 0.1-0.2 opacity
- **Photo animations**: bobbing, subtle scale pulse, or soft glow
- **Entrance**: staggered fade-up on page load
- **Interactive**: hover states on all buttons
- **Decorative**: gentle sway or float on header decorations
- Use CSS only (no JavaScript).

## TECHNICAL CONSTRAINTS
- Max-width 393px (iPhone), centered, mobile-first
- Min 14px body, WCAG AA contrast ratios
- Generous padding (20-24px sides)
- RSVP button: min 48px height, prominent, high contrast
- CSS custom properties for all theme colors
- No JavaScript, no fixed positioning, no iframes
- NEVER put form inputs inside \`.rsvp-slot\`
- Keep height reasonable — 3-5 phone screen scrolls

## THANK YOU PAGE (theme_thankyou_html)
Provide ONLY .thankyou-page container with .thankyou-hero. NO calendar buttons, NO footer.

## TEXT CONTRAST — CRITICAL
- EVERY text element must have sufficient contrast (WCAG AA minimum)
- NEVER light text on light background or dark text on dark background`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden — admin access required' });

  const action = req.query?.action || req.body?.action || 'test';

  // ── AUTO-TAG: Analyze HTML and return suggested metadata ──
  if (action === 'autoTag') {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'html is required' });

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a design analyst for an event invitation platform. Analyze HTML invite samples and return structured metadata. Be specific and descriptive — your notes will guide an AI designer.

Return ONLY valid JSON with these keys:
{
  "name": "Short descriptive name (e.g. 'Elegant Magenta Quinceañera')",
  "description": "One-sentence summary of the overall design aesthetic",
  "eventTypes": ["array of matching event type keys"],
  "tags": ["array of 4-8 descriptive tags"],
  "designNotes": "2-3 sentences describing the specific design techniques, color palette, typography choices, animation patterns, and structural elements that make this design effective. Be concrete — mention specific CSS techniques, color values, font choices, SVG usage, animation types."
}

Valid event type keys: kidsBirthday, adultBirthday, babyShower, engagement, wedding, graduation, holiday, dinnerParty, retirement, anniversary, sports, bridalShower, corporate, other

Guidelines:
- eventTypes: Include ALL types this style could work for, not just the most obvious one. A formal gold+magenta design could work for quinceañera (kidsBirthday), adultBirthday, and graduation.
- tags: Include colors, style words, techniques (e.g. "SVG", "confetti", "gradient", "serif", "minimalist", "maximalist")
- designNotes: Focus on what the AI should LEARN from this sample. Mention specific CSS custom properties, animation keyframes, layout techniques, color palette strategy, and typography pairing.`,
        messages: [{
          role: 'user',
          content: `Analyze this HTML invite and return metadata:\n\n\`\`\`html\n${html.substring(0, 15000)}\n\`\`\``
        }]
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      let parsed;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        parsed = null;
      }

      if (!parsed) {
        return res.status(500).json({ error: 'Failed to parse auto-tag response' });
      }

      return res.status(200).json({
        success: true,
        autoTag: {
          name: parsed.name || '',
          description: parsed.description || '',
          eventTypes: Array.isArray(parsed.eventTypes) ? parsed.eventTypes : [],
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          designNotes: parsed.designNotes || ''
        },
        tokens: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        }
      });
    } catch (err) {
      console.error('Auto-tag error:', err);
      return res.status(500).json({ error: 'Auto-tag failed', message: err.message });
    }
  }

  // ── DUMMY DATA: Generate realistic test event details for a given event type ──
  if (action === 'dummyData') {
    const { eventType, typeLabel } = req.body;
    if (!eventType) return res.status(400).json({ error: 'eventType is required' });

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: `You generate realistic dummy event data for testing an event invitation platform. Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `Generate realistic test data for a "${typeLabel || eventType}" event. Return JSON with exactly these keys:
{
  "title": "Creative event title",
  "startDate": "2026-04-15T14:00",
  "endDate": "2026-04-15T17:00",
  "locationName": "Venue name",
  "locationAddress": "Full address with city, state, zip",
  "hostName": "Host name(s)",
  "dressCode": "Dress code",
  "tagline": "Short catchy tagline",
  "prompt": "2-3 sentence creative design direction describing the visual aesthetic, colors, and mood for the invite"
}
Use realistic names, venues, and addresses. Make the design prompt vivid and specific.`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const eventDetails = JSON.parse(jsonMatch[0]);
      return res.status(200).json({ success: true, eventDetails });
    } catch (err) {
      console.error('Dummy data generation error:', err);
      return res.status(500).json({ error: 'Failed to generate dummy data', message: err.message });
    }
  }

  // ── Shared: build prompt context (reused for single & multi-model) ──
  async function buildPromptContext(eventDetails, styleLibraryIds) {
    const eventType = eventDetails.eventType || 'other';
    const designDnaContext = buildEventTypeContext(eventType);

    // Load style library references — auto-select by event type + manual picks
    let styleContext = '';
    {
      const selected = [];
      const seenIds = new Set();

      if (styleLibraryIds && styleLibraryIds.length > 0) {
        const { data: manualData } = await supabaseAdmin
          .from('style_library')
          .select('*')
          .in('id', styleLibraryIds);
        for (const row of (manualData || [])) {
          selected.push({ name: row.name, description: row.description, html: row.html, eventTypes: row.event_types || [], designNotes: row.design_notes });
          seenIds.add(row.id);
        }
      }

      const { data: autoData } = await supabaseAdmin
        .from('style_library')
        .select('*')
        .contains('event_types', [eventType])
        .limit(2 + seenIds.size);
      for (const row of (autoData || [])) {
        if (selected.length >= (styleLibraryIds?.length || 0) + 2) break;
        if (seenIds.has(row.id)) continue;
        selected.push({ name: row.name, description: row.description, html: row.html, eventTypes: row.event_types || [], designNotes: row.design_notes });
        seenIds.add(row.id);
      }

      if (selected.length > 0) {
        styleContext = buildStyleContext(selected);
      }
    }

    const userMessage = `Create an invite theme for this event:

══════════════════════
EVENT CONTEXT
══════════════════════
- Event Type: ${eventType}
- Title: ${eventDetails.title}
- Start Date/Time: ${eventDetails.eventDate || 'Not specified'}
- End Date/Time: ${eventDetails.endDate || 'Not specified'}
- Location Name: ${eventDetails.locationName || 'Not specified'}
- Location Address: ${eventDetails.locationAddress || 'Not specified'}
- Dress Code: ${eventDetails.dressCode || 'Not specified'}
${eventDetails.hostName ? `- Hosted by: ${eventDetails.hostName}` : ''}
${eventDetails.tagline ? `- Tagline: "${eventDetails.tagline}"` : ''}

══════════════════════
DESIGN DIRECTION
══════════════════════
${eventDetails.prompt || `Create a beautiful invite for a ${eventType}`}
${designDnaContext}

══════════════════════
RSVP FORM
══════════════════════
The platform injects a fully functional RSVP form into the \`.rsvp-slot\` at runtime.
You MUST only place a styled \`<button class="rsvp-button">\` inside \`.rsvp-slot\`.
Make the button text fun and on-theme.

Fields that will be injected (for awareness only — do NOT render):
Default fields: Name, RSVP Status (Attending/Declined/Maybe)${styleContext}`;

    return userMessage;
  }

  // ── Shared: generate theme with one model ──
  async function generateWithModel(modelId, userMessage) {
    const startTime = Date.now();
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const latency = Date.now() - startTime;
    const contentBlock = response.content[0];
    let themeText = contentBlock.type === 'text' ? contentBlock.text : '';

    // Parse JSON response
    themeText = themeText.trim();
    const jsonBlockMatch = themeText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) themeText = jsonBlockMatch[1].trim();
    if (!themeText.startsWith('{')) {
      const firstBrace = themeText.indexOf('{');
      const lastBrace = themeText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) themeText = themeText.substring(firstBrace, lastBrace + 1);
    }

    let theme;
    try {
      theme = JSON.parse(themeText);
    } catch (parseErr) {
      let repaired = themeText;
      const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) repaired += '"';
      let braceDepth = 0, bracketDepth = 0, inString = false;
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
      throw new Error('Invalid theme response — missing theme_html or theme_css');
    }

    return {
      theme: {
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config || {},
        thankyouHtml: theme.theme_thankyou_html || ''
      },
      metadata: {
        model: modelId,
        latencyMs: latency,
        tokens: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        }
      }
    };
  }

  // ── TEST GENERATION (single or multi-model) ──
  const { model, models, eventDetails, styleLibraryIds } = req.body;
  const isMultiModel = Array.isArray(models) && models.length > 1;

  if (!eventDetails || (!model && !isMultiModel)) {
    return res.status(400).json({ error: 'eventDetails and model (or models array) are required' });
  }

  try {
    const userMessage = await buildPromptContext(eventDetails, styleLibraryIds);

    if (isMultiModel) {
      // Run all models in parallel
      const results = await Promise.allSettled(
        models.map(m => generateWithModel(m, userMessage))
      );

      const COST_PER_M_IN = { 'claude-haiku-4-5-20251001': 0.80, 'claude-sonnet-4-20250514': 3.00, 'claude-opus-4-20250514': 15.00 };
      const COST_PER_M_OUT = { 'claude-haiku-4-5-20251001': 4.00, 'claude-sonnet-4-20250514': 15.00, 'claude-opus-4-20250514': 75.00 };

      const outputs = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          const m = r.value.metadata;
          const estCost = (m.tokens.input * (COST_PER_M_IN[m.model] || 3) + m.tokens.output * (COST_PER_M_OUT[m.model] || 15)) / 1000000;
          return { success: true, ...r.value, estCost };
        } else {
          return { success: false, model: models[i], error: r.reason?.message || 'Generation failed' };
        }
      });

      return res.status(200).json({ success: true, multiModel: true, results: outputs });
    } else {
      // Single model
      const result = await generateWithModel(model, userMessage);
      return res.status(200).json({ success: true, ...result });
    }
  } catch (err) {
    console.error('Prompt test error:', err);
    return res.status(500).json({
      error: 'Test generation failed',
      message: err.message || 'Unknown error'
    });
  }
}
