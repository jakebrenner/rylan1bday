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
// Each entry has "must" (technique/structure) and "consider" (aesthetic suggestions the model can override)
const DESIGN_DNA = {
  kidsBirthday: { label: 'Kids Birthday (Ages 0-10)', must: { photoTreatment: 'If photos provided, use circular crops that feel playful. Faces should fill 80% of the frame.', technical: 'Keep all text large and readable. Bright, high-contrast colors.' }, consider: { decorative: 'Animated floating balloons, confetti bursts, bunting flags, or theme-specific elements.', typography: 'Bold, rounded display fonts work well (e.g. Fredoka One, Baloo 2, Lilita One).', colorPhilosophy: 'Joyful and vibrant palettes with fully saturated colors tend to work best.', motion: 'Consider floating/falling elements on infinite loop at 0.1-0.2 opacity.', standout: 'Kid faces with playful decorations make a strong visual anchor' } },
  adultBirthday: { label: 'Adult / Milestone Birthday', must: { photoTreatment: 'If photos provided, treat editorially — NOT kiddie circles.', technical: 'The milestone number should feature prominently.' }, consider: { decorative: 'Atmospheric texture matching the era/tone.', typography: 'Era-appropriate or bold editorial fonts add strong personality.', colorPhilosophy: '2-3 dominant colors with deliberate restraint OR excess.', motion: 'Tone-appropriate motion: champagne bubble float, spotlight sweep.', standout: 'The milestone number as a massive typographic hero element' } },
  babyShower: { label: 'Baby Shower / Sip & See', must: { photoTreatment: 'Gentle, warm treatment for any photos.', technical: 'Overall tone should feel nurturing and soft.' }, consider: { decorative: 'Watercolor wash backgrounds, botanical illustrations, pressed flowers.', typography: 'Elegant script paired with refined serif.', colorPhilosophy: 'Soft, limited palettes (2-3 colors + cream/white).', motion: 'Gentle petal/leaf fall, slow dreamy fade-ins.', standout: 'Floral wreath or botanical frame around the baby name' } },
  engagement: { label: 'Engagement Party', must: { photoTreatment: 'If couple photo provided, make it the hero.', technical: 'The couple\'s names should be prominently featured.' }, consider: { decorative: 'Floating rings, botanical elements, abstract ink strokes.', typography: 'Romantic script + modern sans. Names as typographic hero.', colorPhilosophy: 'Drawing from couple photo tones creates a personal feel.', motion: 'Hearts or sparkle particles floating.', standout: 'Couple photo with names in large display typography' } },
  wedding: { label: 'Wedding / Reception', must: { photoTreatment: 'If photos provided, most refined treatment — restraint and elegance.', technical: 'Every element should feel intentional and earned.' }, consider: { decorative: 'Minimal and intentional — botanical borders, geometric patterns.', typography: 'Distinguished pairings set the right tone.', colorPhilosophy: 'Restraint in color tends to elevate weddings.', motion: 'Subtle motion — slow fade-ins, gentle parallax.', standout: 'Couple names in breathtaking display typography' } },
  graduation: { label: 'Graduation Party', must: { photoTreatment: 'If photos provided, editorial but celebratory.', technical: 'Celebratory but not childish.' }, consider: { decorative: 'Falling diplomas, confetti mortarboards.', typography: 'Bold, confident display fonts.', colorPhilosophy: 'School colors as accent, bold celebratory palette.', motion: 'Paper toss animation feel. Mortarboards floating.', standout: 'Graduate name with massive milestone text' } },
  holiday: { label: 'Holiday Party', must: { photoTreatment: 'Match the specific holiday.', technical: 'Decorative elements should be holiday-SPECIFIC, not generic.' }, consider: { decorative: 'Holiday-specific atmospheric animations.', typography: 'Match the holiday emotional register.', colorPhilosophy: 'Holiday palette with a modern twist.', motion: 'Full atmospheric animation: snow, fireworks, leaves.', standout: 'Holiday-specific atmospheric animation' } },
  dinnerParty: { label: 'Dinner Party / Cocktail Hour', must: { photoTreatment: 'If provided, atmospheric with soft vignette.', technical: 'Adult, sophisticated. NO children\'s party elements.' }, consider: { decorative: 'Texture-first: linen, marble, dark wood, candlelight.', typography: 'Editorial pairing — unexpected but refined.', colorPhilosophy: 'Deep wines, warm golds, cream, charcoal.', motion: 'Minimal — slow reveals, candlelight flicker.', standout: 'Rich, textured background that sets mood' } },
  retirement: { label: 'Retirement Party', must: { photoTreatment: 'Prominent, respectful hero treatment.', technical: 'Avoid anything that reads as "old" or condescending.' }, consider: { decorative: 'Achievement badges, timeline elements.', typography: 'Authoritative and warm serif or display font.', colorPhilosophy: 'Distinguished: navy/gold, deep green/cream.', motion: 'Meaningful and measured entrance animations.', standout: 'Years-of-service counter or career timeline' } },
  anniversary: { label: 'Anniversary Party', must: { photoTreatment: 'If two photos provided, "then and now" treatment is powerful.', technical: 'Milestone year number should feature prominently.' }, consider: { decorative: 'Romantic but not saccharine. Gold accents.', typography: 'Romantic but confident and warm.', colorPhilosophy: 'Gold/warm neutrals for milestone years.', motion: 'Gentle sparkle, elegant fade-in choreography.', standout: 'Then and now photo treatment or milestone number' } },
  sports: { label: 'Sports / Watch Party', must: { photoTreatment: 'If photos provided, team gear / action shots.', technical: 'High energy. Bold. Dynamic, not gentle.' }, consider: { decorative: 'Dynamic: stadium lights, score-ticker aesthetic.', typography: 'Bold, condensed, athletic display fonts.', colorPhilosophy: 'Team colors with maximum energy.', motion: 'Stadium light sweep, scoreboard-style reveals.', standout: 'Stadium scoreboard header with team colors' } },
  bridalShower: { label: 'Bridal Shower', must: { photoTreatment: 'If photos provided, elegant treatment of bride.', technical: 'Floral elements should be beautiful, NEVER clipart-style.' }, consider: { decorative: 'Abundant floral illustration elements.', typography: 'Script + elegant sans or serif.', colorPhilosophy: 'Blush, champagne, sage, and cream.', motion: 'Floating petals, gentle botanical sway.', standout: 'Lush, hand-illustrated-style floral elements' } },
  corporate: { label: 'Corporate Event', must: { photoTreatment: 'Brand-aligned, clean, professional.', technical: 'Professional but not boring. No playful floating elements.' }, consider: { decorative: 'Geometric patterns, subtle gradients.', typography: 'Clean, modern sans-serif pairing.', colorPhilosophy: 'Brand colors or sophisticated neutral + accent.', motion: 'Subtle, professional entrance animations.', standout: 'Clean, modern premium design' } },
  other: { label: 'Custom Event', must: { photoTreatment: 'Style based on the event description.', technical: 'Let the user\'s creative direction guide all decisions.' }, consider: { decorative: 'Match the event mood.', typography: 'Fonts matching event emotional register.', colorPhilosophy: 'Derived from the creative direction.', motion: 'Match the energy level of the event.', standout: 'Whatever makes this event feel special' } }
};

// Assess how specific the user's creative prompt is (0-1 score)
function assessPromptSpecificity(prompt) {
  if (!prompt || prompt.length < 20) return 0;
  let score = 0;
  const lower = prompt.toLowerCase();
  if (prompt.length > 50) score += 0.15;
  if (prompt.length > 100) score += 0.15;
  if (prompt.length > 200) score += 0.1;
  if (/\b(color|palette|tone|hue|shade|red|blue|green|gold|pink|black|white|navy|blush|coral|teal|purple|orange|yellow|cream|ivory|sage|mint|lavender|burgundy|maroon|pastel|neon|muted|warm|cool|earth|jewel)\b/i.test(lower)) score += 0.15;
  if (/\b(font|type|typeface|serif|sans|script|bold|italic|handwritten|calligraphy|monospace|display|editorial|elegant|playful|modern|retro|vintage|classic)\b/i.test(lower)) score += 0.1;
  if (/\b(minimalist|maximalist|luxur|bohemian|boho|rustic|industrial|art deco|mid-century|scandinavian|tropical|whimsical|gothic|preppy|coastal|farmhouse|glam|chic|moody|atmospheric|ethereal|grunge|punk|disco|psychedelic|vaporwave|cottagecore)\b/i.test(lower)) score += 0.15;
  if (/\b(gradient|texture|marble|linen|wood|grain|watercolor|illustration|geometric|organic|pattern|stripe|polka|floral|botanical|abstract)\b/i.test(lower)) score += 0.1;
  if (/\b(animat|motion|float|fade|slide|glow|shimmer|sparkle|confetti|snow|rain|particle|parallax|pulse|bounce|spin)\b/i.test(lower)) score += 0.1;
  return Math.min(score, 1);
}

function buildEventTypeContext(eventType, userPrompt) {
  const dna = DESIGN_DNA[eventType] || DESIGN_DNA.other;
  const specificity = assessPromptSpecificity(userPrompt);

  let context = `\n## EVENT-TYPE GUIDANCE (${dna.label})`;
  context += `\n\n### Requirements:`;
  context += `\n- **Photo treatment**: ${dna.must.photoTreatment}`;
  context += `\n- **Technical**: ${dna.must.technical}`;

  if (specificity >= 0.5) {
    context += `\n\n### Suggestions (the user has a clear creative vision — prioritize THEIR direction over these):`;
  } else if (specificity >= 0.25) {
    context += `\n\n### Suggestions (blend these with the user's creative direction):`;
  } else {
    context += `\n\n### Design direction (use these as your primary creative guide):`;
  }

  context += `\n- **Decorative elements**: ${dna.consider.decorative}`;
  context += `\n- **Typography**: ${dna.consider.typography}`;
  context += `\n- **Color philosophy**: ${dna.consider.colorPhilosophy}`;
  context += `\n- **Animation/Motion**: ${dna.consider.motion}`;
  context += `\n- **Standout visual element**: ${dna.consider.standout}`;
  return context;
}

// Extract CSS and structural summary from HTML to reduce token usage (~60% savings)
function extractStyleEssence(html) {
  if (!html) return '';
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
function buildStyleContext(selected, promptSpecificity) {
  const isHighSpecificity = (promptSpecificity || 0) >= 0.5;
  const framing = isHighSpecificity
    ? 'The following are design references for technical patterns (CSS techniques, animation approaches, structural layout). Borrow techniques freely, but follow the user\'s creative direction for aesthetics, colors, and mood — do NOT let these references override their vision.'
    : 'The following are design references we admire. Study the CSS patterns, color palettes, typography choices, animation techniques, and structural approaches. Use them as creative inspiration — adapt to the user\'s direction, do NOT copy verbatim.';
  let context = `\n\n## STYLE REFERENCE LIBRARY\n${framing}\n\n`;

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

## RSVP BUTTON — CRITICAL STYLING RULES
The RSVP button is the most important interactive element on the page. It MUST look polished and intentional:
- Full-width within its container (width: 100% or at least 280px) — NEVER let it shrink to fit text
- Min-height: 56px with generous padding (16px 32px minimum)
- Border-radius that matches the overall design language (8-16px for modern, 28px+ for pill shape)
- Clear, high-contrast text that is perfectly centered — use flexbox (display:flex; align-items:center; justify-content:center)
- Font-size: 16-18px, bold/semibold, with optional letter-spacing for elegance
- NEVER use default browser button styling — always set appearance:none, explicit background, color, border
- Smooth hover transition (transform scale 1.02-1.05, subtle shadow lift, or color shift)
- The button must feel like the CLIMAX of the page — the visual payoff of scrolling through the invite
- Text should be fun and on-theme (e.g., "Count Me In!", "Let's Celebrate!", "I'll Be There!")
- NEVER overflow, clip, or break layout — test mentally that the button works at 393px viewport width

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
    const userPrompt = eventDetails.prompt || '';
    const promptSpecificity = assessPromptSpecificity(userPrompt);
    const designDnaContext = buildEventTypeContext(eventType, userPrompt);

    // Load style library references — auto-select by event type + manual picks
    // High-specificity prompts get fewer auto refs (1 vs 2) to avoid overriding user vision
    const autoRefLimit = promptSpecificity >= 0.5 ? 1 : 2;
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
        .limit(autoRefLimit + seenIds.size);
      for (const row of (autoData || [])) {
        if (selected.length >= (styleLibraryIds?.length || 0) + autoRefLimit) break;
        if (seenIds.has(row.id)) continue;
        selected.push({ name: row.name, description: row.description, html: row.html, eventTypes: row.event_types || [], designNotes: row.design_notes });
        seenIds.add(row.id);
      }

      if (selected.length > 0) {
        styleContext = buildStyleContext(selected, promptSpecificity);
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
CREATIVE DIRECTION FROM THE USER (this is the PRIMARY design brief — honor it)
══════════════════════
${userPrompt || `Create a beautiful invite for a ${eventType}`}
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

  // ── HYBRID REFINEMENT: take a draft and polish it with a better model ──
  const REFINE_PROMPT = `You are a senior UI designer reviewing and polishing an AI-generated HTML event invitation. You will receive the complete draft (HTML, CSS, config, thank-you page) and must return an IMPROVED version.

## YOUR TASK
Fix visual issues and polish the design. Focus on:

1. **RSVP BUTTON** (highest priority):
   - Must be full-width (width:100% or min 280px), min-height 56px, generous padding (16px 32px)
   - Perfectly centered text using display:flex; align-items:center; justify-content:center
   - High contrast, explicit background/color/border (no default browser styling)
   - Font-size 16-18px, bold, with hover transition
   - Must NOT overflow, clip, or break layout at 393px viewport

2. **Layout & spacing**: Fix any elements that overlap, clip, or overflow the 393px container. Ensure generous padding (20-24px sides).

3. **Typography**: Ensure all text is readable (min 14px body, WCAG AA contrast). Fix any text that blends into the background.

4. **Overall polish**: Smooth any rough edges — inconsistent border-radius, misaligned elements, awkward spacing.

## RULES
- Keep the original creative direction, color palette, fonts, and overall aesthetic — you are POLISHING, not redesigning
- Return the same JSON format with theme_html, theme_css, theme_thankyou_html, theme_config
- Do NOT add JavaScript
- Do NOT add form inputs inside .rsvp-slot — it should contain ONLY the button
- Preserve all data-field attributes and class names
- Keep animations and decorative elements intact

## OUTPUT FORMAT
Return a JSON object with exactly these keys:
{
  "theme_html": "...",
  "theme_css": "...",
  "theme_thankyou_html": "...",
  "theme_config": { ... }
}`;

  async function refineWithModel(refineModelId, draftResult) {
    const startTime = Date.now();
    const draftJson = JSON.stringify({
      theme_html: draftResult.theme.html,
      theme_css: draftResult.theme.css,
      theme_thankyou_html: draftResult.theme.thankyouHtml,
      theme_config: draftResult.theme.config
    });

    const response = await client.messages.create({
      model: refineModelId,
      max_tokens: 16384,
      system: REFINE_PROMPT,
      messages: [{ role: 'user', content: `Here is the draft invite to polish:\n\n\`\`\`json\n${draftJson}\n\`\`\`` }]
    });

    const latency = Date.now() - startTime;
    const contentBlock = response.content[0];
    let themeText = contentBlock.type === 'text' ? contentBlock.text : '';

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
        throw new Error('Failed to parse refined theme JSON: ' + parseErr.message);
      }
    }

    if (!theme.theme_html || !theme.theme_css) {
      throw new Error('Invalid refined theme — missing theme_html or theme_css');
    }

    return {
      theme: {
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config || draftResult.theme.config,
        thankyouHtml: theme.theme_thankyou_html || draftResult.theme.thankyouHtml
      },
      metadata: {
        model: refineModelId,
        latencyMs: latency,
        tokens: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        }
      }
    };
  }

  // ── TEST GENERATION (single, multi-model, or hybrid) ──
  const { model, models, eventDetails, styleLibraryIds, hybrid } = req.body;
  const isMultiModel = Array.isArray(models) && models.length > 1;

  if (!eventDetails || (!model && !isMultiModel && !hybrid)) {
    return res.status(400).json({ error: 'eventDetails and model (or models array, or hybrid) are required' });
  }

  try {
    const userMessage = await buildPromptContext(eventDetails, styleLibraryIds);

    // ── HYBRID MODE: draft with cheap model, refine with better model ──
    if (hybrid) {
      const draftModel = hybrid.draftModel || 'claude-haiku-4-5-20251001';
      const refineModel = hybrid.refineModel || 'claude-sonnet-4-6';

      // Step 1: Generate draft
      const draftResult = await generateWithModel(draftModel, userMessage);

      // Step 2: Refine with better model (fallback to draft if refine fails)
      let refinedResult;
      let refineFailed = false;
      try {
        refinedResult = await refineWithModel(refineModel, draftResult);
      } catch (refineErr) {
        console.error('Hybrid refine step failed, falling back to draft:', refineErr.message);
        refinedResult = draftResult;
        refineFailed = true;
      }

      // Combine metadata
      const totalLatency = draftResult.metadata.latencyMs + (refinedResult.metadata.latencyMs || 0);
      const totalInputTokens = draftResult.metadata.tokens.input + (refineFailed ? 0 : refinedResult.metadata.tokens.input);
      const totalOutputTokens = draftResult.metadata.tokens.output + (refineFailed ? 0 : refinedResult.metadata.tokens.output);

      return res.status(200).json({
        success: true,
        theme: refinedResult.theme,
        metadata: {
          model: `${draftModel} → ${refineModel}`,
          latencyMs: totalLatency,
          tokens: { input: totalInputTokens, output: totalOutputTokens },
          hybrid: {
            draft: { model: draftModel, latencyMs: draftResult.metadata.latencyMs, tokens: draftResult.metadata.tokens },
            refine: refineFailed
              ? { model: refineModel, failed: true, latencyMs: 0, tokens: { input: 0, output: 0 } }
              : { model: refineModel, latencyMs: refinedResult.metadata.latencyMs, tokens: refinedResult.metadata.tokens }
          },
          ...(refineFailed ? { warning: 'Refine step failed — showing draft only' } : {})
        }
      });
    }

    if (isMultiModel) {
      // Run all models in parallel
      const results = await Promise.allSettled(
        models.map(m => generateWithModel(m, userMessage))
      );

      const COST_PER_M_IN = { 'claude-haiku-4-5-20251001': 0.80, 'claude-sonnet-4-6': 3.00, 'claude-opus-4-6': 15.00 };
      const COST_PER_M_OUT = { 'claude-haiku-4-5-20251001': 4.00, 'claude-sonnet-4-6': 15.00, 'claude-opus-4-6': 75.00 };

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
      message: err.message || 'Unknown error',
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
  }
}
