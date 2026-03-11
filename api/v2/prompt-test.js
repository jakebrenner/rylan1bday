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
  kidsBirthday: { label: 'Kids Birthday (Ages 0-10)', must: { photoTreatment: 'If photos provided, use circular crops that feel playful. Faces should fill 80% of the frame.', technical: 'Keep all text large and readable. Bright, high-contrast colors.' }, consider: { decorative: 'VARY widely — pick ONE and commit: jungle safari with animals, outer space with planets/rockets, underwater ocean, dinosaur adventure, superhero comic-book, circus/carnival, construction zone, race cars, pirate treasure map, fairy tale castle, bug safari, robot/tech, wild west, ice cream parlor, monster mash, camping/outdoors. Avoid defaulting to rainbow/balloon/confetti.', typography: 'Bold, rounded display fonts (Fredoka One, Baloo 2, Lilita One, Bungee, Luckiest Guy). Match the specific theme — handwritten for crafty, blocky for construction, futuristic for space.', colorPhilosophy: 'Match the SPECIFIC theme — NOT just rainbow. Jungle: greens/browns. Space: deep navy/neon. Ocean: teals/corals. Dinosaur: earthy oranges/greens. Commit to 3-4 colors that tell the theme story.', motion: 'Theme-specific animations: floating stars for space, swimming fish for ocean, stomping dinos, flying rockets. Avoid generic confetti/balloons unless specifically requested.', standout: 'A bold illustrated hero element matching the theme — a rocket, a dinosaur, a treasure chest, a race car — NOT generic party decorations' } },
  adultBirthday: { label: 'Adult / Milestone Birthday', must: { photoTreatment: 'If photos provided, treat editorially — NOT kiddie circles.', technical: 'The milestone number should feature prominently.' }, consider: { decorative: 'Match the vibe — pick ONE: glamorous gold, retro 70s earth tones, neon 80s glow, minimalist modern, dark moody lounge, maximalist pattern clash, art deco geometric, tropical island, vintage speakeasy, disco funk, editorial magazine, rustic farmhouse, industrial loft.', typography: 'Era/mood-appropriate fonts (Playfair for elegance, Bebas Neue for bold, groovy retro for decade themes, editorial serif for magazine feel).', colorPhilosophy: '2-3 dominant colors with deliberate restraint OR excess. Avoid safe/generic palettes.', motion: 'Tone-appropriate motion: champagne bubble float, spotlight sweep, neon pulse, record-scratch for retro.', standout: 'The milestone number as a massive typographic hero element' } },
  babyShower: { label: 'Baby Shower / Sip & See', must: { photoTreatment: 'Gentle, warm treatment for any photos.', technical: 'Overall tone should feel nurturing and warm.' }, consider: { decorative: 'VARY widely — pick ONE: celestial night sky with moons/stars, woodland creatures (foxes, owls), hot air balloons in clouds, storybook illustration, modern geometric with soft shapes, tropical monstera, safari animals, vintage stork, nautical with anchors, honeybee garden, constellation map, paper airplane whimsy, origami animals. Avoid defaulting to generic floral/botanical/watercolor.', typography: 'Match the theme — modern sans for geometric, whimsical rounded for storybook, elegant script for celestial, handwritten for crafty.', colorPhilosophy: 'Go beyond pink/blue — sage and terracotta, navy and gold stars, warm mustard and cream, deep forest green and peach, lavender and mint. Soft does not mean pastel pink.', motion: 'Theme-matched gentle animations: twinkling stars, floating clouds, gentle leaf drift, origami unfolding.', standout: 'A charming illustrated centerpiece — crescent moon, woodland fox, hot air balloon, storybook cover' } },
  engagement: { label: 'Engagement Party', must: { photoTreatment: 'If couple photo provided, make it the hero.', technical: 'The couple\'s names should be prominently featured.' }, consider: { decorative: 'Floating rings, botanical elements, abstract ink strokes.', typography: 'Romantic script + modern sans. Names as typographic hero.', colorPhilosophy: 'Drawing from couple photo tones creates a personal feel.', motion: 'Hearts or sparkle particles floating.', standout: 'Couple photo with names in large display typography' } },
  wedding: { label: 'Wedding / Reception', must: { photoTreatment: 'If photos provided, most refined treatment — restraint and elegance.', technical: 'Every element should feel intentional and earned.' }, consider: { decorative: 'Minimal and intentional — botanical borders, geometric patterns.', typography: 'Distinguished pairings set the right tone.', colorPhilosophy: 'Restraint in color tends to elevate weddings.', motion: 'Subtle motion — slow fade-ins, gentle parallax.', standout: 'Couple names in breathtaking display typography' } },
  graduation: { label: 'Graduation Party', must: { photoTreatment: 'If photos provided, editorial but celebratory.', technical: 'Celebratory but not childish.' }, consider: { decorative: 'Falling diplomas, confetti mortarboards.', typography: 'Bold, confident display fonts.', colorPhilosophy: 'School colors as accent, bold celebratory palette.', motion: 'Paper toss animation feel. Mortarboards floating.', standout: 'Graduate name with massive milestone text' } },
  holiday: { label: 'Holiday Party', must: { photoTreatment: 'Match the specific holiday.', technical: 'Decorative elements should be holiday-SPECIFIC, not generic.' }, consider: { decorative: 'Holiday-specific atmospheric animations.', typography: 'Match the holiday emotional register.', colorPhilosophy: 'Holiday palette with a modern twist.', motion: 'Full atmospheric animation: snow, fireworks, leaves.', standout: 'Holiday-specific atmospheric animation' } },
  dinnerParty: { label: 'Dinner Party / Cocktail Hour', must: { photoTreatment: 'If provided, atmospheric with soft vignette.', technical: 'Adult, sophisticated. NO children\'s party elements.' }, consider: { decorative: 'Texture-first: linen, marble, dark wood, candlelight.', typography: 'Editorial pairing — unexpected but refined.', colorPhilosophy: 'Deep wines, warm golds, cream, charcoal.', motion: 'Minimal — slow reveals, candlelight flicker.', standout: 'Rich, textured background that sets mood' } },
  retirement: { label: 'Retirement Party', must: { photoTreatment: 'Prominent, respectful hero treatment.', technical: 'Avoid anything that reads as "old" or condescending.' }, consider: { decorative: 'Achievement badges, timeline elements.', typography: 'Authoritative and warm serif or display font.', colorPhilosophy: 'Distinguished: navy/gold, deep green/cream.', motion: 'Meaningful and measured entrance animations.', standout: 'Years-of-service counter or career timeline' } },
  anniversary: { label: 'Anniversary Party', must: { photoTreatment: 'If two photos provided, "then and now" treatment is powerful.', technical: 'Milestone year number should feature prominently.' }, consider: { decorative: 'Romantic but not saccharine. Gold accents.', typography: 'Romantic but confident and warm.', colorPhilosophy: 'Gold/warm neutrals for milestone years.', motion: 'Gentle sparkle, elegant fade-in choreography.', standout: 'Then and now photo treatment or milestone number' } },
  sports: { label: 'Sports / Watch Party', must: { photoTreatment: 'If photos provided, team gear / action shots.', technical: 'High energy. Bold. Dynamic, not gentle.' }, consider: { decorative: 'Dynamic: stadium lights, score-ticker aesthetic.', typography: 'Bold, condensed, athletic display fonts.', colorPhilosophy: 'Team colors with maximum energy.', motion: 'Stadium light sweep, scoreboard-style reveals.', standout: 'Stadium scoreboard header with team colors' } },
  bridalShower: { label: 'Bridal Shower', must: { photoTreatment: 'If photos provided, elegant treatment of bride.', technical: 'Elegant and celebratory. NEVER clipart-style elements.' }, consider: { decorative: 'VARY the aesthetic — pick ONE: lush hand-illustrated botanicals, art deco geometric arches, modern minimalist with bold type, Mediterranean tile patterns, French patisserie, garden party toile, bohemian desert with cacti, coastal with shells, Parisian café, champagne brunch editorial, citrus grove, vintage lace and pearls.', typography: 'Match the aesthetic — elegant script for classic, bold sans for modern, serif for editorial, handwritten for bohemian.', colorPhilosophy: 'Go beyond blush — terracotta/olive for boho, navy/gold for art deco, citrus yellows/greens for garden, mauve/burgundy for moody, coral/teal for coastal.', motion: 'Subtle and elegant — floating petals, gentle shimmer, soft parallax.', standout: 'Distinctive visual matching theme — ornate arch, champagne tower, lemon wreath, delicate lace border' } },
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

function buildEventTypeContext(eventType, userPrompt, designDnaOverride) {
  const dnaSource = designDnaOverride || DESIGN_DNA;
  const dna = dnaSource[eventType] || dnaSource.other || DESIGN_DNA.other;
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

// Weighted random selection: admin_rating acts as a weight multiplier
// Rating 5 = 5x weight, Rating 1 = 1x, Unrated = 2x (neutral)
function weightedStylePick(items, count) {
  if (items.length <= count) return items;
  const weighted = items.map(item => ({
    item,
    weight: item.admin_rating || 2
  }));
  const selected = [];
  const remaining = [...weighted];
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const totalWeight = remaining.reduce((sum, w) => sum + w.weight, 0);
    let rand = Math.random() * totalWeight;
    let pick = remaining[0];
    for (const w of remaining) {
      rand -= w.weight;
      if (rand <= 0) { pick = w; break; }
    }
    selected.push(pick.item);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return selected;
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

// ═══════════════════════════════════════════════════════════════════
// STRUCTURAL RULES — Platform contract. Same as generate-theme.js.
// These ensure the output works with Ryvite's runtime.
// ═══════════════════════════════════════════════════════════════════
const STRUCTURAL_RULES = `## OUTPUT FORMAT — MANDATORY
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

## PAGE STRUCTURE — REQUIRED SECTIONS
1. **THEMATIC HEADER** — An animated or illustrated element specific to this event type.
2. **HERO SECTION** — Large display headline with event title/names/tagline.
3. **EVENT DETAILS** — Icon + text layout for date, time, location.
4. **RSVP SECTION** — \`<div class="rsvp-slot"><button class="rsvp-button">...</button></div>\`. The rsvp-slot MUST contain ONLY the button.

## RSVP BUTTON — CRITICAL PLATFORM RULES
- Full-width (width: 100% or min 280px), min-height: 56px, generous padding (16px 32px)
- Centered text via flexbox, 16-18px bold, appearance:none, explicit styling
- NEVER put form inputs/selects/labels inside \`.rsvp-slot\` — ONLY the button

## RSVP FORM LAYOUT — CRITICAL (platform injects form at runtime)
- The platform replaces the \`.rsvp-slot\` contents with form fields (name, status, custom fields) + the button
- The injected form MUST render as a **single column** — NEVER two-column, grid, or side-by-side inputs
- Style \`.rsvp-slot\` with: \`display: flex; flex-direction: column; width: 100%;\`
- NEVER set \`.rsvp-slot\` to \`display: grid\`, \`flex-direction: row\`, or \`flex-wrap: wrap\` with side-by-side children
- All inputs inside \`.rsvp-slot\` must be full-width (width: 100%) — no 50% widths, no multi-column layouts

## REQUIRED DATA ATTRIBUTES
- \`data-field="title"\` \`data-field="datetime"\` \`data-field="location"\` \`data-field="dresscode"\` \`data-field="host"\`

## TECHNICAL CONSTRAINTS — NON-NEGOTIABLE
- Max-width 393px, centered, mobile-first. Min 14px body, WCAG AA contrast.
- **TOP SAFE AREA**: The page MUST have at least 48px of padding-top on the outermost container to clear the iPhone notch/Dynamic Island. Content behind the notch is invisible — never place text, logos, or illustrations in the top 48px.
- Generous padding (20-24px sides). CSS custom properties for theme colors.
- No JavaScript. No fixed positioning. No iframes. Google Fonts only.
- Keep height reasonable — 3-5 phone screen scrolls.

## THANK YOU PAGE (theme_thankyou_html)
Provide ONLY .thankyou-page > .thankyou-hero. NO calendar buttons, NO footer. Include \`<span class="thankyou-guest">Guest</span>\` in subtitle.

## TEXT CONTRAST — CRITICAL, NEVER VIOLATE
- EVERY piece of text must have sufficient contrast against its background (WCAG AA minimum)
- NEVER put light text on light backgrounds or dark text on dark backgrounds
- When using background images or gradients, add a semi-transparent overlay or text-shadow
- Button text MUST contrast against the button background color

### CONCRETE CONTRAST RULES FOR EACH SECTION:
- **Event details band** (date, time, location): If the band background is dark (green, navy, black, charcoal, etc.), the text color MUST be white or very light. If the band is light, text MUST be dark. NEVER use a warm/muted color like coral, salmon, or rose on a dark background — it will be unreadable.
- **Hero section**: If the background is dark or uses a dark gradient, title and subtitle text MUST be white/cream/very light.
- **RSVP section**: Button text must be white on dark buttons or dark on light buttons. No exceptions.
- **SIMPLE RULE**: For ANY section with a colored/dark background, set the text color to #FFFFFF or #FAFAFA. For any section with a light/white background, set text to #1A1A1A or darker. Do NOT try to match text color to theme accent colors on dark backgrounds — it almost always fails contrast.`;

// Default creative direction — the editable layer
const DEFAULT_CREATIVE_DIRECTION = `You are a world-class invite designer. Create a single-file HTML invite page that feels like it was made by a boutique design studio — not a template generator.

When the user gives minimal input, that is creative freedom. Make bold decisions. Pick a strong visual direction, commit to it.

## DESIGN PHILOSOPHY
- UNFORGETTABLE. Every spacing, shadow, border-radius, animation timing must feel intentional.
- Bold maximalism and refined minimalism both work — the failure mode is neither.
- NEVER produce a generic or "bootstrap-looking" layout.

## TYPOGRAPHY
- BOLD, characterful display font matching the event's emotional register
- Warm, readable body font — NEVER Inter, Roboto, Arial, or system defaults
- Typography IS the design — vary weight, scale, case, tracking deliberately

## COLOR
- One color dominates 60%+. Maximum 2 accent colors.
- Background never plain white — use texture, gradient, or tint.

## ANIMATION — EVERY INVITE SHOULD FEEL ALIVE
- Ambient background: theme-specific moving elements, 0.1-0.2 opacity (match the theme — stars for space, fish for ocean, snow for winter, etc.)
- Entrance: staggered fade-up (0.1s increments)
- Hover states on all buttons
- CSS only, transform + opacity for performance

## WHAT KILLS A GOOD INVITE — NEVER DO THESE
- System fonts, purple gradients on white, evenly-weighted elements
- Generic rainbow/balloon/confetti as the default — pick a SPECIFIC theme instead
- No animations, light text on light backgrounds
- Playing it safe on a vague brief — be bold and specific
- Defaulting to the same aesthetic every time — be unpredictable and varied`;

const SYSTEM_PROMPT = STRUCTURAL_RULES + '\n\n' + DEFAULT_CREATIVE_DIRECTION;

// ═══════════════════════════════════════════════════════════════════
// ROBUST THEME RESPONSE PARSER
// Handles: proper JSON, markdown-fenced JSON, full HTML documents,
// CSS-first responses, truncated JSON, camelCase/snake_case keys
// ═══════════════════════════════════════════════════════════════════
function parseThemeResponse(rawText) {
  let text = rawText.trim();

  // Step 1: Check if the response is a full HTML document (not JSON at all)
  // Some models return <!DOCTYPE html>... instead of JSON
  if (text.match(/^<!DOCTYPE/i) || text.match(/^<html/i)) {
    return extractThemeFromHtmlDoc(text);
  }

  // Step 2: Strip markdown code fences
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) text = jsonBlockMatch[1].trim();

  // Step 3: If still not starting with {, or starts with CSS variables, look for actual JSON
  if (!text.startsWith('{') || text.match(/^\{\s*--/)) {
    // Look for JSON-like object start patterns
    const jsonStart = text.match(/\{\s*"(?:theme_|html|css|config)/);
    if (jsonStart) {
      const startIdx = text.indexOf(jsonStart[0]);
      let depth = 0, inStr = false, lastBrace = -1;
      for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && (i === 0 || text[i-1] !== '\\')) inStr = !inStr;
        if (!inStr) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { lastBrace = i; break; } } }
      }
      text = lastBrace !== -1 ? text.substring(startIdx, lastBrace + 1) : text.substring(startIdx);
    } else if (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<body')) {
      const htmlMatch = text.match(/<(!DOCTYPE[\s\S]*|html[\s\S]*)<\/html>/i);
      if (htmlMatch) return extractThemeFromHtmlDoc(htmlMatch[0]);
    } else if (text.match(/^\{\s*--/) || text.match(/^\s*:root\s*\{/)) {
      // Model returned raw CSS (possibly followed by HTML). Try to assemble a theme.
      // Look for HTML content after the CSS
      const htmlStart = text.match(/<(div|section|main|header|article)\b/i);
      if (htmlStart) {
        const htmlIdx = text.indexOf(htmlStart[0]);
        const cssBlock = text.substring(0, htmlIdx).trim();
        const htmlBlock = text.substring(htmlIdx).trim();
        return { theme_html: htmlBlock, theme_css: cssBlock, theme_config: {}, theme_thankyou_html: '' };
      }
      // Pure CSS with no HTML — wrap in a style tag and try extractThemeFromHtmlDoc
      if (text.includes('.') && text.includes('{')) {
        return { theme_html: '', theme_css: text, theme_config: {}, theme_thankyou_html: '' };
      }
    }
  }

  // Step 4: Try to parse as JSON
  let theme;
  try {
    theme = JSON.parse(text);
  } catch (parseErr) {
    // Step 5: Repair common JSON issues
    let repaired = text;
    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');
    // Close unclosed strings
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';
    // Close unclosed braces/brackets
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
      // Step 6: Last resort — try to extract HTML/CSS from the raw text
      if (rawText.includes('<div') || rawText.includes('<section') || rawText.includes('<style')) {
        return extractThemeFromHtmlDoc(rawText);
      }
      // If the raw text contains CSS selectors and HTML elements, try to split them
      const htmlTag = rawText.match(/<(div|section|main|header|article)\b/i);
      if (htmlTag) {
        const idx = rawText.indexOf(htmlTag[0]);
        const css = rawText.substring(0, idx).trim();
        const html = rawText.substring(idx).trim();
        if (html.length > 100) {
          return { theme_html: html, theme_css: css, theme_config: {}, theme_thankyou_html: '' };
        }
      }
      throw new Error('Failed to parse theme JSON: ' + parseErr.message + ' | First 300 chars: ' + text.substring(0, 300));
    }
  }

  // Step 7: Normalize keys (accept snake_case, camelCase, shorthand)
  return normalizeThemeKeys(theme);
}

// Extract theme from a raw HTML document the model returned instead of JSON
function extractThemeFromHtmlDoc(html) {
  let css = '';
  let body = html;
  let config = {};

  // Extract all <style> tag contents
  const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleMatches) {
    css = styleMatches.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
    body = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  // Extract <link> Google Fonts
  const linkMatch = html.match(/<link[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/i);
  if (linkMatch) {
    config.googleFontsImport = "@import url('" + linkMatch[1] + "');";
  }

  // Extract @import from CSS
  if (!config.googleFontsImport) {
    const importMatch = css.match(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/);
    if (importMatch) {
      config.googleFontsImport = "@import url('" + importMatch[1] + "');";
      css = css.replace(/@import\s+url\([^)]+\);?\s*/g, '');
    }
  }

  // Strip HTML document wrapper, keep only body content
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1].trim();
  // Remove <head>, <html>, <!DOCTYPE> tags if still present
  body = body.replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<\/?(html|head|!doctype)[^>]*>/gi, '').trim();
  // Remove <link> and <meta> tags from body
  body = body.replace(/<(link|meta)[^>]*>/gi, '');

  if (!body && !css) {
    throw new Error('Invalid theme response — could not extract HTML or CSS from response');
  }

  return { theme_html: body, theme_css: css, theme_config: config, theme_thankyou_html: '' };
}

// Normalize theme keys and extract embedded CSS/fonts
function normalizeThemeKeys(theme) {
  // Accept snake_case, camelCase, and shorthand keys
  if (!theme.theme_html && theme.html) theme.theme_html = theme.html;
  if (!theme.theme_html && theme.themeHtml) theme.theme_html = theme.themeHtml;
  if (!theme.theme_css && theme.css) theme.theme_css = theme.css;
  if (!theme.theme_css && theme.themeCss) theme.theme_css = theme.themeCss;
  if (!theme.theme_config && theme.config) theme.theme_config = theme.config;
  if (!theme.theme_config && theme.themeConfig) theme.theme_config = theme.themeConfig;
  if (!theme.theme_thankyou_html && theme.thankyou_html) theme.theme_thankyou_html = theme.thankyou_html;
  if (!theme.theme_thankyou_html && theme.thankyouHtml) theme.theme_thankyou_html = theme.thankyouHtml;

  // Fix double-escaped quotes in HTML/CSS (models sometimes output \" inside JSON string values)
  // These appear as literal backslash-quote in the parsed string, breaking SVG attributes etc.
  if (theme.theme_html && theme.theme_html.includes('\\"')) {
    theme.theme_html = theme.theme_html.replace(/\\"/g, '"');
  }
  if (theme.theme_css && theme.theme_css.includes('\\"')) {
    theme.theme_css = theme.theme_css.replace(/\\"/g, '"');
  }
  if (theme.theme_thankyou_html && theme.theme_thankyou_html.includes('\\"')) {
    theme.theme_thankyou_html = theme.theme_thankyou_html.replace(/\\"/g, '"');
  }

  // If CSS is missing but embedded in HTML <style> tags, extract it
  if (theme.theme_html && !theme.theme_css) {
    const styleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleMatch) {
      theme.theme_css = styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
      theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    }
  }

  // If HTML is a full document, extract body content and head styles
  if (theme.theme_html && (theme.theme_html.includes('<!DOCTYPE') || theme.theme_html.includes('<html'))) {
    if (!theme.theme_css) {
      const headStyleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (headStyleMatch) {
        theme.theme_css = headStyleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
      }
    }
    const bodyMatch = theme.theme_html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) theme.theme_html = bodyMatch[1].trim();
  }

  if (!theme.theme_css) theme.theme_css = '';
  if (!theme.theme_config) theme.theme_config = {};

  // Extract Google Fonts @import from CSS into config if missing
  if (!theme.theme_config.googleFontsImport) {
    const fontImportMatch = (theme.theme_css || '').match(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/);
    if (fontImportMatch) {
      theme.theme_config.googleFontsImport = "@import url('" + fontImportMatch[1] + "');";
      theme.theme_css = theme.theme_css.replace(/@import\s+url\([^)]+\);?\s*/g, '');
    }
  }

  if (!theme.theme_html) {
    const keys = Object.keys(theme).join(', ');
    throw new Error('Invalid theme response — missing theme_html. Got keys: [' + keys + ']. First 200 chars: ' + JSON.stringify(theme).substring(0, 200));
  }

  return theme;
}

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
      // Build a seed for diversity so repeated calls get different results
      const diversitySeed = Math.floor(Math.random() * 10000);
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: `You generate fictional dummy event data for testing an event invitation platform. Return ONLY valid JSON.

CRITICAL RULES:
- Use ENTIRELY FICTIONAL names, venues, and addresses. Never use real people's names or information.
- Vary the cultural backgrounds of names (mix of Asian, African, Latin, European, Middle Eastern, etc.)
- Vary geographic locations across different US cities and regions
- For the design "prompt" field: be HIGHLY SPECIFIC and DIVERSE. Avoid overused themes like "garden party", "botanical", "rainbow", "floral watercolor". Instead think: art deco, retro 70s, maximalist patterns, minimalist Scandinavian, Afrofuturist, vaporwave, brutalist, paper-cut art, ceramic tile, woodblock print, neon noir, stained glass, mosaic, etc.
- Each generation should feel completely different from typical event invites`,
        messages: [{
          role: 'user',
          content: `Generate creative, fictional test data for a "${typeLabel || eventType}" event. Seed for variety: ${diversitySeed}. Return JSON with exactly these keys:
{
  "title": "Creative event title",
  "startDate": "2026-04-15T14:00",
  "endDate": "2026-04-15T17:00",
  "locationName": "Fictional venue name",
  "locationAddress": "Fictional full address with city, state, zip",
  "hostName": "Fictional host name(s)",
  "dressCode": "Dress code",
  "tagline": "Short catchy tagline",
  "prompt": "2-3 sentence SPECIFIC and UNIQUE creative design direction. Avoid generic themes like garden/botanical/rainbow/watercolor. Be bold and distinctive."
}
All names and details must be entirely fictional. Make the design prompt vivid, specific, and unlike typical event invites.`
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
  async function buildPromptContext(eventDetails, styleLibraryIds, designDnaOverride) {
    const eventType = eventDetails.eventType || 'other';
    const userPrompt = eventDetails.prompt || '';
    const promptSpecificity = assessPromptSpecificity(userPrompt);
    const dnaSource = designDnaOverride || DESIGN_DNA;
    const designDnaContext = buildEventTypeContext(eventType, userPrompt, dnaSource);

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

      // Fetch more candidates than needed for weighted selection by admin_rating
      const fetchLimit = Math.max((autoRefLimit + seenIds.size) * 3, 6);
      let autoRes = await supabaseAdmin
        .from('style_library')
        .select('*')
        .contains('event_types', [eventType])
        .is('archived_at', null)
        .order('admin_rating', { ascending: false, nullsFirst: false })
        .limit(fetchLimit);
      // Fallback if admin_rating or archived_at column doesn't exist yet (migration not run)
      if (autoRes.error) {
        autoRes = await supabaseAdmin
          .from('style_library')
          .select('*')
          .contains('event_types', [eventType])
          .limit(fetchLimit);
      }
      const autoData = autoRes.data;
      // Filter out already-selected, then weighted pick
      const candidates = (autoData || []).filter(row => !seenIds.has(row.id));
      const autoPicks = weightedStylePick(candidates, autoRefLimit);
      for (const row of autoPicks) {
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
Default fields: Name, RSVP Status (Attending/Declined/Maybe)${styleContext}

══════════════════════
⚠️ FINAL CHECK — TEXT CONTRAST (NON-NEGOTIABLE)
══════════════════════
Before outputting, mentally walk through EVERY text element and verify:
1. Dark/colored background sections (navy, green, black, charcoal, etc.) → text MUST be #FFFFFF or #FAFAFA
2. Light background sections → text MUST be #1A1A1A or darker
3. Buttons → text color must contrast against the button's background color
4. NEVER use accent colors (coral, salmon, rose, gold, etc.) as text on dark backgrounds — they FAIL contrast
5. The "Party Details" / event info band is the #1 failure point — if its background is dark, ALL text inside MUST be white
This is the most common failure mode. Double-check it.`;

    return userMessage;
  }

  // ── Shared: generate theme with one model ──
  async function generateWithModel(modelId, userMessage, systemPromptOverride) {
    const startTime = Date.now();
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 16384,
      system: systemPromptOverride || SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const latency = Date.now() - startTime;
    const contentBlock = response.content[0];
    let themeText = contentBlock.type === 'text' ? contentBlock.text : '';

    // ── Parse AI response into theme object ──
    let theme = parseThemeResponse(themeText);

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

3. **Typography & Contrast** (critical): Ensure all text is readable (min 14px body, WCAG AA contrast). Fix any text that blends into the background. CONCRETE RULE: dark/colored background sections → text MUST be #FFFFFF or #FAFAFA. Light backgrounds → text MUST be #1A1A1A or darker. The event details band (date/time/location) is the #1 failure point — check it first. NEVER use accent colors (coral, salmon, rose) as text on dark backgrounds.

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

    let theme = parseThemeResponse(themeText);

    return {
      theme: {
        html: theme.theme_html,
        css: theme.theme_css || '',
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
  const { model, models, eventDetails, styleLibraryIds, hybrid, promptVersionId } = req.body;
  const isMultiModel = Array.isArray(models) && models.length > 1;

  if (!eventDetails || (!model && !isMultiModel && !hybrid)) {
    return res.status(400).json({ error: 'eventDetails and model (or models array, or hybrid) are required' });
  }

  try {
    // Load a specific prompt version if requested, otherwise use hardcoded defaults
    let activeSystemPrompt = SYSTEM_PROMPT;
    let activeDesignDna = DESIGN_DNA;
    let usedPromptVersionId = null;

    if (promptVersionId) {
      const { data: pv } = await supabaseAdmin
        .from('prompt_versions')
        .select('id, creative_direction, design_dna, version, name')
        .eq('id', promptVersionId)
        .single();

      if (pv?.creative_direction) {
        activeSystemPrompt = STRUCTURAL_RULES + '\n\n' + pv.creative_direction;
        if (typeof pv.design_dna === 'object' && Object.keys(pv.design_dna).length > 0) {
          activeDesignDna = pv.design_dna;
        }
        usedPromptVersionId = pv.id;
      }
    }

    const userMessage = await buildPromptContext(eventDetails, styleLibraryIds, activeDesignDna);

    // ── HYBRID MODE: draft with cheap model, refine with better model ──
    if (hybrid) {
      const draftModel = hybrid.draftModel || 'claude-haiku-4-5-20251001';
      const refineModel = hybrid.refineModel || 'claude-sonnet-4-6';

      // Step 1: Generate draft
      const draftResult = await generateWithModel(draftModel, userMessage, activeSystemPrompt);

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
        models.map(m => generateWithModel(m, userMessage, activeSystemPrompt))
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

      return res.status(200).json({ success: true, multiModel: true, results: outputs, promptVersionId: usedPromptVersionId });
    } else {
      // Single model
      const result = await generateWithModel(model, userMessage, activeSystemPrompt);
      return res.status(200).json({ success: true, ...result, promptVersionId: usedPromptVersionId });
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
