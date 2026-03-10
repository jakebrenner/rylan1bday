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

// ── Event-type design DNA injected into the generation prompt ──
// Each entry has "must" (technique/structure guidance) and "consider" (aesthetic suggestions the model can override)
const DESIGN_DNA = {
  kidsBirthday: {
    label: 'Kids Birthday (Ages 0-10)',
    must: {
      photoTreatment: 'If photos provided, use circular crops that feel playful. Faces should fill 80% of the frame.',
      technical: 'Keep all text large and readable. Bright, high-contrast colors.'
    },
    consider: {
      decorative: 'Animated floating balloons, confetti bursts, bunting flags, or theme-specific elements (stars for space, leaves for jungle, etc.)',
      typography: 'Bold, rounded display fonts work well (e.g. Fredoka One, Baloo 2, Lilita One). Pair with a warm readable body font.',
      colorPhilosophy: 'Joyful and vibrant palettes with fully saturated colors tend to work best. 4-5 colors is a good range.',
      motion: 'Consider floating/falling elements on infinite loop at 0.1-0.2 opacity. Staggered fade-up entrance. Confetti burst energy near the RSVP section.',
      standout: 'Kid faces with playful decorations (birthday hats, party elements) make a strong visual anchor'
    }
  },
  adultBirthday: {
    label: 'Adult / Milestone Birthday',
    must: {
      photoTreatment: 'If photos provided, treat editorially — NOT kiddie circles. Sophisticated framing.',
      technical: 'The milestone number (30, 40, 50) should feature prominently as a design element.'
    },
    consider: {
      decorative: 'Atmospheric texture matching the era/tone — floating gold particles for glamour, grain for retro, neon glow for 80s, disco balls for 70s.',
      typography: 'Era-appropriate or bold editorial fonts add strong personality (Playfair Display for elegance, Bebas Neue for bold, groovy retro for decade themes).',
      colorPhilosophy: '2-3 dominant colors with deliberate restraint OR deliberate excess — both can work when committed fully.',
      motion: 'Consider tone-appropriate motion: champagne bubble float for glamour, spotlight sweep for milestone, record-scratch for retro.',
      standout: 'The milestone number as a massive typographic hero element'
    }
  },
  babyShower: {
    label: 'Baby Shower / Sip & See',
    must: {
      photoTreatment: 'Gentle, warm treatment for any photos. Soft framing, never harsh crops.',
      technical: 'Overall tone should feel nurturing and soft.'
    },
    consider: {
      decorative: 'Watercolor wash backgrounds, botanical illustrations, pressed flowers, baby animals, or abstract organic shapes all work well.',
      typography: 'Elegant script paired with refined serif (e.g. Cormorant Garamond + a flowing script) sets the right tone.',
      colorPhilosophy: 'Soft, limited palettes tend to work best (2-3 colors + cream/white). Blue/navy/mint for boy themes, blush/rose/lavender for girl themes.',
      motion: 'Gentle petal/leaf fall rather than confetti. Slow, dreamy fade-ins. Botanical elements with subtle sway.',
      standout: 'Floral wreath or botanical frame around the baby name or event title'
    }
  },
  engagement: {
    label: 'Engagement Party',
    must: {
      photoTreatment: 'If couple photo provided, make it the hero. This is about them.',
      technical: 'The couple\'s names should be prominently featured.'
    },
    consider: {
      decorative: 'Floating rings, botanical elements, abstract ink strokes, or soft gradient meshes derived from photo tones.',
      typography: 'Romantic script + modern sans, or bold serif editorial pairing. Names as typographic hero.',
      colorPhilosophy: 'Drawing palette from the couple\'s photo tones creates a personal feel. Otherwise romantic palettes work.',
      motion: 'Hearts or sparkle particles floating. Gentle parallax feel. Elegant entrance choreography.',
      standout: 'The couple\'s photo with names in large, overlapping display typography'
    }
  },
  wedding: {
    label: 'Wedding / Reception',
    must: {
      photoTreatment: 'If photos provided, most refined treatment — restraint and elegance.',
      technical: 'This is the most refined event type. Every element should feel intentional and earned.'
    },
    consider: {
      decorative: 'Minimal and intentional works best — botanical borders for garden, geometric for art deco, delicate line art for modern.',
      typography: 'Distinguished pairings set the right tone (e.g. Cormorant Garamond + Jost, or luxury serif).',
      colorPhilosophy: 'Restraint in color tends to elevate weddings. Classic: ivory/gold. Modern: moody/architectural. Boho: earthy/organic.',
      motion: 'Subtle motion — slow fade-ins, gentle parallax. Rose petals or gold particles can work on the thank-you page.',
      standout: 'The couple\'s names in breathtaking display typography'
    }
  },
  graduation: {
    label: 'Graduation Party',
    must: {
      photoTreatment: 'If photos provided, editorial but celebratory. Mix formal and fun.',
      technical: 'Celebratory but not childish — this is an achievement.'
    },
    consider: {
      decorative: 'Falling diplomas, confetti mortarboards, achievement-themed motifs convey the right energy.',
      typography: 'Bold, confident display fonts — achievement-forward, not kiddie.',
      colorPhilosophy: 'School colors as accent if provided, otherwise bold celebratory palette.',
      motion: 'Paper toss animation feel. Mortarboards floating. Celebratory but controlled.',
      standout: 'The graduate\'s name with massive milestone text (Class of 2026)'
    }
  },
  holiday: {
    label: 'Holiday Party',
    must: {
      photoTreatment: 'Match the specific holiday. Christmas/NYE: atmospheric. Halloween: fun themed borders.',
      technical: 'Decorative elements should be holiday-SPECIFIC, not generic party imagery.'
    },
    consider: {
      decorative: 'Holiday-specific atmospheric animations — snowfall for Christmas, falling leaves for Thanksgiving, fireworks for NYE, bats for Halloween.',
      typography: 'Match the holiday emotional register — cozy serif for Christmas, bold slab for Halloween, elegant script for NYE.',
      colorPhilosophy: 'Holiday palette executed with a TWIST — avoid cliché execution even with classic colors. Make it feel fresh.',
      motion: 'Full atmospheric animation: snow falling, fireworks bursting, leaves drifting, sparkle twinkling.',
      standout: 'The holiday-specific atmospheric animation that makes the page feel alive'
    }
  },
  dinnerParty: {
    label: 'Dinner Party / Cocktail Hour',
    must: {
      photoTreatment: 'If provided, atmospheric with soft vignette. Or skip — typography and texture can carry this.',
      technical: 'This is an adult, sophisticated event. NO children\'s party elements whatsoever.'
    },
    consider: {
      decorative: 'Texture-first approaches work well: linen, marble, dark wood, candlelight grain, wine stain watercolor.',
      typography: 'Editorial pairing — unexpected but refined (bold grotesque headline + elegant thin body).',
      colorPhilosophy: 'Sophisticated palettes: deep wines, warm golds, cream, charcoal. Or bright and convivial. Texture is as important as color.',
      motion: 'Minimal and purposeful — slow reveals, candlelight flicker effect. Quiet luxury.',
      standout: 'Rich, textured background that sets an atmospheric mood'
    }
  },
  retirement: {
    label: 'Retirement Party',
    must: {
      photoTreatment: 'Prominent, respectful hero treatment — this person has earned it.',
      technical: 'Avoid anything that reads as "old" or condescending.'
    },
    consider: {
      decorative: 'Achievement badges, timeline elements, distinguished decorative borders.',
      typography: 'Authoritative and warm — strong serif or distinguished display font.',
      colorPhilosophy: 'Distinguished palettes: navy/gold, deep green/cream, warm sophisticated tones.',
      motion: 'Meaningful and measured — elegant particle effects, career milestone reveals.',
      standout: 'Years-of-service counter or career timeline as a design element'
    }
  },
  anniversary: {
    label: 'Anniversary Party',
    must: {
      photoTreatment: 'If two photos provided, "then and now" treatment is powerful.',
      technical: 'The milestone year number should feature prominently.'
    },
    consider: {
      decorative: 'Romantic but not saccharine. Gold accents for milestone years. Timeline elements, photo frames.',
      typography: 'Romantic but confident and warm — not overly scripty. Anniversary number can be a massive typographic element.',
      colorPhilosophy: 'Drawing from couple\'s photo tones, or gold/warm neutrals for milestone years.',
      motion: 'Gentle sparkle, floating hearts (tastefully), elegant fade-in choreography.',
      standout: 'The "then and now" photo treatment or massive milestone year number'
    }
  },
  sports: {
    label: 'Sports / Watch Party',
    must: {
      photoTreatment: 'If photos provided, team gear / action shots with team color treatment.',
      technical: 'High energy. Bold. This should feel dynamic, not gentle.'
    },
    consider: {
      decorative: 'Dynamic motion: stadium lights, crowd noise visualization, score-ticker aesthetic, sport-specific iconography.',
      typography: 'Sports-forward — bold, condensed, athletic display fonts. Stadium scoreboard aesthetic.',
      colorPhilosophy: 'Team colors executed with maximum energy. High contrast, bold.',
      motion: 'Stadium light sweep, scoreboard-style reveals, dynamic entrance.',
      standout: 'Stadium scoreboard header with team colors'
    }
  },
  bridalShower: {
    label: 'Bridal Shower',
    must: {
      photoTreatment: 'If photos provided, elegant treatment of bride or engagement photo.',
      technical: 'Floral elements should be beautiful and lush, NEVER clipart-style.'
    },
    consider: {
      decorative: 'Abundant floral illustration elements with garden party energy.',
      typography: 'Script + elegant sans or serif. Bride\'s name as the typographic star.',
      colorPhilosophy: 'Blush, champagne, sage, and cream palettes work beautifully. Or bride\'s wedding colors if specified.',
      motion: 'Floating petals, gentle botanical sway, elegant fade-in sequence.',
      standout: 'Lush, hand-illustrated-style floral elements framing the design'
    }
  },
  corporate: {
    label: 'Corporate Event',
    must: {
      photoTreatment: 'Brand-aligned, clean, professional.',
      technical: 'Professional but not boring. No playful floating elements.'
    },
    consider: {
      decorative: 'Geometric patterns, subtle gradients. Branded without being a brochure.',
      typography: 'Clean, modern sans-serif pairing with personality.',
      colorPhilosophy: 'Brand colors if specified, otherwise sophisticated neutral + one accent.',
      motion: 'Subtle, professional entrance animations.',
      standout: 'Clean, modern design that feels premium and intentional'
    }
  },
  other: {
    label: 'Custom Event',
    must: {
      photoTreatment: 'Style based on the event description.',
      technical: 'Let the user\'s creative direction guide all decisions.'
    },
    consider: {
      decorative: 'Match the event mood and description.',
      typography: 'Choose fonts that match the event\'s emotional register.',
      colorPhilosophy: 'Derived from the creative direction. Commit fully.',
      motion: 'Match the energy level of the event.',
      standout: 'Whatever makes this specific event feel special and unforgettable'
    }
  }
};

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
    "loadingPun": "A short, fun, on-theme pun shown while the RSVP is submitting (e.g., 'Grabbing your party hat...', 'Saving you a seat...', 'Polishing the dance floor...')"
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

1. **THEMATIC HEADER** — An animated or illustrated element specific to this event type. Must feel DESIGNED for this event, not generic.
2. **HERO SECTION** — Large display headline with event title/names/tagline. Photo treatment if photos provided. All entrance animations staggered.
3. **EVENT DETAILS** — Icon + text layout for date, time, location. Clear hierarchy, memorable presentation. Can be a high-contrast band, floating card, or creative strip.
4. **RSVP SECTION** — \`<div class="rsvp-slot"><button class="rsvp-button">...</button></div>\`. The rsvp-slot MUST contain ONLY the button — the platform injects the real form at runtime. Make the button text fun and on-theme.

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

## REQUIRED DATA ATTRIBUTES (for platform dynamic content updates)
- \`data-field="title"\` — on the element containing the event title text
- \`data-field="datetime"\` — on the container with date/time information
- \`data-field="location"\` — on the container with location information
- \`data-field="dresscode"\` — on the container with dress code (omit entirely if not specified)
- \`data-field="host"\` — on the element showing host name(s), if included

## ANIMATION RULES — EVERY INVITE SHOULD FEEL ALIVE
- **Ambient background**: floating/falling elements specific to event type on infinite loop, varied speeds, 0.1-0.2 opacity — atmospheric, not distracting
- **Photo animations**: bobbing for kids parties, subtle scale pulse for editorial, soft glow for romantic
- **Entrance**: staggered fade-up on page load (animation-delay: 0.1s increments) — choreographed reveal
- **Interactive**: hover states on all buttons with smooth transitions
- **Decorative**: gentle sway or float on header decorations
- Use CSS only (no JavaScript). Use transform and opacity for smooth performance.

## PHOTO HANDLING
If photos are provided via URL, use them in \`<img>\` tags with the exact URL provided.
- Photos should ANCHOR the design, not just decorate it
- Always crop/frame with intention — a face at 80% of the circle is more powerful than 40%
- Style with border-radius, box-shadow, border, or creative framing per the event type
- If photos are bad quality, the treatment should save them (overlay, vignette, color grade via CSS filter)

## TECHNICAL CONSTRAINTS
- Max-width 393px (iPhone), centered, mobile-first — 90% of guests view on phones
- Text must be readable: min 14px body, WCAG AA contrast ratios (4.5:1 body, 3:1 headings)
- Generous padding (20-24px sides) — content never touches edges
- RSVP button: min 48px height, prominent, high contrast, with hover states
- Use CSS gradients, SVGs, shapes, and emoji for decorative visuals — NO external image URLs (except user-uploaded photos)
- CSS custom properties for all theme colors
- No JavaScript in the output
- No fixed positioning, no iframes
- NEVER put form inputs/selects/labels inside \`.rsvp-slot\`
- Keep height reasonable — fits in ~3-5 phone screen scrolls
- Semantic HTML with aria-labels on interactive elements

## THANK YOU PAGE (theme_thankyou_html)

The thank you page appears after RSVP. Same CSS (theme_css) applies to both invite and thank you page.

**IMPORTANT**: The platform automatically injects calendar buttons and footer. You ONLY provide the page container with the hero content. Do NOT include calendar buttons, footer, or "Made with" text — they will be added automatically.

### REQUIRED STRUCTURE — provide EXACTLY this, nothing more:
\`\`\`html
<div class="thankyou-page">
  <!-- Decorative background elements reused from invite (optional) -->
  <div class="thankyou-hero">
    <h1 class="thankyou-title">Thank You!</h1>
    <p class="thankyou-subtitle"><span class="thankyou-guest">Guest</span>, we can't wait to celebrate with you!</p>
  </div>
  <!-- STOP HERE — calendar buttons and footer are injected by the platform -->
</div>
\`\`\`

### Rules:
- NO emojis anywhere in the thank you page
- NO calendar buttons, NO footer — the platform handles these
- NO extra sections (dress code, bullet lists, event details, etc.)
- The heading can be creative but short (e.g., "Thank You!", "You're In!", "See You There!")
- The subtitle must include \`<span class="thankyou-guest">Guest</span>\` placeholder
- Style .thankyou-page with same background treatment as the invite
- Style .thankyou-title with the invite's display font and themed color
- Include these CSS rules in theme_css:

\`\`\`css
.thankyou-page {
  max-width: 393px; margin: 0 auto; padding: 60px 32px 40px;
  min-height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center;
}
.thankyou-hero { margin-bottom: 32px; }
.thankyou-title { font-size: 36px; font-weight: 700; margin-bottom: 12px; }
.thankyou-subtitle { font-size: 16px; line-height: 1.5; opacity: 0.8; }
\`\`\`

## TEXT CONTRAST — CRITICAL, NEVER VIOLATE
- EVERY piece of text must have sufficient contrast against its background (WCAG AA minimum: 4.5:1 for body text, 3:1 for large headings)
- NEVER put light text on a light background or dark text on a dark background
- NEVER put white/cream text on pastel or light-colored backgrounds
- NEVER put dark text on dark/saturated backgrounds
- When using background images or gradients, add a semi-transparent overlay or text-shadow to ensure readability
- Test mentally: "Can I read this text clearly?" for EVERY text element against its actual background
- Button text MUST contrast against the button background color
- This applies to the invite AND the thank you page equally

## WHAT KILLS A GOOD INVITE
- Using Inter, Roboto, or system fonts
- Purple gradients on white backgrounds
- Evenly spaced, equal-weight visual elements
- Generic "party balloons" clipart as the only decoration
- A form that looks like a Google Form
- No animations — the page should feel alive
- Leaving calendar buttons as unstyled defaults
- Light text on light backgrounds or dark text on dark backgrounds — UNACCEPTABLE
- Emojis in the thank you page buttons or footer

## INSPIRATION IMAGES
If provided, analyze them for color palette, visual mood, textures, typography style, and overall aesthetic. Use as strong creative direction.`;

// Extract CSS and structural summary from style library HTML to reduce token usage
function extractStyleEssence(html) {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = styleMatch ? styleMatch[1].trim() : '';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const classNames = [...new Set((body.match(/class="([^"]+)"/g) || []).map(m => m.replace(/class="(.+)"/, '$1')))];
  const sections = [];
  const sectionRegex = /<(div|section|header|main|footer|nav)\s[^>]*class="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = sectionRegex.exec(body)) !== null) {
    sections.push(`<${match[1]} class="${match[2]}">`);
  }
  const fontImports = (html.match(/@import\s+url\([^)]+\)/g) || []).join('\n');
  const fontLinks = (html.match(/<link[^>]*fonts\.googleapis[^>]*>/g) || []).join('\n');
  let summary = '';
  if (fontImports || fontLinks) summary += `Fonts:\n${fontImports}\n${fontLinks}\n\n`;
  if (sections.length > 0) summary += `Structure:\n${sections.join('\n')}\n\n`;
  if (classNames.length > 0) summary += `Classes: ${classNames.join(', ')}\n\n`;
  if (css) summary += `CSS:\n\`\`\`css\n${css}\n\`\`\``;
  return summary;
}

function buildStyleContext(selected, promptSpecificity) {
  const isHighSpecificity = promptSpecificity >= 0.5;
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

// Load style references matching event type from the library
// When user has strong creative direction, load only 1 reference (for technique) instead of 2
async function loadStyleReferences(eventType, promptSpecificity = 0) {
  try {
    const limit = promptSpecificity >= 0.5 ? 1 : 2;
    const { data } = await supabase
      .from('style_library')
      .select('*')
      .contains('event_types', [eventType])
      .limit(limit);
    if (!data || data.length === 0) return '';
    const matched = data.map(row => ({
      name: row.name, description: row.description, html: row.html,
      eventTypes: row.event_types || [], designNotes: row.design_notes
    }));
    return buildStyleContext(matched, promptSpecificity);
  } catch {
    return '';
  }
}

// Assess how specific the user's creative prompt is (0-1 score)
// Higher = more specific direction, less DNA needed
function assessPromptSpecificity(prompt) {
  if (!prompt || prompt.length < 20) return 0;
  let score = 0;
  const lower = prompt.toLowerCase();
  // Length: longer prompts are typically more specific
  if (prompt.length > 50) score += 0.15;
  if (prompt.length > 100) score += 0.15;
  if (prompt.length > 200) score += 0.1;
  // Color mentions
  if (/\b(color|palette|tone|hue|shade|red|blue|green|gold|pink|black|white|navy|blush|coral|teal|purple|orange|yellow|cream|ivory|sage|mint|lavender|burgundy|maroon|pastel|neon|muted|warm|cool|earth|jewel)\b/i.test(lower)) score += 0.15;
  // Typography mentions
  if (/\b(font|type|typeface|serif|sans|script|bold|italic|handwritten|calligraphy|monospace|display|editorial|elegant|playful|modern|retro|vintage|classic)\b/i.test(lower)) score += 0.1;
  // Aesthetic/mood mentions
  if (/\b(minimalist|maximalist|luxur|bohemian|boho|rustic|industrial|art deco|mid-century|scandinavian|tropical|whimsical|gothic|preppy|coastal|farmhouse|glam|chic|moody|atmospheric|ethereal|grunge|punk|disco|psychedelic|vaporwave|cottagecore)\b/i.test(lower)) score += 0.15;
  // Specific visual references
  if (/\b(gradient|texture|marble|linen|wood|grain|watercolor|illustration|geometric|organic|pattern|stripe|polka|floral|botanical|abstract)\b/i.test(lower)) score += 0.1;
  // Animation mentions
  if (/\b(animat|motion|float|fade|slide|glow|shimmer|sparkle|confetti|snow|rain|particle|parallax|pulse|bounce|spin)\b/i.test(lower)) score += 0.1;
  return Math.min(score, 1);
}

// Build event-type-specific context for the generation prompt
// Adapts DNA intensity based on how specific the user's creative direction is
function buildEventTypeContext(eventType, userPrompt) {
  const dna = DESIGN_DNA[eventType] || DESIGN_DNA.other;
  const specificity = assessPromptSpecificity(userPrompt);

  // "must" items are always included — these are structural/technical requirements
  let context = `\n## EVENT-TYPE GUIDANCE (${dna.label})`;
  context += `\n\n### Requirements:`;
  context += `\n- **Photo treatment**: ${dna.must.photoTreatment}`;
  context += `\n- **Technical**: ${dna.must.technical}`;

  if (specificity >= 0.5) {
    // User has strong creative direction — give them the wheel
    context += `\n\n### Suggestions (the user has a clear creative vision — prioritize THEIR direction over these):`;
  } else if (specificity >= 0.25) {
    // User has some direction — blend
    context += `\n\n### Suggestions (blend these with the user's creative direction):`;
  } else {
    // User gave minimal direction — lean on DNA
    context += `\n\n### Design direction (use these as your primary creative guide):`;
  }

  context += `\n- **Decorative elements**: ${dna.consider.decorative}`;
  context += `\n- **Typography**: ${dna.consider.typography}`;
  context += `\n- **Color philosophy**: ${dna.consider.colorPhilosophy}`;
  context += `\n- **Animation/Motion**: ${dna.consider.motion}`;
  context += `\n- **Standout visual element**: ${dna.consider.standout}`;

  return context;
}

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
  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages, tweakInstructions, currentHtml, currentCss, currentConfig, photoBase64, photoUrl, photoUrls } = req.body;

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

      // Handle multiple photos (new) or single photo (legacy)
      const allPhotoUrls = photoUrls?.length > 0 ? photoUrls : (photoUrl ? [photoUrl] : []);
      if (allPhotoUrls.length > 0) {
        tweakMessage += `\n\nThe user has uploaded ${allPhotoUrls.length} photo(s) they want incorporated into the design. Use these EXACT URLs in <img> tags:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\nPlace the photos prominently in the design where they make sense. Style with appropriate sizing (max-width: 100%), border-radius, and any CSS that fits the theme. For multiple photos, consider a creative layout (row, grid, overlapping, staggered).`;
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

      const tweakSystemPrompt = `You are an elite invite designer modifying event invites via a conversational chat interface. Your modifications should maintain the extraordinary quality standard — better than Evite, Paperless Post, or Canva.

## YOUR ROLE
Users will ask you to update their invite design — visual changes AND event content changes. Users may:
- Add or update location, address, dress code, host, or other event details
- Add or modify RSVP form fields (dietary restrictions, plus-ones, song requests, etc.)
- Change colors, fonts, backgrounds, layout, spacing
- Add photos, decorative elements, or completely change the style
- Ask for more/less animation, different mood, etc.

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

### Data attributes (REQUIRED — always preserve):
- \`data-field="title"\` — on the event title element
- \`data-field="datetime"\` — on date/time container
- \`data-field="location"\` — on location container
- \`data-field="dresscode"\` — on dress code container
- \`data-field="host"\` — on host name element (if present)

### RSVP form section:
- \`.rsvp-slot\` MUST contain ONLY a \`<button class="rsvp-button">\` — NO form inputs, labels, or fields
- The platform injects the real RSVP form at runtime
- When users mention RSVP fields, acknowledge in chat_response but do NOT add form inputs

### Design rules:
- Max-width 393px, mobile-first, WCAG AA contrast
- Google Fonts only (include @import in theme_config.googleFontsImport)
- NEVER use Inter, Roboto, Arial, or system fonts — always characterful fonts
- No JavaScript, no external images (except Google Fonts and user-uploaded photos)
- Make minimal changes — only what the user asked for, keep everything else exactly the same
- Preserve and enhance CSS animations — every invite should feel alive with entrance animations, ambient motion, and hover effects
- Thank you page: ONLY provide .thankyou-page container with .thankyou-hero (.thankyou-title + .thankyou-subtitle with .thankyou-guest span). NO calendar buttons, NO footer — the platform injects those automatically. NO emojis. Match invite's background/fonts. Style .thankyou-page, .thankyou-hero, .thankyou-title, .thankyou-subtitle in CSS.
- TEXT CONTRAST: EVERY text element must be clearly readable against its background. Never light-on-light or dark-on-dark. Buttons must have contrasting text. This is non-negotiable.
- For photo additions: use the EXACT URL(s) provided in <img> tags. Style with creative framing per the event type.`;

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
  const eventType = eventDetails.eventType || 'other';

  // Rate limiting: 100 per hour per user
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
    let rsvpFieldsDesc = 'Default fields: Name, RSVP Status (Attending/Declined/Maybe)';
    if (rsvpFields?.length > 0) {
      rsvpFieldsDesc += '\nCustom fields: ' + rsvpFields.map(f => `${f.label} (${f.field_type}${f.is_required ? ', required' : ''})`).join(', ');
    }

    // Assess how specific the user's creative direction is
    const promptSpecificity = assessPromptSpecificity(effectivePrompt);

    // Build event-type-specific design DNA context (adapts to prompt specificity)
    const designDnaContext = buildEventTypeContext(eventType, effectivePrompt);

    // Collect all photo URLs (from initial upload or design chat)
    const allPhotoUrls = photoUrls?.length > 0 ? photoUrls : (photoUrl ? [photoUrl] : []);

    // User's creative direction comes FIRST and is clearly marked as the primary directive
    let userMessage = `Create an invite theme for this event:

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
${effectivePrompt}
${designDnaContext}

══════════════════════
RSVP FORM
══════════════════════
The platform injects a fully functional RSVP form into the \`.rsvp-slot\` at runtime.
You MUST only place a styled \`<button class="rsvp-button">\` inside \`.rsvp-slot\`. NO form inputs.
Make the button text fun and on-theme (e.g., "Count Me In!", "I'll Be There!", "Let's Party!").

Fields that will be injected (for awareness only — do NOT render):
${rsvpFieldsDesc}`;

    // Auto-include style references matching event type (adapts to prompt specificity)
    const styleRefContext = await loadStyleReferences(eventType, promptSpecificity);
    if (styleRefContext) {
      userMessage += styleRefContext;
    }

    // Add photo URLs if user uploaded photos
    if (allPhotoUrls.length > 0) {
      userMessage += `\n\n══════════════════════\nPHOTOS\n══════════════════════\n${allPhotoUrls.length} photo(s) provided. Use these EXACT URLs in <img> tags:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\n\nApply the photo treatment described in the design DNA above. Style with appropriate sizing, border-radius, box-shadow, and creative framing.`;
    }

    if (feedback) {
      userMessage += `\n\n**Feedback on previous version (incorporate this):**\n${feedback}`;
    }

    if (inspirationImages?.length > 0) {
      userMessage += `\n\n**Visual Inspiration:** I've provided ${inspirationImages.length} image(s) as inspiration. Analyze for color palette, mood, textures, and typography cues.`;
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
      max_tokens: 16384,
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
