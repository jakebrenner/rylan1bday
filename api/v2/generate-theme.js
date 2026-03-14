import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkAndChargeAiUsage } from './billing.js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-6';

// Allow up to 300s on Vercel Pro (caps at 60s on Hobby)
export const config = { maxDuration: 300 };

// AI model pricing per 1M tokens — must match billing.js, chat.js, ratings.js, admin.js
// Source: https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

function calcGenerationCost(model, inputTokens, outputTokens, markupPct = 50) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  const withMarkup = rawCost * (1 + markupPct / 100);
  return { rawCostCents: Math.round(rawCost * 100), totalCostCents: Math.round(withMarkup * 100) };
}

// Fetch images from URLs and convert to base64 for Claude vision
async function fetchImagesAsBase64(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      results.push(base64);
    } catch (e) {
      console.warn('Failed to fetch inspiration image:', url, e.message);
    }
  }
  return results;
}

// Load the active prompt version from DB, falling back to hardcoded defaults
async function getActivePrompt() {
  try {
    const { data, error } = await supabase
      .from('prompt_versions')
      .select('id, creative_direction, design_dna')
      .eq('is_active', true)
      .single();

    if (!error && data?.creative_direction) {
      return {
        promptVersionId: data.id,
        systemPrompt: STRUCTURAL_RULES + '\n\n' + data.creative_direction,
        designDna: (typeof data.design_dna === 'object' && Object.keys(data.design_dna).length > 0)
          ? data.design_dna
          : DESIGN_DNA
      };
    }
  } catch {}
  // Fallback to hardcoded
  return { promptVersionId: null, systemPrompt: SYSTEM_PROMPT, designDna: DESIGN_DNA };
}

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
      decorative: 'VARY the theme widely — pick ONE of these directions and commit fully: jungle safari with hand-drawn animals, outer space with planets and rockets, underwater ocean with sea creatures, dinosaur adventure, superhero comic-book style, circus/carnival, construction zone, race cars, pirate treasure map, fairy tale castle, bug safari, robot/tech, wild west, ice cream parlor, monster mash, camping/outdoors. Avoid defaulting to generic rainbow/balloon/confetti.',
      typography: 'Bold, rounded display fonts (e.g. Fredoka One, Baloo 2, Lilita One, Bungee, Luckiest Guy). Match the specific theme — handwritten for crafty themes, blocky for construction, futuristic for space.',
      colorPhilosophy: 'Pick a palette that matches the SPECIFIC theme — NOT just rainbow. Jungle: greens and browns. Space: deep navy and neon. Ocean: teals and corals. Dinosaur: earthy oranges and greens. Commit to 3-4 colors that tell the theme story.',
      motion: 'Theme-specific animations: floating stars for space, swimming fish for ocean, stomping dinos, flying rockets, etc. Avoid generic confetti/balloons unless the event specifically requests a balloon theme.',
      standout: 'A bold illustrated hero element matching the theme — a rocket ship, a dinosaur, a treasure chest, a race car — NOT generic party decorations'
    }
  },
  adultBirthday: {
    label: 'Adult / Milestone Birthday',
    must: {
      photoTreatment: 'If photos provided, treat editorially — NOT kiddie circles. Sophisticated framing.',
      technical: 'The milestone number (30, 40, 50) should feature prominently as a design element.'
    },
    consider: {
      decorative: 'Match the vibe to the person/era — pick ONE: glamorous gold particles, retro 70s grain and earth tones, neon 80s glow, minimalist modern, dark moody lounge, maximalist pattern clash, art deco geometric, tropical island, vintage speakeasy, disco funk, editorial magazine, rustic farmhouse, industrial loft.',
      typography: 'Era/mood-appropriate fonts add personality (Playfair Display for elegance, Bebas Neue for bold, groovy retro for decade themes, editorial serif for magazine feel).',
      colorPhilosophy: '2-3 dominant colors with deliberate restraint OR deliberate excess — both work when committed fully. Avoid safe/generic palettes.',
      motion: 'Tone-appropriate motion: champagne bubble float for glamour, spotlight sweep for milestone, record-scratch for retro, neon pulse for modern.',
      standout: 'The milestone number as a massive typographic hero element'
    }
  },
  babyShower: {
    label: 'Baby Shower / Sip & See',
    must: {
      photoTreatment: 'Gentle, warm treatment for any photos. Soft framing, never harsh crops.',
      technical: 'Overall tone should feel nurturing and warm.'
    },
    consider: {
      decorative: 'VARY the aesthetic — pick ONE: celestial night sky with moons and stars, woodland creatures (foxes, owls, deer), hot air balloons in clouds, storybook illustration style, modern geometric with soft shapes, tropical with monstera leaves, safari animals, vintage stork delivery, nautical with anchors and waves, honeybee garden, constellation map, paper airplane whimsy, origami animals. Avoid defaulting to generic floral/botanical/watercolor.',
      typography: 'Match the theme — modern sans for geometric themes, whimsical rounded for storybook, elegant script for celestial, handwritten for crafty themes.',
      colorPhilosophy: 'Go beyond pink/blue stereotypes — sage and terracotta, navy and gold stars, warm mustard and cream, deep forest green and peach, lavender and mint. Soft does not mean pastel pink.',
      motion: 'Theme-matched gentle animations: twinkling stars for celestial, floating clouds for sky themes, gentle leaf drift for woodland, origami unfolding.',
      standout: 'A charming illustrated centerpiece matching the chosen theme — a crescent moon, a woodland fox, a hot air balloon, a storybook cover'
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
      technical: 'Elegant and celebratory. NEVER clipart-style elements.'
    },
    consider: {
      decorative: 'VARY the aesthetic — pick ONE: lush hand-illustrated botanicals, art deco geometric arches, modern minimalist with bold type, Mediterranean tile patterns, French patisserie style, garden party with toile pattern, bohemian desert with cacti, coastal with shells and waves, Parisian café, champagne brunch editorial, citrus grove, vintage lace and pearls.',
      typography: 'Match the chosen aesthetic — elegant script for classic, bold sans for modern, serif for editorial, handwritten for bohemian.',
      colorPhilosophy: 'Go beyond blush — terracotta and olive for boho, navy and gold for art deco, citrus yellows and greens for garden, mauve and burgundy for moody romantic, coral and teal for coastal.',
      motion: 'Subtle and elegant — floating petals, gentle shimmer, soft parallax, elegant fade-in sequence.',
      standout: 'A distinctive visual element matching the chosen theme — an ornate arch, a champagne tower, a lemon wreath, a delicate lace border'
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

// ═══════════════════════════════════════════════════════════════════
// STRUCTURAL RULES — Platform contract. NEVER editable by admins.
// These ensure the output works with Ryvite's runtime (RSVP injection,
// preview system, data binding, thank-you page rendering).
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
    "loadingPun": "A short, fun, on-theme pun shown while the RSVP is submitting (e.g., 'Grabbing your party hat...', 'Saving you a seat...', 'Polishing the dance floor...')"
  }
}

## PAGE STRUCTURE — REQUIRED SECTIONS
Build the page with these sections (creative freedom on visual execution):
1. **THEMATIC HEADER** — An animated or illustrated element specific to this event type.
2. **HERO SECTION** — Large display headline with event title/names/tagline. Photo treatment if photos provided.
3. **EVENT DETAILS** — \`<div class="details-slot"></div>\`. The platform injects event details (date, time, location, dress code) at runtime — just like the RSVP form. You MUST NOT put any text, icons, or labels inside this div. Style it via CSS to match the theme. The platform injects children with classes: \`.detail-item\`, \`.detail-icon\`, \`.detail-label\`, \`.detail-value\` — style these in theme_css.
4. **RSVP SECTION** — \`<div class="rsvp-slot"><button class="rsvp-button">...</button></div>\`. The rsvp-slot MUST contain ONLY the button — the platform injects the real form at runtime. Make the button text fun and on-theme but NEVER use commitment words like "I'm Coming", "Count Me In", "I'll Be There", "RSVP Yes", "Sign Me Up", etc. The RSVP status (attending/declined/maybe) is handled by the form — the button just opens it. Use action phrases like "Let's Party!", "Open the Invite!", "Get the Details!", "Join the Fun!", "See What's Inside!", "Reserve Your Spot!" instead.

## RSVP BUTTON — CRITICAL PLATFORM RULES
- Full-width within its container (width: 100% or at least 280px) — NEVER shrink to fit text
- Min-height: 56px, max-height: 72px — NEVER make the button taller than 72px. It should be a normal button, NOT a giant vertical element.
- Generous padding (16px 32px minimum)
- Border-radius matching the design language (8-16px modern, 28px+ pill)
- Clear, high-contrast centered text — use flexbox (display:flex; align-items:center; justify-content:center)
- Font-size: 16-18px, bold/semibold
- NEVER use default browser button styling — always set appearance:none, explicit background, color, border
- Smooth hover transition (transform scale 1.02-1.05, subtle shadow lift, or color shift)
- NEVER overflow, clip, or break layout at 393px viewport width
- NEVER put form inputs/selects/labels inside \`.rsvp-slot\` — ONLY the button
- The RSVP button must NOT overlap or cover other content. It should sit naturally in the page flow, NOT be position:absolute or position:fixed.
- RSVP fields and buttons MUST ALWAYS be single-column (stacked vertically, full-width). NEVER use two-column grid, flex-row, or side-by-side layouts for form fields or the RSVP button — the platform injects form fields that break when laid out in columns on mobile. This is a 393px viewport.

## RSVP FORM LAYOUT — CRITICAL (platform injects form at runtime)
- The platform replaces the \`.rsvp-slot\` contents with form fields (name, status, custom fields) + the button
- The injected form MUST render as a **single column** — NEVER two-column, grid, or side-by-side inputs
- Style \`.rsvp-slot\` with: \`display: flex; flex-direction: column; width: 100%;\`
- NEVER set \`.rsvp-slot\` to \`display: grid\`, \`flex-direction: row\`, or \`flex-wrap: wrap\` with side-by-side children
- All inputs inside \`.rsvp-slot\` must be full-width (width: 100%) — no 50% widths, no multi-column layouts

## REQUIRED DATA ATTRIBUTES
- \`data-field="title"\` — on the element containing the event title text (the ONLY data-field you generate)

## DETAILS SLOT — CSS STYLING GUIDE (platform injects the HTML at runtime)
Style these classes in theme_css to match the theme:
- \`.details-slot\` — container for all event details. Set background, border-radius, padding, margins. Use a color that complements the theme.
- \`.detail-item\` — each detail row (date, location, dresscode). Use \`display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px;\`
- \`.detail-icon\` — 24px icon area with emoji. Set font-size: 20px.
- \`.detail-label\` — small label ("Date", "Location"). Set font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7;
- \`.detail-value\` — the actual detail text. Set font-size: 15px; font-weight: 500;
- **CRITICAL CONTRAST**: If \`.details-slot\` has a dark/colored background, \`.detail-label\` and \`.detail-value\` color MUST be #FFFFFF or #FAFAFA. If light background, use #1A1A1A or darker.

## TECHNICAL CONSTRAINTS — NON-NEGOTIABLE
- Max-width 393px (iPhone), centered, mobile-first
- **TOP SAFE AREA**: The page MUST have at least 48px of padding-top on the outermost container to clear the iPhone notch/Dynamic Island. Content behind the notch is invisible — never place text, logos, or illustrations in the top 48px.
- Text must be readable: min 14px body, WCAG AA contrast ratios (4.5:1 body, 3:1 headings)
- Generous padding (20-24px sides)
- CSS custom properties for all theme colors
- No JavaScript in the output — CSS only for all animations
- No fixed positioning, no iframes
- Keep height reasonable — 3-5 phone screen scrolls
- Source all fonts from Google Fonts only (include @import in googleFontsImport)

## PHOTO HANDLING
If photos are provided via URL, use them in \`<img>\` tags with the exact URL provided.
- Style with border-radius, box-shadow, border, or creative framing per the event type
- If photos are bad quality, the treatment should save them (overlay, vignette, color grade via CSS filter)

## THANK YOU PAGE (theme_thankyou_html) — CRITICAL
The platform injects the "Thank You!" heading, subtitle text, calendar buttons, and footer at runtime.
Your job: provide the **visual wrapper and decorative illustration** that makes it feel like a celebration, not a blank page.

\`\`\`html
<div class="thankyou-page">
  <!-- REQUIRED: A theme-centric decorative SVG illustration (under 2KB) -->
  <!-- Examples: confetti burst, balloons, party hat, checkmark with sparkles, -->
  <!-- champagne glasses, birthday cake, gift box, rainbow, stars cluster, etc. -->
  <!-- Match the event type and theme — make it feel like a CELEBRATION -->
  <div class="thankyou-decoration">
    <svg ...><!-- theme-matching illustration --></svg>
  </div>
  <!-- LEAVE EMPTY — platform fills with "Thank You!" title + confirmation subtitle -->
  <div class="thankyou-hero"></div>
</div>
\`\`\`

Rules:
- \`.thankyou-page\` MUST have a branded background matching the invite (gradient, pattern, texture, or solid color)
- \`.thankyou-hero\` MUST be completely empty — no text, no emojis, no SVGs inside it. The platform fills it with title + subtitle.
- **REQUIRED**: Include a decorative SVG illustration OUTSIDE \`.thankyou-hero\` but INSIDE \`.thankyou-page\`. This is NOT optional — a bare page with just text and buttons looks broken. The illustration should:
  - Match the event theme (unicorn for kids party, champagne for wedding, etc.)
  - Be an inline SVG, under 2KB
  - Have CSS animation (fade-in, bounce, float, scale-up)
  - Be placed ABOVE \`.thankyou-hero\` so it appears at the top
- NO text content anywhere, NO emojis, NO calendar buttons, NO footer
- **VISUAL CONSISTENCY IS MANDATORY**: The thank you page must look like it belongs with the invite. If the invite has a pink gradient background, the thank you page needs a similar pink gradient. If the invite uses purple and gold, the thank you page should too. A plain white thank you page after a vibrant themed invite is a broken experience.
- Include these CSS rules in theme_css — **customize ALL colors/fonts/backgrounds to match the invite**:
\`\`\`css
.thankyou-page {
  max-width: 393px; margin: 0 auto; padding: 60px 32px 40px;
  min-height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; text-align: center;
  /* COPY the invite's background treatment here — gradient, color, pattern */
  background: /* same gradient or color as the invite body */;
  font-family: /* same body font as the invite */;
}
.thankyou-decoration { margin-bottom: 24px; /* add entrance animation */ }
.thankyou-hero { margin-bottom: 32px; }
.thankyou-title { font-size: 36px; font-weight: 700; margin-bottom: 12px; font-family: /* same heading font */; color: /* same accent/heading color */; }
.thankyou-subtitle { font-size: 16px; line-height: 1.5; opacity: 0.8; }
\`\`\`

## TEXT CONTRAST — CRITICAL, NEVER VIOLATE
- EVERY piece of text must have sufficient contrast against its background (WCAG AA minimum)
- NEVER put light text on light backgrounds or dark text on dark backgrounds
- When using background images or gradients, add a semi-transparent overlay or text-shadow
- Button text MUST contrast against the button background color

### CONCRETE CONTRAST RULES FOR EACH SECTION:
- **Details slot** (\`.details-slot\`): If background is dark, \`.detail-label\` and \`.detail-value\` MUST be white (#FFFFFF/#FAFAFA). If light, use dark text (#1A1A1A). NEVER use accent colors as text on dark backgrounds.
- **Hero section**: If the background is dark or uses a dark gradient, title and subtitle text MUST be white/cream/very light.
- **RSVP section**: Button text must be white on dark buttons or dark on light buttons. No exceptions.
- **SIMPLE RULE**: For ANY section with a colored/dark background, set the text color to #FFFFFF or #FAFAFA. For any section with a light/white background, set text to #1A1A1A or darker. Do NOT try to match text color to theme accent colors on dark backgrounds — it almost always fails contrast.`;

// ═══════════════════════════════════════════════════════════════════
// DEFAULT CREATIVE DIRECTION — The editable creative layer.
// Admins can iterate on this via Prompt Versions without breaking
// the platform contract above.
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_CREATIVE_DIRECTION = `You are a world-class invite designer building a production-grade, single-file HTML event invite page. This page must be visually extraordinary — better than Evite, Paperless Post, Canva, or any other existing provider. It should feel like it was designed by a top creative studio, not generated by AI.

When the user gives you minimal input, that is creative freedom, not a gap to fill conservatively. Make bold decisions. Pick a strong visual direction, commit to it, and execute it with detail. A vague brief is an invitation to surprise them.

## CRITICAL DESIGN PHILOSOPHY
- This must be UNFORGETTABLE. Every spacing, shadow, border-radius, and animation timing must feel intentional and designed.
- Choose a clear aesthetic direction and execute it with total commitment.
- Bold maximalism and refined minimalism both work — the failure mode is neither.
- NEVER produce a generic or "bootstrap-looking" layout.
- Use unexpected moments: overlapping elements, asymmetric composition, color blocks that break the grid, type that surprises.

## TYPOGRAPHY RULES
- Choose a BOLD, characterful display font that matches the event's emotional register
- Pair with a warm, readable body font — NEVER Inter, Roboto, Arial, or any system default
- Typography should do heavy creative lifting, not just label things
- Vary weight, scale, case, and tracking deliberately — type IS the design
- Headline: large, tight line-height, slight text-shadow for depth

## COLOR RULES
- Define CSS custom properties at :root — one color dominates (60%+ of the page)
- Maximum 2 true accent colors — used for emphasis only, not decoration
- No purple gradients on white. Dark themes: near-black in the #08–#18 range, never pure #000
- Background should never be plain white — use a pattern, texture, subtle gradient, or tinted base

## SVG & ILLUSTRATION
- When no photos are provided, use hand-crafted inline SVG illustrations as the emotional hero
- SVG subjects should be recognizable and detailed — layered construction with shadows and highlights
- Background must have depth: sky + ground, environment layers, or architectural context
- Include secondary elements: props, nature, objects, decorations specific to the theme
- Small scattered details: stars, paw prints, sparkles, leaves — whatever fits the mood

## ANIMATION RULES — EVERY INVITE SHOULD FEEL ALIVE
- **Ambient background**: theme-specific moving elements on infinite loop, varied speeds, 0.1-0.2 opacity (match the event theme — stars for space, fish for ocean, snow for winter, etc.)
- **Photo animations**: subtle scale pulse, soft glow, gentle parallax — match the event's energy level
- **Entrance**: staggered fade-up on page load (animation-delay: 0.1s increments) — choreographed reveal
- **Interactive**: hover states on all buttons with smooth transitions
- **Decorative**: gentle sway or float on header decorations
- Use transform and opacity for smooth performance.
- The RSVP button must feel like the CLIMAX of the page — the visual payoff of scrolling through the invite

## WHAT KILLS A GOOD INVITE — NEVER DO THESE
- Using Inter, Roboto, or system fonts
- Purple gradients on white backgrounds
- Evenly spaced, equal-weight visual elements — hierarchy matters
- Generic rainbow/balloon/confetti as the default — these are overused. Pick a SPECIFIC theme and commit to it
- No animations — the page should feel alive
- Light text on light backgrounds or dark text on dark backgrounds
- Playing it safe on a vague brief — lean into a strong, SPECIFIC visual point of view
- Defaulting to the same aesthetic every time — be unpredictable and varied across generations

## INSPIRATION IMAGES
If provided, analyze them for color palette, visual mood, textures, typography style, and overall aesthetic. Use as strong creative direction.`;

// The old combined prompt — kept as fallback for backward compatibility
const SYSTEM_PROMPT = STRUCTURAL_RULES + '\n\n' + DEFAULT_CREATIVE_DIRECTION;

// ═══════════════════════════════════════════════════════════════════
// ROBUST THEME RESPONSE PARSER (duplicated from prompt-test.js — Vercel
// serverless functions can't share imports)
// ═══════════════════════════════════════════════════════════════════
function parseThemeResponse(rawText) {
  let text = (typeof rawText === 'string' ? rawText : '').trim();
  if (text.match(/^<!DOCTYPE/i) || text.match(/^<html/i)) return extractThemeFromHtmlDoc(text);
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) text = jsonBlockMatch[1].trim();
  if (!text.startsWith('{') || text.match(/^\{\s*--/)) {
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
      // Model returned raw CSS (possibly followed by HTML)
      const htmlStart = text.match(/<(div|section|main|header|article)\b/i);
      if (htmlStart) {
        const htmlIdx = text.indexOf(htmlStart[0]);
        return { theme_html: text.substring(htmlIdx).trim(), theme_css: text.substring(0, htmlIdx).trim(), theme_config: {}, theme_thankyou_html: '' };
      }
      if (text.includes('.') && text.includes('{')) {
        return { theme_html: '', theme_css: text, theme_config: {}, theme_thankyou_html: '' };
      }
    }
  }
  let theme;
  try { theme = JSON.parse(text); } catch (parseErr) {
    let repaired = text;
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';
    let braceDepth = 0, bracketDepth = 0, inString = false;
    for (let i = 0; i < repaired.length; i++) { const ch = repaired[i]; if (ch === '"' && (i === 0 || repaired[i-1] !== '\\')) inString = !inString; if (!inString) { if (ch === '{') braceDepth++; else if (ch === '}') braceDepth--; else if (ch === '[') bracketDepth++; else if (ch === ']') bracketDepth--; } }
    for (let i = 0; i < bracketDepth; i++) repaired += ']';
    for (let i = 0; i < braceDepth; i++) repaired += '}';
    try { theme = JSON.parse(repaired); } catch (e2) {
      if (rawText.includes('<div') || rawText.includes('<section') || rawText.includes('<style')) return extractThemeFromHtmlDoc(rawText);
      // Try splitting CSS + HTML if raw text contains HTML elements
      const htmlTag = rawText.match(/<(div|section|main|header|article)\b/i);
      if (htmlTag) {
        const idx = rawText.indexOf(htmlTag[0]);
        const html = rawText.substring(idx).trim();
        if (html.length > 100) return { theme_html: html, theme_css: rawText.substring(0, idx).trim(), theme_config: {}, theme_thankyou_html: '' };
      }
      throw new Error('Failed to parse theme JSON: ' + parseErr.message + ' | First 300 chars: ' + text.substring(0, 300));
    }
  }
  return normalizeThemeKeys(theme);
}

function extractThemeFromHtmlDoc(html) {
  let css = '', body = html, config = {};
  const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleMatches) { css = styleMatches.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n'); body = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''); }
  const linkMatch = html.match(/<link[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/i);
  if (linkMatch) config.googleFontsImport = "@import url('" + linkMatch[1] + "');";
  if (!config.googleFontsImport) { const importMatch = css.match(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/); if (importMatch) { config.googleFontsImport = "@import url('" + importMatch[1] + "');"; css = css.replace(/@import\s+url\([^)]+\);?\s*/g, ''); } }
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1].trim();
  body = body.replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<\/?(html|head|!doctype)[^>]*>/gi, '').replace(/<(link|meta)[^>]*>/gi, '').trim();
  if (!body && !css) throw new Error('Invalid theme response — could not extract HTML or CSS');
  // Extract thankyou-page content if present in the HTML document
  let thankyouHtml = '';
  const thankyouMatch = body.match(/<div[^>]*class=["'][^"']*thankyou-page[^"']*["'][^>]*>[\s\S]*?<\/div>\s*$/i);
  if (thankyouMatch) {
    thankyouHtml = thankyouMatch[0];
    body = body.replace(thankyouMatch[0], '').trim();
    console.log('[extractThemeFromHtmlDoc] Extracted thankyou-page HTML (' + thankyouHtml.length + ' chars)');
  }
  return { theme_html: body, theme_css: css, theme_config: config, theme_thankyou_html: thankyouHtml };
}

function normalizeThemeKeys(theme) {
  if (!theme.theme_html && theme.html) theme.theme_html = theme.html;
  if (!theme.theme_html && theme.themeHtml) theme.theme_html = theme.themeHtml;
  if (!theme.theme_css && theme.css) theme.theme_css = theme.css;
  if (!theme.theme_css && theme.themeCss) theme.theme_css = theme.themeCss;
  if (!theme.theme_config && theme.config) theme.theme_config = theme.config;
  if (!theme.theme_config && theme.themeConfig) theme.theme_config = theme.themeConfig;
  if (!theme.theme_thankyou_html && theme.thankyou_html) theme.theme_thankyou_html = theme.thankyou_html;
  if (!theme.theme_thankyou_html && theme.thankyouHtml) theme.theme_thankyou_html = theme.thankyouHtml;
  // Fix double-escaped quotes in HTML/CSS (models sometimes output \" inside JSON strings)
  if (theme.theme_html && theme.theme_html.includes('\\"')) theme.theme_html = theme.theme_html.replace(/\\"/g, '"');
  if (theme.theme_css && theme.theme_css.includes('\\"')) theme.theme_css = theme.theme_css.replace(/\\"/g, '"');
  if (theme.theme_thankyou_html && theme.theme_thankyou_html.includes('\\"')) theme.theme_thankyou_html = theme.theme_thankyou_html.replace(/\\"/g, '"');
  // Fix double-escaped whitespace (models sometimes output \\n inside JSON string values)
  // After JSON.parse, \\n becomes literal backslash-n text — convert to real whitespace
  if (theme.theme_html && theme.theme_html.includes('\\n')) theme.theme_html = theme.theme_html.replace(/\\n/g, '\n');
  if (theme.theme_css && theme.theme_css.includes('\\n')) theme.theme_css = theme.theme_css.replace(/\\n/g, '\n');
  if (theme.theme_thankyou_html && theme.theme_thankyou_html.includes('\\n')) theme.theme_thankyou_html = theme.theme_thankyou_html.replace(/\\n/g, '\n');
  if (theme.theme_html && theme.theme_html.includes('\\t')) theme.theme_html = theme.theme_html.replace(/\\t/g, '\t');
  if (theme.theme_css && theme.theme_css.includes('\\t')) theme.theme_css = theme.theme_css.replace(/\\t/g, '\t');
  // Always extract <style> blocks from theme_html and merge into theme_css.
  // AI may put CSS in both theme_css AND inline <style> tags in the HTML.
  if (theme.theme_html) {
    const styleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleMatch) {
      const extractedCss = styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
      theme.theme_css = theme.theme_css ? (theme.theme_css + '\n' + extractedCss) : extractedCss;
      theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    }
  }
  if (theme.theme_html && (theme.theme_html.includes('<!DOCTYPE') || theme.theme_html.includes('<html'))) {
    const linkMatches = theme.theme_html.match(/<link[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi);
    if (linkMatches) { const fontUrl = linkMatches.map(l => { const m = l.match(/href=["']([^"']+)["']/); return m ? m[1] : null; }).filter(Boolean)[0]; if (fontUrl && !theme.theme_config?.googleFontsImport) { if (!theme.theme_config) theme.theme_config = {}; theme.theme_config.googleFontsImport = fontUrl; } }
    const bodyMatch = theme.theme_html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) theme.theme_html = bodyMatch[1].trim();
  }
  if (!theme.theme_css) theme.theme_css = '';
  if (!theme.theme_config) theme.theme_config = {};
  if (!theme.theme_config.googleFontsImport) {
    const fontImportMatch = (theme.theme_css || '').match(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/);
    if (fontImportMatch) { theme.theme_config.googleFontsImport = "@import url('" + fontImportMatch[1] + "');"; theme.theme_css = theme.theme_css.replace(/@import\s+url\([^)]+\);?\s*/g, ''); }
  }
  if (!theme.theme_html) { throw new Error('Invalid theme response — missing theme_html. Got keys: [' + Object.keys(theme).join(', ') + ']'); }
  return theme;
}

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

// ═══════════════════════════════════════════════════════════════════
// SERVER-SIDE THEME VALIDATION & AUTO-REPAIR
// Catches common AI output issues before sending to the client.
// ═══════════════════════════════════════════════════════════════════
function validateThemeIntegrity(theme) {
  const issues = [];
  const html = theme.theme_html || '';
  const css = theme.theme_css || '';

  // 1. CSS must exist and have meaningful content (selectors + rules)
  if (!css.trim()) {
    issues.push('css_empty');
  } else if (css.trim().length < 100) {
    issues.push('css_too_short');
  } else {
    // CSS must contain at least one selector with a rule block
    const hasSelectorAndRule = /[.#\w@:][^{]*\{[^}]+\}/s.test(css);
    if (!hasSelectorAndRule) issues.push('css_no_rules');
  }

  // 2. HTML must have structural elements (not just raw text)
  if (!html.trim()) {
    issues.push('html_empty');
  } else {
    const hasStructure = /<(div|section|main|header|article)\b/i.test(html);
    if (!hasStructure) issues.push('html_no_structure');
  }

  // 3. CSS should reference classes/elements that exist in the HTML
  if (css && html) {
    const cssClasses = [...new Set((css.match(/\.([a-zA-Z][\w-]*)/g) || []).map(c => c.substring(1)))];
    const htmlContent = html.toLowerCase();
    if (cssClasses.length > 0) {
      const matchCount = cssClasses.filter(c => htmlContent.includes(c.toLowerCase())).length;
      const matchRatio = matchCount / cssClasses.length;
      if (matchRatio < 0.2) issues.push('css_html_mismatch');
    }
  }

  // 4. Check for broken/incomplete CSS (unclosed braces)
  if (css) {
    const opens = (css.match(/\{/g) || []).length;
    const closes = (css.match(/\}/g) || []).length;
    if (opens !== closes) issues.push('css_unclosed_braces');
  }

  // 5. Check for leftover markdown fences in CSS or HTML
  if (css.includes('```') || html.includes('```')) issues.push('markdown_fences');

  // 6. Check for raw JSON wrapper leaking into HTML
  if (html.startsWith('"') || html.startsWith('{')) issues.push('html_json_leak');

  // 7. Check for stray @import in CSS body (should be in config.googleFontsImport only)
  // A stray @import after any CSS rule kills all subsequent rules in that <style> block
  if (css && /@import\s+url\(/i.test(css)) issues.push('css_stray_import');

  // 8. Check for malformed @keyframes (nested brace mismatch within animation blocks)
  if (css) {
    const keyframeBlocks = css.match(/@keyframes\s+[\w-]+\s*\{/g);
    if (keyframeBlocks) {
      keyframeBlocks.forEach(kf => {
        const startIdx = css.indexOf(kf);
        let depth = 0, i = startIdx;
        for (; i < css.length; i++) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) issues.push('css_malformed_keyframes');
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

function repairTheme(theme, issues) {
  // Fix markdown fences
  if (issues.includes('markdown_fences')) {
    theme.theme_css = (theme.theme_css || '').replace(/```(?:css)?\s*/g, '').replace(/```\s*/g, '');
    theme.theme_html = (theme.theme_html || '').replace(/```(?:html)?\s*/g, '').replace(/```\s*/g, '');
  }

  // Fix JSON leak in HTML (strip leading quotes/braces)
  if (issues.includes('html_json_leak')) {
    let h = theme.theme_html;
    // Strip leading "theme_html": " wrapper
    h = h.replace(/^["']?\s*/, '');
    // Strip trailing quotes
    h = h.replace(/["']\s*$/, '');
    theme.theme_html = h;
  }

  // Fix unclosed braces — close any open ones
  if (issues.includes('css_unclosed_braces')) {
    const opens = (theme.theme_css.match(/\{/g) || []).length;
    const closes = (theme.theme_css.match(/\}/g) || []).length;
    if (opens > closes) {
      theme.theme_css += '}'.repeat(opens - closes);
    }
  }

  // If CSS is empty/too short but HTML has inline styles, extract them
  if (issues.includes('css_empty') || issues.includes('css_too_short')) {
    const styleBlocks = (theme.theme_html || '').match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (styleBlocks) {
      const extracted = styleBlocks.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
      if (extracted.trim().length > (theme.theme_css || '').trim().length) {
        theme.theme_css = extracted;
        theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        console.log('[repairTheme] Extracted ' + extracted.length + ' chars of CSS from inline <style> blocks');
      }
    }
  }

  // Move stray @import statements from CSS to config.googleFontsImport
  if (issues.includes('css_stray_import')) {
    const importMatches = (theme.theme_css || '').match(/@import\s+url\(['"]?([^'"\)]+)['"]?\);?\s*/g);
    if (importMatches) {
      const fontUrl = importMatches[0].match(/url\(['"]?([^'"\)]+)['"]?\)/);
      if (fontUrl && !theme.theme_config?.googleFontsImport) {
        if (!theme.theme_config) theme.theme_config = {};
        theme.theme_config.googleFontsImport = "@import url('" + fontUrl[1] + "');";
      }
      theme.theme_css = theme.theme_css.replace(/@import\s+url\([^)]+\);?\s*/g, '');
      console.log('[repairTheme] Moved ' + importMatches.length + ' stray @import(s) from CSS to config');
    }
  }

  // Strip malformed @keyframes blocks (animations are decorative, not critical)
  if (issues.includes('css_malformed_keyframes')) {
    theme.theme_css = theme.theme_css.replace(/@keyframes\s+[\w-]+\s*\{[^}]*$/gm, '');
    console.log('[repairTheme] Stripped malformed @keyframes block(s)');
  }
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
// Returns { context, selectedIds } — context is the prompt string, selectedIds for logging
//
// Selection uses a confidence-gated composite score from production_style_effectiveness view,
// filtered by event type (wedding ratings don't influence birthday selection):
//   - Below 5 data points for this event type: pure admin_rating (prevents small-sample distortion)
//   - Above 5: gradually blends in production quality (35%) + user satisfaction (25%),
//     anchored by admin rating (40%), with Bayesian damping (blend_factor = n/(n+5))
// Falls back to admin_rating-only weighting if the view isn't available.
async function loadStyleReferences(eventType, promptSpecificity = 0) {
  try {
    const limit = promptSpecificity >= 0.5 ? 1 : 2;
    // Fetch more candidates than needed for weighted selection
    const fetchLimit = Math.max(limit * 3, 6);

    // Try to load composite effectiveness scores for this event type
    // (requires migrate_style_feedback_loop.sql — view is per event type)
    let compositeScores = null;
    try {
      const { data: effectivenessData } = await supabase
        .from('production_style_effectiveness')
        .select('style_id, composite_score')
        .eq('event_type', eventType);
      if (effectivenessData?.length > 0) {
        compositeScores = new Map(effectivenessData.map(row => [row.style_id, row.composite_score]));
      }
    } catch { /* view doesn't exist yet — fall back to admin_rating */ }

    let res = await supabase
      .from('style_library')
      .select('*')
      .contains('event_types', [eventType])
      .is('archived_at', null)
      .order('admin_rating', { ascending: false, nullsFirst: false })
      .limit(fetchLimit);
    // Fallback if admin_rating or archived_at column doesn't exist yet (migration not run)
    if (res.error) {
      res = await supabase
        .from('style_library')
        .select('*')
        .contains('event_types', [eventType])
        .limit(fetchLimit);
    }
    const data = res.data;
    if (!data || data.length === 0) return { context: '', selectedIds: [] };
    // Weighted selection using composite scores when available, admin_rating as fallback
    const selected = weightedStylePick(data, limit, compositeScores);
    const selectedIds = selected.map(row => row.id);
    const matched = selected.map(row => ({
      name: row.name, description: row.description, html: row.html,
      eventTypes: row.event_types || [], designNotes: row.design_notes
    }));
    // Track usage (fire and forget — silently skip if times_used column doesn't exist)
    selected.forEach(row => {
      supabase.from('style_library').update({ times_used: (row.times_used || 0) + 1 }).eq('id', row.id).then(() => {}).catch(() => {});
    });
    return { context: buildStyleContext(matched, promptSpecificity), selectedIds };
  } catch {
    return { context: '', selectedIds: [] };
  }
}

// Weighted random selection using confidence-gated composite scores.
//
// Weight calculation:
//   1. If compositeScores map is available (from production_style_effectiveness view,
//      filtered by event type), use the composite score — which is confidence-gated
//      per event type in the SQL view: below 5 data points it equals admin_rating,
//      above it gradually blends in production/user signals via Bayesian damping
//   2. Otherwise fall back to admin_rating (1-5) or 2 for unrated
//
// Applies exponential scaling (weight^1.8) so quality differences are amplified:
//   Score 5 → weight 18.1 (dominant)
//   Score 4 → weight 12.1
//   Score 3 → weight  7.2
//   Score 2 → weight  3.5 (neutral baseline for unrated)
//   Score 1 → weight  1.0 (still possible, not eliminated)
function weightedStylePick(items, count, compositeScores = null) {
  if (items.length <= count) return items;
  const weighted = items.map(item => {
    const baseScore = compositeScores?.get(item.id) || item.admin_rating || 2;
    return {
      item,
      weight: Math.pow(baseScore, 1.8) // Exponential scaling amplifies quality differences
    };
  });
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
function buildEventTypeContext(eventType, userPrompt, designDnaOverride) {
  const dnaSource = designDnaOverride || DESIGN_DNA;
  const dna = dnaSource[eventType] || dnaSource.other || DESIGN_DNA.other;
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

// Extract client metadata from request headers (Vercel provides geo headers)
function getClientMeta(req) {
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  const geo = {};
  if (req.headers['x-vercel-ip-country']) geo.country = req.headers['x-vercel-ip-country'];
  if (req.headers['x-vercel-ip-country-region']) geo.region = req.headers['x-vercel-ip-country-region'];
  if (req.headers['x-vercel-ip-city']) geo.city = decodeURIComponent(req.headers['x-vercel-ip-city']);
  if (req.headers['x-vercel-ip-latitude']) geo.latitude = req.headers['x-vercel-ip-latitude'];
  if (req.headers['x-vercel-ip-longitude']) geo.longitude = req.headers['x-vercel-ip-longitude'];
  const userAgent = (req.headers['user-agent'] || '').substring(0, 500);
  return { ip, geo, userAgent };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── PUBLIC ENDPOINT: Average generation latency (no auth required) ──
  // Used by the loading screen to show accurate time estimates
  if (req.method === 'GET' && (req.query?.action === 'avgLatency')) {
    try {
      // Get successful full-generation logs from the last 7 days (not tweaks/chat)
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('generation_log')
        .select('latency_ms')
        .eq('status', 'success')
        .gte('created_at', since)
        .gt('latency_ms', 5000)    // Only full generations (>5s), not quick tweaks
        .lt('latency_ms', 600000); // Exclude outliers (>10min)

      if (error || !data || data.length === 0) {
        return res.status(200).json({ avgSeconds: null, sampleSize: 0 });
      }
      const latencies = data.map(d => d.latency_ms).sort((a, b) => a - b);
      // Use median for robustness against outliers
      const median = latencies[Math.floor(latencies.length / 2)];
      const avg = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      // Round up to nearest 10s for display (e.g. 73s → "about 80 seconds")
      const displaySeconds = Math.ceil(median / 1000 / 10) * 10;
      // Cache for 5 minutes
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
      return res.status(200).json({
        avgSeconds: Math.round(avg / 1000),
        medianSeconds: Math.round(median / 1000),
        displaySeconds,
        sampleSize: latencies.length
      });
    } catch (e) {
      console.error('[avgLatency] Error:', e.message);
      return res.status(200).json({ avgSeconds: null, sampleSize: 0 });
    }
  }

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

  // Check generation limits
  try {
    const { checkUserLimits } = await import('./billing.js');
    const limits = await checkUserLimits(user.id);
    if (!limits.hasActivePlan) {
      return res.status(403).json({ error: 'You need an active plan to generate themes.', needsPlan: true });
    }
    if (!limits.canGenerate) {
      return res.status(403).json({ error: limits.reason || 'Generation limit reached for your plan.', limitReached: true });
    }
  } catch (e) {
    // If billing check fails, allow generation (don't block on billing errors)
    console.warn('Billing check failed, allowing generation:', e.message);
  }

  const action = req.query?.action || req.body?.action || 'generate';
  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages, inspirationImageUrls, tweakInstructions, currentHtml, currentCss, currentConfig, photoBase64, photoUrl, photoUrls, basedOnThemeId, previewMode, currentEmailHtml } = req.body;

  // --- INTERPRET FIELD: quick Haiku call to parse natural language into field definition ---
  if (action === 'interpretField') {
    const { userMessage, existingFields, eventId: fieldEventId } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

    try {
      const fieldStartTime = Date.now();
      const fieldList = (existingFields || []).map(f => f.label).join(', ');
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: 'You interpret natural language requests to add RSVP form fields. Return ONLY a JSON object, no markdown.',
        messages: [{ role: 'user', content: `The user said: "${userMessage}"

Existing fields: ${fieldList || 'none'}

Return a JSON object for the new field:
{"label": "Human-readable label", "field_key": "snake_case_key", "field_type": "text|number|textarea|email|phone|select|checkbox", "is_required": false, "placeholder": "helpful placeholder text"}

Rules:
- Pick the most appropriate field_type (number for counts/quantities, textarea for messages/notes, etc.)
- label should be clean and title-case (e.g. "Number of Pets", "Song Request")
- placeholder should be a helpful example (e.g. "e.g., 2", "Any song that gets you moving!")
- Do NOT duplicate existing fields` }]
      });

      const text = resp.content[0]?.text?.trim();
      const fieldInputTokens = resp.usage?.input_tokens || 0;
      const fieldOutputTokens = resp.usage?.output_tokens || 0;

      // Log cost to generation_log + increment event cost
      // CRITICAL: await these — fire-and-forget can lose records on Vercel
      const fieldLatency = Date.now() - fieldStartTime;
      const fieldCost = calcGenerationCost('claude-haiku-4-5-20251001', fieldInputTokens, fieldOutputTokens);
      const { error: fieldLogError } = await supabase.from('generation_log').insert({
        user_id: user.id, event_id: fieldEventId || null,
        prompt: 'interpretField: ' + userMessage.substring(0, 200),
        model: 'claude-haiku-4-5-20251001', input_tokens: fieldInputTokens,
        output_tokens: fieldOutputTokens, latency_ms: fieldLatency, status: 'success',
        is_tweak: true
      });
      if (fieldLogError) console.error('Field generation_log insert failed:', fieldLogError.message);
      if (fieldEventId) {
try {
          const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: fieldEventId, p_cost_cents: fieldCost.totalCostCents });
          if (rpcErr) {
            const { data } = await supabase.from('events').select('total_cost_cents').eq('id', fieldEventId).single();
            if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + fieldCost.totalCostCents }).eq('id', fieldEventId);
          }
        } catch (e) { /* non-critical */ }
      }
      await checkAndChargeAiUsage(user.id).catch(() => {});

      let field;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        field = JSON.parse(cleaned);
      } catch {
        return res.status(500).json({ error: 'Failed to parse field', raw: text });
      }
      return res.json({ success: true, field, metadata: { cost: fieldCost } });
    } catch (err) {
      console.error('interpretField error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // --- CLASSIFY INTENT: quick Haiku call to understand user's request before executing ---
  // Returns intent, confidence score, and a clarifying question if confidence is low.
  // This prevents expensive AI calls on ambiguous requests and ensures the chat never fails silently.
  if (action === 'classifyIntent') {
    const { userMessage, currentFields, eventType, previewMode: classifyPreviewMode } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

    try {
      const fieldList = (currentFields || []).map(f => `"${f.label}" (${f.field_type})`).join(', ');
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'You classify user requests in a design chat for event invitations. Return ONLY a JSON object, no markdown.',
        messages: [{ role: 'user', content: `The user is customizing their ${eventType || 'event'} invite${classifyPreviewMode === 'email' ? ' email' : ''} and said:
"${userMessage}"

Current RSVP fields: ${fieldList || 'none'}

Classify this request. Return JSON:
{
  "intent": "add_field|remove_field|modify_field|design_change|text_change|add_photo|question|unclear",
  "confidence": 0.0 to 1.0,
  "summary": "One sentence: what the user wants",
  "clarification": "A friendly question to ask if you're not confident (null if confident)",
  "suggested_options": ["option1", "option2", "option3"] or null
}

Rules:
- "add_field": user wants to add an RSVP form field (e.g. "add number of adults", "I need a dietary field")
- "design_change": visual changes (colors, fonts, layout, style, animations, spacing)
- "text_change": change specific text/wording in the invite
- "question": user is asking a question, not requesting a change
- "unclear": you genuinely can't determine what they want
- confidence 0.9+: crystal clear request. confidence 0.5-0.8: probably understand but should confirm. confidence <0.5: genuinely unclear
- For add_field with confidence >= 0.8, include "field_details": {"label": "...", "field_type": "..."} so we can skip a second AI call
- The clarification should be warm, conversational, and show you understood SOMETHING (never "what do you mean?")
- suggested_options: 2-3 clickable options that help the user clarify (null if confident)` }]
      });

      const text = resp.content[0]?.text?.trim() || '';
      const classifyCost = calcGenerationCost('claude-haiku-4-5-20251001', resp.usage?.input_tokens || 0, resp.usage?.output_tokens || 0);
      let classification;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        classification = JSON.parse(cleaned);
      } catch {
        // If parsing fails, return a conservative "unclear" classification
        classification = { intent: 'unclear', confidence: 0.3, summary: 'Could not classify', clarification: "I want to make sure I get this right — could you tell me a bit more about what you'd like to change?", suggested_options: null };
      }
      await checkAndChargeAiUsage(user.id).catch(() => {});
      return res.json({ success: true, ...classification, metadata: { cost: classifyCost } });
    } catch (err) {
      console.error('classifyIntent error:', err);
      // On error, return a safe fallback that asks for clarification rather than failing
      return res.json({ success: true, intent: 'unclear', confidence: 0.3, summary: 'Classification unavailable', clarification: "I want to make sure I get this right — could you tell me a bit more about what you'd like to change?", suggested_options: null });
    }
  }

  // --- TWEAK MODE: stream response via SSE to avoid timeouts ---
  if (action === 'tweak') {
    if (!eventId || !currentHtml || !currentCss || !tweakInstructions) {
      return res.status(400).json({ error: 'Missing required fields for tweak' });
    }

    const themeModel = await getThemeModel();
    const startTime = Date.now();

    // --- Smart routing: classify tweak as "light" or "design" ---
    // Light tweaks: text/copy changes, RSVP field add/remove/modify, wording changes
    // Design tweaks: colors, fonts, layout, animations, photos, style changes
    const lowerInstructions = tweakInstructions.toLowerCase();
    const hasPhotos = (photoUrls?.length > 0) || photoUrl || photoBase64;
    const designKeywords = [
      'color', 'colour', 'font', 'background', 'layout', 'animation', 'animate',
      'style', 'theme', 'darker', 'lighter', 'bigger', 'smaller', 'spacing',
      'margin', 'padding', 'border', 'shadow', 'gradient', 'photo', 'image',
      'minimalist', 'maximalist', 'elegant', 'bold', 'modern', 'vintage',
      'vibe', 'mood', 'swap', 'redesign', 'completely', 'overhaul',
      'move', 'position', 'align', 'center', 'left', 'right',
      'css', 'width', 'height', 'size', 'rounded', 'hover'
    ];
    // Text swap patterns ("change X to Y") are always light, even if they contain design-ish words
    const isTextSwap = /\b(?:change|replace|update|switch)\b.+\b(?:to|with|for|into)\b/i.test(lowerInstructions)
      && !/\b(?:color|colour|font|background|layout|theme|style)\s+(?:to|with|for|into)\b/i.test(lowerInstructions);
    const isLightTweak = isTextSwap || (!hasPhotos && !designKeywords.some(kw => lowerInstructions.includes(kw)));
    const tweakModel = isLightTweak ? 'claude-haiku-4-5-20251001' : themeModel;
    const tweakMaxTokens = isLightTweak ? 4096 : 16384;
    console.log(`[tweak] Classified as ${isLightTweak ? 'LIGHT' : 'DESIGN'} tweak, using model: ${tweakModel}`);

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

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
        eventContext += `\n**Current RSVP Fields (these are rendered dynamically by the platform, NOT in the HTML):**\n${rsvpFields.map(f => `- "${f.label}" (key: ${f.field_key || f.label.toLowerCase().replace(/\s+/g, '_')}, type: ${f.field_type}${f.is_required ? ', required' : ''})`).join('\n')}\n`;
      }

      let tweakMessage;

      const isEmailMode = previewMode === 'email';

      if (isLightTweak) {
        // ── LIGHT TWEAK: diff-based approach (much smaller output) ──
        const targetHtml = isEmailMode ? (currentEmailHtml || '') : currentHtml;
        const targetLabel = isEmailMode ? 'email invite' : 'invite theme';
        tweakMessage = `Here is an ${targetLabel}. The user wants a small text/content change.
${eventContext}
**Current ${isEmailMode ? 'Email ' : ''}HTML:**
\`\`\`html
${targetHtml}
\`\`\`

**User's request:** ${tweakInstructions}

Return a JSON object with ONLY the changes needed:
{
  "html_replacements": [{"old": "exact text to find", "new": "replacement text"}],
  ${isEmailMode ? '' : '"rsvp_field_changes": [...] or null,'}
  "chat_response": "Brief friendly message about what you changed"
}

Rules:
- "old" must be an EXACT substring from the current ${isEmailMode ? 'email ' : ''}HTML (copy-paste it precisely, including tags)
- "new" is the replacement string${isEmailMode ? `
- This is an EMAIL template — it must use table-based layout for email client compatibility
- Keep all inline styles — email clients don't support <style> blocks reliably` : `
- For RSVP field changes: { "action": "remove"|"add"|"modify", "field_key": "...", "label": "...", "field_type": "text"|"number"|"select"|"checkbox"|"textarea", "is_required": false }
- RSVP fields are rendered by the platform, NOT in the HTML. Do NOT add form inputs to html_replacements.
- .rsvp-slot MUST contain ONLY a <button class="rsvp-button">
- Preserve all data-field attributes`}`;
      } else if (isEmailMode) {
        // ── EMAIL DESIGN TWEAK: modify the email invite template ──
        tweakMessage = `Here is an email invite template. The user is customizing their email invite via the design chat.

The email should feel like a polished teaser of their event invite — matching its personality, colors, and typography — while working reliably across all email clients.
${eventContext}
**Current Email HTML:**
\`\`\`html
${currentEmailHtml || ''}
\`\`\`

**Theme Config (the invite's visual identity — match these in the email):**
\`\`\`json
${JSON.stringify(currentConfig || {})}
\`\`\`

**User's message:**
${tweakInstructions}

Return the updated email as a JSON object:
{
  "theme_email_html": "...the full updated email HTML...",
  "chat_response": "Brief friendly message about what you changed"
}

Keep the \`{name}\` and \`{link}\` placeholders — they're replaced per-guest at send time.
Preserve the RSVP button link and the "Sent via Ryvite" footer.
Make ONLY the changes the user asked for — keep everything else the same.`;
      } else {
        // ── DESIGN TWEAK: full regeneration ──
        tweakMessage = `Here is an existing invite theme. The user is using the chat designer to modify their invite.
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

        tweakMessage += `\n\nReturn the updated theme as a JSON object: { "theme_html": "...", "theme_css": "...", "theme_thankyou_html": "..." or null if unchanged, "theme_config": { ... }, "chat_response": "Brief friendly message about what you changed", "rsvp_field_changes": [...] or null if no RSVP field changes }. Make ONLY the changes the user requested — keep everything else exactly the same. If the thank you page doesn't need changes, set theme_thankyou_html to null.

### RSVP Field Changes
If the user asks to add, remove, or modify RSVP fields, include "rsvp_field_changes" — an array of operations:
- Remove a field: { "action": "remove", "field_key": "birthday_message_for_max" }
- Add a field: { "action": "add", "field_key": "song_request", "label": "Song Request", "field_type": "text", "is_required": false, "placeholder": "What song gets you dancing?" }
- Modify a field: { "action": "modify", "field_key": "dietary_restrictions", "label": "New Label", "is_required": true }
Valid field_types: text, number, select, checkbox, email, phone, textarea.
If the user is NOT requesting RSVP field changes, set rsvp_field_changes to null.
Remember: RSVP fields are rendered by the platform, NOT in theme HTML. Do NOT add form inputs to the HTML — use rsvp_field_changes instead.

⚠️ CONTRAST CHECK: After making changes, verify ALL text is readable. Dark/colored backgrounds → white text (#FFFFFF). Light backgrounds → dark text (#1A1A1A). Never use accent colors as text on dark backgrounds.`;
      }

      const messageContent = photoBase64 && !photoUrl
        ? [
            { type: 'text', text: tweakMessage },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } }
          ]
        : [{ type: 'text', text: tweakMessage }];

      // Stream the response from Claude
      sendSSE('status', { phase: 'generating', isLightTweak });

      const tweakSystemPrompt = isEmailMode && !isLightTweak
        ? `You are an elite email designer modifying event invitation emails. The email should feel like a premium, on-brand teaser for the event invite — making the recipient excited to click through.

## OUTPUT FORMAT
Return ONLY a valid JSON object:
{
  "theme_email_html": "...the complete updated email HTML...",
  "chat_response": "Brief friendly message about what you changed."
}

## EMAIL CLIENT COMPATIBILITY (non-negotiable)
These rules ensure the email renders correctly in Gmail, Apple Mail, Outlook, Yahoo, and mobile clients:

### Layout
- TABLE-BASED LAYOUT ONLY — no flexbox, no grid, no CSS float
- Outer wrapper: \`<table width="100%" cellpadding="0" cellspacing="0" border="0">\`
- Content table: max-width 600px with \`width="600"\` attribute AND \`style="max-width:600px;width:100%"\`
- Use \`role="presentation"\` on all layout tables
- Use \`border="0"\` on every table element

### Styles
- ALL styles INLINE (style="...") — Gmail/Outlook strip \`<style>\` blocks
- Never use CSS shorthand for padding/margin in Outlook-critical areas (use padding-top, padding-right etc. separately if needed)
- Never use \`opacity\` — derive actual hex colors instead (mix with white/black for lighter/darker)
- Never use rgba() or hsla() — only hex colors (#RRGGBB)
- Never use CSS variables, calc(), or any modern CSS
- Avoid \`border-radius\` on outer containers (Outlook ignores it) — it's fine on inner elements for non-Outlook

### Typography
- Always include web-safe fallback stacks: \`'Custom Font', Georgia, 'Times New Roman', serif\` or \`'Custom Font', Arial, Helvetica, sans-serif\`
- Use explicit \`font-family\` on EVERY text element — inheritance is unreliable
- Use px for font-size, never em/rem

### Images
- No inline SVG (Outlook blocks it). Use img tags with absolute URLs only
- Always include width/height attributes AND style dimensions
- Always include descriptive alt text

### Buttons (Outlook-safe)
- Wrap \`<a>\` in a \`<td>\` with background-color — not on the \`<a>\` itself
- Include VML roundrect comment for Outlook: \`<!--[if mso]>...<![endif]-->\`

### Structure
- Include preheader text (hidden preview text for inbox) in a hidden div at top of body
- Include \`<meta name="color-scheme" content="light">\` and \`<meta name="supported-color-schemes" content="light">\`

## DESIGN PHILOSOPHY — RYVITE BRANDED EMAIL
The email follows Ryvite's brand guidelines. The template structure is:
1. **Dark branded header** — background: linear-gradient(135deg, #1A1A2E, #0f3460), border-radius: 12px 12px 0 0, "Ryvite" in Playfair Display white, "Prompt to Party" in #FFB74D italic
2. **Accent bar** — 4px tall, uses the event's primaryColor for personality
3. **White card body** — #FFFFFF background, centered content, box-shadow for depth
4. **Event details card** — uses a soft tint of primaryColor (~85% toward white) background with a 3px left border in primaryColor
5. **CTA button** — Ryvite coral gradient (linear-gradient(135deg, #E94560, #FF6B6B)), pill shape (border-radius: 50px), white text, "View Invitation"
6. **Footer** — "&copy; 2026 Ryvite — Beautiful invitations, effortlessly." in #D1D5DB

Outer background: #FFFAF5 (Ryvite cream). Max-width: 480px.

- The event's primaryColor is used ONLY for the accent bar and details card tint/border — NOT the CTA button (always Ryvite coral gradient)
- Text is always dark (#1A1A2E headlines, #5A5A6E body, #D1D5DB footer)
- No emoji unicode characters (render inconsistently across clients)
- Keep it a teaser — show event name, date, location, a compelling CTA, and a hint to "view the full invitation"
- When users tweak the email, preserve the branded header/footer structure — only modify the card body content
- The email is a first impression — make it feel premium and on-brand, not generic`
        : isLightTweak
        ? `You are modifying an event ${isEmailMode ? 'email invite' : 'invite'}. Make ONLY the specific text, wording, or content changes requested. Do NOT change design, layout, colors, fonts, or CSS.

## OUTPUT FORMAT
Return ONLY a valid JSON object:
{
  "html_replacements": [{"old": "exact text from HTML to find", "new": "replacement text"}],
  "rsvp_field_changes": [...] or null,
  "chat_response": "Brief friendly message about what you changed."
}

## RULES
- html_replacements: each "old" must be an exact substring copied from the current HTML. "new" is its replacement. Include enough surrounding HTML context (tags, attributes) to make matches unique.
- If only RSVP field changes are needed and no HTML text changes, return an empty html_replacements array.
- RSVP fields: { "action": "remove"|"add"|"modify", "field_key": "...", "label": "...", "field_type": "text"|"number"|"select"|"checkbox"|"textarea", "is_required": false }
- .rsvp-slot MUST contain ONLY a <button class="rsvp-button"> — fields are rendered by the platform, NOT in HTML
- Keep changes minimal — only what the user asked for`
        : `You are an elite invite designer modifying event invites via a conversational chat interface. Your modifications should maintain the extraordinary quality standard — better than Evite, Paperless Post, or Canva.

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
  "chat_response": "A brief, friendly message (1-2 sentences) describing what you changed. Use a conversational tone.",
  "rsvp_field_changes": [...] or null if no RSVP field changes
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
- The platform injects the real RSVP form at runtime from the field definitions (NOT from the HTML)
- To add/remove/modify RSVP fields, use the "rsvp_field_changes" array in your response — do NOT add form inputs to HTML
- Example: user says "remove birthday message field" → include { "action": "remove", "field_key": "birthday_message_for_max" } in rsvp_field_changes
- Example: user says "add a song request field" → include { "action": "add", "field_key": "song_request", "label": "Song Request", "field_type": "text", "is_required": false, "placeholder": "What song gets you dancing?" }

### Design rules:
- Max-width 393px, mobile-first, WCAG AA contrast
- Google Fonts only (include @import in theme_config.googleFontsImport)
- NEVER use Inter, Roboto, Arial, or system fonts — always characterful fonts
- No JavaScript, no external images (except Google Fonts and user-uploaded photos)
- Make minimal changes — only what the user asked for, keep everything else exactly the same
- Preserve and enhance CSS animations — every invite should feel alive with entrance animations, ambient motion, and hover effects
- Thank you page: Provide .thankyou-page container with a REQUIRED decorative SVG illustration (in .thankyou-decoration div) + empty .thankyou-hero div. The platform injects "Thank You!" title, subtitle, calendar buttons, and footer. NO text, NO emojis, NO calendar buttons, NO footer in your output. MUST include a theme-matching SVG illustration with CSS animation. Match invite's background/fonts. Style .thankyou-page, .thankyou-decoration, .thankyou-hero, .thankyou-title, .thankyou-subtitle in CSS.
- TEXT CONTRAST: EVERY text element must be clearly readable against its background. Never light-on-light or dark-on-dark. Buttons must have contrasting text. This is non-negotiable. CONCRETE RULE: on any dark/colored background section, text MUST be #FFFFFF or #FAFAFA. On light backgrounds, text MUST be #1A1A1A or darker. Do NOT use theme accent colors (coral, salmon, rose, etc.) as text on dark backgrounds.
- For photo additions: use the EXACT URL(s) provided in <img> tags. Style with creative framing per the event type.`;

      const stream = client.messages.stream({
        model: tweakModel,
        max_tokens: tweakMaxTokens,
        system: tweakSystemPrompt,
        messages: [{ role: 'user', content: messageContent }]
      });

      // Accumulate the full response while streaming progress
      let fullText = '';
      let chunkCount = 0;

      // Keepalive: send SSE comment every 3s to prevent mobile Safari from killing the connection
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (e) { /* connection already closed */ }
      }, 3000);

      // Use .on('text') (proven to work) + resolve on 'finalMessage' event
      // Capture finalMessage to get token usage for cost tracking
      let tweakFinalMessage = null;
      const tweakFinalPromise = new Promise(r => { stream.on('finalMessage', (msg) => { tweakFinalMessage = msg; r(msg); }); });
      await new Promise((resolve, reject) => {
        let resolved = false;
        let lastChunkTime = Date.now();
        const done = () => { if (!resolved) { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); resolve(); } };

        stream.on('text', (text) => {
          fullText += text;
          chunkCount++;
          lastChunkTime = Date.now();
          if (chunkCount % 10 === 0) {
            sendSSE('progress', { chunks: chunkCount, bytes: fullText.length });
          }
        });
        stream.on('finalMessage', () => done());
        stream.on('end', () => done());
        stream.on('error', (err) => { if (!resolved) { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); reject(err); } });

        const idleCheck = setInterval(() => {
          if (chunkCount > 0 && Date.now() - lastChunkTime > 15000 && fullText.length > 3000) {
            console.log('[stream] Idle timeout after', chunkCount, 'chunks,', fullText.length, 'bytes');
            done();
          }
        }, 1000);

        setTimeout(() => {
          if (!resolved) {
            console.log('[stream] Hard timeout at 120s, chunks:', chunkCount, 'bytes:', fullText.length);
            if (fullText.length > 0) done();
            else { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); reject(new Error('Stream timeout - no content received')); }
          }
        }, 120000);
      });

      // Estimate tokens immediately — accurate cost logged in background
      let tweakInputTokens = tweakFinalMessage?.usage?.input_tokens || 0;
      let tweakOutputTokens = tweakFinalMessage?.usage?.output_tokens || 0;
      if (tweakInputTokens === 0 && tweakOutputTokens === 0) {
        tweakOutputTokens = Math.round(fullText.length / 4);
        // Input = system prompt + user message (includes full current HTML/CSS + tweak instructions)
        const tweakSystemLen = tweakSystemPrompt?.length || 4000;
        const tweakMsgLen = tweakMessage?.length || 8000;
        tweakInputTokens = Math.round((tweakSystemLen + tweakMsgLen) / 4);
      }
      const latency = Date.now() - startTime;

      // Parse the accumulated text using robust parser
      // Light tweaks may return {html_replacements, rsvp_field_changes, chat_response} — no theme_html.
      // parseThemeResponse→normalizeThemeKeys throws when theme_html is missing, so handle light tweak
      // JSON separately to avoid the raw JSON leaking as a "chat" message.
      let theme;
      try {
        let lightTweakText = fullText.trim();
        // Strip markdown fences if present
        const fenceMatch = lightTweakText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) lightTweakText = fenceMatch[1].trim();
        try {
          const parsed = JSON.parse(lightTweakText);
          if (parsed && (parsed.html_replacements || parsed.rsvp_field_changes) && !parsed.theme_html && !parsed.html) {
            // Light tweak response — use directly without normalizeThemeKeys
            theme = parsed;
          } else {
            theme = parseThemeResponse(fullText);
          }
        } catch (_) {
          theme = parseThemeResponse(fullText);
        }
      } catch (parseErr) {
        // No valid JSON/HTML found — AI responded with conversational text instead of a theme.
        // Return it as a chat response so the client can display it gracefully.
        const chatOnlyCost = calcGenerationCost(tweakModel, tweakInputTokens, tweakOutputTokens);
        sendSSE('done', {
          success: true,
          chatOnly: true,
          chatResponse: fullText.trim(),
          theme: null,
          metadata: { model: tweakModel, latencyMs: Date.now() - startTime, tokens: { input: tweakInputTokens, output: tweakOutputTokens }, cost: chatOnlyCost }
        });
        res.end();
        // Log chat-only tweak to generation_log — still consumed tokens
        const chatOnlyMeta = getClientMeta(req);
        await supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak (chat): ' + tweakInstructions.substring(0, 200),
          model: tweakModel, input_tokens: tweakInputTokens,
          output_tokens: tweakOutputTokens, latency_ms: Date.now() - startTime, status: 'success',
          is_tweak: true, event_type: eventDetails?.eventType || '',
          client_ip: chatOnlyMeta.ip, client_geo: chatOnlyMeta.geo, user_agent: chatOnlyMeta.userAgent
        }).catch(e => console.error('Chat-only tweak log failed:', e.message));
        if (eventId) {
          await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: chatOnlyCost.totalCostCents })
            .catch(() => {});
        }
        await checkAndChargeAiUsage(user.id).catch(() => {});
        return;
      }

      // ── Email mode: handle email-specific response ──
      if (isEmailMode) {
        const emailHtmlResult = theme.theme_email_html || theme.email_html || null;

        if (isLightTweak && theme.html_replacements && Array.isArray(theme.html_replacements)) {
          // Apply replacements to email HTML
          console.log(`[tweak] Applying ${theme.html_replacements.length} email HTML replacement(s)`);
          let patchedEmail = currentEmailHtml || '';
          let appliedCount = 0;
          for (const rep of theme.html_replacements) {
            if (rep.old && rep.new !== undefined && patchedEmail.includes(rep.old)) {
              patchedEmail = patchedEmail.replace(rep.old, rep.new);
              appliedCount++;
            } else if (rep.old) {
              console.warn('[tweak] Email replacement not found:', rep.old.substring(0, 100));
            }
          }
          console.log(`[tweak] Applied ${appliedCount}/${theme.html_replacements.length} email replacements`);
          theme.theme_html = currentHtml;
          theme.theme_css = currentCss;
          theme.theme_config = { ...(currentConfig || {}), emailHtml: patchedEmail };
        } else if (emailHtmlResult) {
          // Full email design tweak — AI returned complete email HTML
          console.log(`[tweak] Got full email HTML from AI (${emailHtmlResult.length} chars)`);
          theme.theme_html = currentHtml;
          theme.theme_css = currentCss;
          theme.theme_config = { ...(currentConfig || {}), emailHtml: emailHtmlResult };
        } else {
          // No email changes — keep existing
          theme.theme_html = currentHtml;
          theme.theme_css = currentCss;
          theme.theme_config = currentConfig || {};
        }
      }
      // ── Light tweak: apply diff-based html_replacements ──
      else if (isLightTweak && theme.html_replacements && Array.isArray(theme.html_replacements)) {
        console.log(`[tweak] Applying ${theme.html_replacements.length} HTML replacement(s)`);
        let patchedHtml = currentHtml;
        let appliedCount = 0;
        for (const rep of theme.html_replacements) {
          if (rep.old && rep.new !== undefined && patchedHtml.includes(rep.old)) {
            patchedHtml = patchedHtml.replace(rep.old, rep.new);
            appliedCount++;
          } else if (rep.old) {
            console.warn('[tweak] Replacement not found in HTML:', rep.old.substring(0, 100));
          }
        }
        console.log(`[tweak] Applied ${appliedCount}/${theme.html_replacements.length} replacements`);
        theme.theme_html = patchedHtml;
        theme.theme_css = currentCss;
        theme.theme_config = currentConfig || {};
      } else if (isLightTweak && !theme.theme_html && !theme.html) {
        // Light tweak with only rsvp_field_changes, no HTML changes needed
        console.log('[tweak] Light tweak with no HTML changes (field-only)');
        theme.theme_html = currentHtml;
        theme.theme_css = currentCss;
        theme.theme_config = currentConfig || {};
      } else {
        // ── Full tweak: accept both snake_case and camelCase keys from Claude ──
        if (!theme.theme_html && theme.html) { theme.theme_html = theme.html; }
        if (!theme.theme_css && theme.css) { theme.theme_css = theme.css; }
        if (!theme.theme_config && theme.config) { theme.theme_config = theme.config; }
        if (!theme.theme_thankyou_html && theme.thankyou_html) { theme.theme_thankyou_html = theme.thankyou_html; }

        // Extract embedded CSS from HTML if missing
        if (theme.theme_html && !theme.theme_css) {
          const styleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
          if (styleMatch) {
            theme.theme_css = styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
            theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
          }
        }

        if (!theme.theme_html || !theme.theme_css) {
          const keys = Object.keys(theme).join(', ');
          throw new Error('Invalid tweak response — got keys: [' + keys + ']');
        }
      }

      // Merge config — use null for unchanged thank you page
      const tweakConfig = theme.theme_config || currentConfig || {};
      if (theme.theme_thankyou_html && theme.theme_thankyou_html !== null) {
        tweakConfig.thankyouHtml = theme.theme_thankyou_html;
      } else if (currentConfig?.thankyouHtml) {
        tweakConfig.thankyouHtml = currentConfig.thankyouHtml;
      }
      // Preserve emailHtml across non-email tweaks
      if (!tweakConfig.emailHtml && currentConfig?.emailHtml) {
        tweakConfig.emailHtml = currentConfig.emailHtml;
      }

      // Save tweak theme to DB BEFORE closing SSE so it's reliable
      const tweakCost = calcGenerationCost(tweakModel, tweakInputTokens, tweakOutputTokens);
      let savedTweakThemeId = 'pending';
      let savedTweakVersion = 0;
      try {
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

        const tweakInsert = {
          event_id: eventId, version: nextVersion, is_active: true,
          prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
          html: theme.theme_html, css: theme.theme_css, config: tweakConfig,
          model: tweakModel, input_tokens: tweakInputTokens,
          output_tokens: tweakOutputTokens, latency_ms: latency
        };
        if (basedOnThemeId) tweakInsert.based_on_theme_id = basedOnThemeId;
        var { data: newTweakTheme, error: tweakThemeError } = await supabase
          .from('event_themes').insert(tweakInsert).select().single();
        if (tweakThemeError) console.error('Failed to save tweak theme:', tweakThemeError.message);
        if (newTweakTheme) {
          savedTweakThemeId = newTweakTheme.id;
          savedTweakVersion = nextVersion;
        }
      } catch (saveErr) {
        console.error('Tweak theme DB save failed:', saveErr);
      }

      // Send result to client with real DB ID
      sendSSE('done', {
        success: true,
        theme: { id: savedTweakThemeId, version: savedTweakVersion, html: theme.theme_html, css: theme.theme_css, config: tweakConfig },
        chatResponse: theme.chat_response || null,
        rsvpFieldChanges: theme.rsvp_field_changes || null,
        isLightTweak,
        metadata: {
          model: tweakModel,
          latencyMs: latency,
          tokens: { input: tweakInputTokens, output: tweakOutputTokens },
          cost: tweakCost
        }
      });
      res.end();

      // Post-save: wait for accurate token counts and update
      try {

        // Now wait for accurate token usage (up to 5s) for cost logging
        try {
          await Promise.race([tweakFinalPromise, new Promise(r => setTimeout(r, 5000))]);
        } catch (e) { /* timeout is fine — use estimates */ }
        const finalTweakInputTokens = tweakFinalMessage?.usage?.input_tokens || tweakInputTokens;
        const finalTweakOutputTokens = tweakFinalMessage?.usage?.output_tokens || tweakOutputTokens;
        const finalTweakCost = calcGenerationCost(tweakModel, finalTweakInputTokens, finalTweakOutputTokens);

        // Update theme with accurate tokens if they differ
        if (finalTweakInputTokens !== tweakInputTokens || finalTweakOutputTokens !== tweakOutputTokens) {
          if (savedTweakThemeId && savedTweakThemeId !== 'pending') {
            await supabase.from('event_themes')
              .update({ input_tokens: finalTweakInputTokens, output_tokens: finalTweakOutputTokens })
              .eq('id', savedTweakThemeId);
          }
        }

        // CRITICAL: These must be awaited — fire-and-forget inserts get lost when
        // Vercel terminates the function after the handler returns.
        const tweakMeta = getClientMeta(req);
        const { error: tweakLogError } = await supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
          model: tweakModel, input_tokens: finalTweakInputTokens,
          output_tokens: finalTweakOutputTokens, latency_ms: latency, status: 'success',
          is_tweak: true, event_type: eventDetails?.eventType || '',
          client_ip: tweakMeta.ip, client_geo: tweakMeta.geo, user_agent: tweakMeta.userAgent
}).catch(() => {});
        // Atomically increment persistent event cost
        try {
          const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: tweakCost.totalCostCents });
          if (rpcErr) {
            const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
            if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + tweakCost.totalCostCents }).eq('id', eventId);
          }
        } catch (e) { /* non-critical */ }

        // Check if usage-based AI billing threshold is reached
        await checkAndChargeAiUsage(user.id).catch(e => console.error('AI billing check error:', e.message));
      } catch (saveErr) {
        console.error('Tweak DB save error (theme already sent to client):', saveErr);
      }

      return;
    } catch (err) {
      console.error('Theme tweak error:', err);
      const tweakErrMeta = getClientMeta(req);
      try {
        await supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + (tweakInstructions || '').substring(0, 200),
          model: tweakModel, input_tokens: 0, output_tokens: 0, latency_ms: Date.now() - startTime, status: 'error', error: err.message,
          is_tweak: true, event_type: eventDetails?.eventType || '', client_ip: tweakErrMeta.ip, client_geo: tweakErrMeta.geo, user_agent: tweakErrMeta.userAgent
        }).catch(() => {});
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
  const activePrompt = await getActivePrompt();
  const startTime = Date.now();

  // Set up SSE headers to avoid Vercel timeout
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Build RSVP fields description
    let rsvpFieldsDesc = 'Default fields: Name, Email, Phone, RSVP Status (Attending/Declined/Maybe)';
    if (rsvpFields?.length > 0) {
      rsvpFieldsDesc += '\nCustom fields: ' + rsvpFields.map(f => `${f.label} (${f.field_type}${f.is_required ? ', required' : ''})`).join(', ');
    }

    // Assess how specific the user's creative direction is
    const promptSpecificity = assessPromptSpecificity(effectivePrompt);

    // Build event-type-specific design DNA context (adapts to prompt specificity)
    const designDnaContext = buildEventTypeContext(eventType, effectivePrompt, activePrompt.designDna);

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
Make the button text fun and on-theme but NEVER imply commitment or attendance (no "Count Me In", "I'll Be There", "I'm Coming", "Sign Me Up"). The button opens the RSVP form where guests choose attending/declined/maybe — so use neutral action phrases like "Let's Party!", "RSVP Now!", "Open the Invite!", "Get the Details!".
RSVP fields and the button MUST be single-column, stacked vertically, full-width. NEVER use two-column or grid layouts for form elements.

Fields that will be injected (for awareness only — do NOT render):
${rsvpFieldsDesc}`;

    // Auto-include style references matching event type (adapts to prompt specificity)
    const styleRefs = await loadStyleReferences(eventType, promptSpecificity);
    const usedStyleIds = styleRefs.selectedIds || [];
    if (styleRefs.context) {
      userMessage += styleRefs.context;
    }

    // Add photo URLs if user uploaded photos
    if (allPhotoUrls.length > 0) {
      userMessage += `\n\n══════════════════════\nPHOTOS\n══════════════════════\n${allPhotoUrls.length} photo(s) provided. Use these EXACT URLs in <img> tags:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\n\nApply the photo treatment described in the design DNA above. Style with appropriate sizing, border-radius, box-shadow, and creative framing.`;
    }

    if (feedback) {
      userMessage += `\n\n**Feedback on previous version (incorporate this):**\n${feedback}`;
    }

    // Final contrast reminder (recency bias — model pays most attention to end of prompt)
    userMessage += `\n\n══════════════════════
⚠️ FINAL CHECK — TEXT CONTRAST (NON-NEGOTIABLE)
══════════════════════
Before outputting, mentally walk through EVERY text element and verify:
1. Dark/colored background sections (navy, green, black, charcoal, etc.) → text MUST be #FFFFFF or #FAFAFA
2. Light background sections → text MUST be #1A1A1A or darker
3. Buttons → text color must contrast against the button's background color
4. NEVER use accent colors (coral, salmon, rose, gold, etc.) as text on dark backgrounds — they FAIL contrast
5. The .details-slot CSS — if its background is dark, .detail-label and .detail-value MUST be white
6. The .thankyou-page CSS — .thankyou-title and .thankyou-subtitle must contrast against the page background
This is the most common failure mode. Double-check it.`;

    // Resolve inspiration images: use base64 if provided, otherwise fetch from URLs
    let resolvedInspirationImages = inspirationImages?.length > 0 ? inspirationImages : [];
    if (resolvedInspirationImages.length === 0 && inspirationImageUrls?.length > 0) {
      resolvedInspirationImages = await fetchImagesAsBase64(inspirationImageUrls);
    }

    if (resolvedInspirationImages.length > 0) {
      userMessage += `\n\n**Visual Inspiration:** I've provided ${resolvedInspirationImages.length} image(s) as inspiration. Analyze for color palette, mood, textures, and typography cues.`;
    }

    const messageContent = resolvedInspirationImages.length > 0
      ? [
          { type: 'text', text: userMessage },
          ...resolvedInspirationImages.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: img }
          }))
        ]
      : [{ type: 'text', text: userMessage }];

    sendSSE('status', { phase: 'generating' });

    // Stream response to keep connection alive and avoid Vercel timeout
    // Use client.messages.create({stream:true}) for raw async iterable — NOT
    // Use .on('text') (proven to work) + resolve on 'end' event
    // Do NOT use stream.finalMessage() — it blocks past Vercel's 60s timeout
    const stream = client.messages.stream({
      model: themeModel,
      max_tokens: 12288,
      system: activePrompt.systemPrompt,
      messages: [{ role: 'user', content: messageContent }]
    });

    let fullText = '';
    let chunkCount = 0;

    // Keepalive: send SSE comment every 3s to prevent mobile Safari from killing the connection
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (e) { /* connection already closed */ }
    }, 3000);

    // Accumulate text chunks; resolve on 'end' immediately to render ASAP
    // finalMessage (with token usage) is captured async for cost logging
    let genFinalMessage = null;
    const finalMessagePromise = new Promise(r => { stream.on('finalMessage', (msg) => { genFinalMessage = msg; r(msg); }); });
    await new Promise((resolve, reject) => {
      let resolved = false;
      let lastChunkTime = Date.now();
      const done = () => { if (!resolved) { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); resolve(); } };

      stream.on('text', (text) => {
        fullText += text;
        chunkCount++;
        lastChunkTime = Date.now();
        if (chunkCount % 10 === 0) {
          sendSSE('progress', { chunks: chunkCount, bytes: fullText.length });
        }
      });
      stream.on('finalMessage', () => done());
      stream.on('end', () => done());
      stream.on('error', (err) => { if (!resolved) { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); reject(err); } });

      // Safety: if text was flowing but stopped for 15s AND we have substantial content, assume done
      // Full invites with SVG illustrations can be 20-40KB — don't cut off early
      const idleCheck = setInterval(() => {
        if (chunkCount > 0 && Date.now() - lastChunkTime > 15000 && fullText.length > 5000) {
          console.log('[stream] Idle timeout after', chunkCount, 'chunks,', fullText.length, 'bytes');
          done();
        }
      }, 1000);

      // Hard timeout: 120s (Vercel Pro allows up to 300s via maxDuration config)
      setTimeout(() => {
        if (!resolved) {
          console.log('[stream] Hard timeout at 120s, chunks:', chunkCount, 'bytes:', fullText.length);
          if (fullText.length > 0) done();
          else { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); reject(new Error('Stream timeout - no content received')); }
        }
      }, 120000);
    });

    // Estimate tokens immediately for the client — accurate cost logged in background
    let genInputTokens = genFinalMessage?.usage?.input_tokens || 0;
    let genOutputTokens = genFinalMessage?.usage?.output_tokens || 0;
    const hadFinalMessage = !!genFinalMessage;
    if (genInputTokens === 0 && genOutputTokens === 0) {
      genOutputTokens = Math.round(fullText.length / 4);
      // Input = system prompt + user message (event details, style refs, design DNA, RSVP fields)
      // Both contribute to input tokens — user message is often larger than system prompt
      const systemLen = activePrompt.systemPrompt?.length || 8000;
      const userMsgLen = userMessage?.length || 4000;
      genInputTokens = Math.round((systemLen + userMsgLen) / 4);
    }
    console.log('[cost] Estimated tokens:', { hadFinalMessage, genInputTokens, genOutputTokens, fullTextLen: fullText.length, model: themeModel });
    const latency = Date.now() - startTime;

    // Parse JSON response — handle various wrapping patterns
    let theme = parseThemeResponse(fullText);

    // Normalize: ensure googleFontsImport is always a full @import statement
    if (theme.theme_config.googleFontsImport && !theme.theme_config.googleFontsImport.startsWith('@import')) {
      theme.theme_config.googleFontsImport = "@import url('" + theme.theme_config.googleFontsImport + "');";
    }

    // Validate invite completeness — check for required sections
    const hasRsvpSlot = theme.theme_html.includes('rsvp-slot') || theme.theme_html.includes('rsvp-button');
    const hasDataFields = theme.theme_html.includes('data-field=');
    if (!hasRsvpSlot || !hasDataFields) {
      console.warn('[generate-theme] Possibly truncated invite! rsvp-slot:', hasRsvpSlot, 'data-fields:', hasDataFields, 'html length:', theme.theme_html.length, 'bytes, chunks:', chunkCount);
      // If HTML is very short (< 3KB) and missing RSVP, it's likely truncated
      if (theme.theme_html.length < 3000 && !hasRsvpSlot) {
        throw new Error('Generated invite appears truncated (missing RSVP section, only ' + theme.theme_html.length + ' bytes). Please try again.');
      }
    }

    // Store thank you HTML in config to avoid DB schema change
    if (theme.theme_thankyou_html) {
      theme.theme_config.thankyouHtml = theme.theme_thankyou_html;
    } else {
      // Log whether fallback will work — AI CSS may still have .thankyou-page rules
      const hasTyCssRules = (theme.theme_css || '').includes('.thankyou-page');
      console.warn('[generate] thankyouHtml is empty. CSS has .thankyou-page rules:', hasTyCssRules, '— client fallback will be used');
    }

    // ── CSS FAILSAFE: If CSS is empty but HTML contains <style> blocks, extract them ──
    if ((!theme.theme_css || !theme.theme_css.trim()) && theme.theme_html) {
      const fallbackStyleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (fallbackStyleMatch) {
        const fallbackCss = fallbackStyleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
        if (fallbackCss.trim()) {
          console.warn('[generate] CSS was empty — extracted ' + fallbackCss.length + ' chars from <style> blocks in HTML');
          theme.theme_css = fallbackCss;
          theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        }
      }
    }
    if (!theme.theme_css || !theme.theme_css.trim()) {
      console.error('[generate] WARNING: Theme has no CSS! HTML length:', theme.theme_html?.length, 'Keys:', Object.keys(theme).join(', '));
    }

    // ── SERVER-SIDE THEME VALIDATION: Catch broken output before sending to client ──
    const validation = validateThemeIntegrity(theme);
    if (!validation.valid) {
      console.warn('[generate] Theme validation failed:', validation.issues.join(', '), '— attempting auto-repair');
      repairTheme(theme, validation.issues);
      // Re-validate after repair
      const recheck = validateThemeIntegrity(theme);
      if (!recheck.valid) {
        console.error('[generate] Theme still has issues after repair:', recheck.issues.join(', '));
      } else {
        console.log('[generate] Theme auto-repair succeeded');
      }
    }

    // CRITICAL: Send theme to client and close connection IMMEDIATELY.
    // res.text() on client buffers until res.end(), so DB saves MUST happen after.
    const genCost = calcGenerationCost(themeModel, genInputTokens, genOutputTokens);
    console.log('[cost] Sending to client:', { genCost, model: themeModel, inputTokens: genInputTokens, outputTokens: genOutputTokens });
    sendSSE('done', {
      success: true,
      theme: {
        id: 'pending',
        version: 1,
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config
      },
      metadata: {
        model: themeModel,
        latencyMs: latency,
        tokens: {
          input: genInputTokens,
          output: genOutputTokens
        },
        cost: genCost
      }
    });
    res.end(); // Unblock the client NOW — DB saves continue in background

    // Background DB saves — client already has the theme and connection is closed
    // CRITICAL: Save theme to DB IMMEDIATELY so resume works if user navigates away.
    // Accurate token counts are updated asynchronously after finalMessage arrives.
    try {
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

      // Save theme immediately with estimated tokens — don't block on finalMessage
      const genInsert = {
        event_id: eventId,
        version: nextVersion,
        is_active: true,
        prompt: effectivePrompt,
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config,
        model: themeModel,
        input_tokens: genInputTokens,
        output_tokens: genOutputTokens,
        latency_ms: latency,
        prompt_version_id: activePrompt.promptVersionId || null,
        style_library_ids: usedStyleIds
      };
      if (basedOnThemeId) genInsert.based_on_theme_id = basedOnThemeId;
      let { data: newTheme, error: themeError } = await supabase
        .from('event_themes').insert(genInsert).select().single();
      if (themeError && (themeError.message?.includes('prompt_version_id') || themeError.message?.includes('style_library_ids'))) {
        delete genInsert.prompt_version_id;
        delete genInsert.style_library_ids;
        ({ data: newTheme, error: themeError } = await supabase
          .from('event_themes').insert(genInsert).select().single());
      }
      if (themeError) console.error('Failed to save theme:', themeError.message);

      await supabase.from('events')
        .update({ first_generation_at: new Date().toISOString() })
        .eq('id', eventId).is('first_generation_at', null);

      // Now wait for accurate token usage (up to 5s) for cost logging
      try {
        await Promise.race([finalMessagePromise, new Promise(r => setTimeout(r, 5000))]);
      } catch (e) { /* timeout is fine — use estimates */ }
      const finalInputTokens = genFinalMessage?.usage?.input_tokens || genInputTokens;
      const finalOutputTokens = genFinalMessage?.usage?.output_tokens || genOutputTokens;
      const finalCost = calcGenerationCost(themeModel, finalInputTokens, finalOutputTokens);
      console.log('[cost] Background save tokens:', { finalInputTokens, finalOutputTokens, cost: finalCost, hadFinalMsg: !!genFinalMessage, usage: genFinalMessage?.usage });

      // Update theme with accurate tokens if they differ from estimates
      if (finalInputTokens !== genInputTokens || finalOutputTokens !== genOutputTokens) {
        if (newTheme?.id) {
          await supabase.from('event_themes')
            .update({ input_tokens: finalInputTokens, output_tokens: finalOutputTokens })
            .eq('id', newTheme.id);
        }
      }

      // Log generation with accurate tokens + increment cost
      // CRITICAL: These must be awaited — fire-and-forget inserts get lost when
      // Vercel terminates the function after the handler returns.
      const genMeta = getClientMeta(req);
      const { error: genLogError } = await supabase.from('generation_log').insert({
        event_id: eventId, user_id: user.id, prompt: effectivePrompt,
        model: themeModel, input_tokens: finalInputTokens,
        output_tokens: finalOutputTokens, latency_ms: latency,
        status: 'success', event_type: eventType, style_library_ids: usedStyleIds,
        prompt_version_id: activePrompt.promptVersionId || null,
        client_ip: genMeta.ip, client_geo: genMeta.geo, user_agent: genMeta.userAgent
}).catch(() => {});
      supabase.from('events')
        .update({ first_generation_at: new Date().toISOString() })
        .eq('id', eventId).is('first_generation_at', null)
        .then(() => {}).catch(() => {});
      // Atomically increment persistent event cost
      try {
        const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: genCost.totalCostCents });
        if (rpcErr) {
          const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
          if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + genCost.totalCostCents }).eq('id', eventId);
        }
      } catch (e) { /* non-critical */ }

      // Check if usage-based AI billing threshold is reached
      await checkAndChargeAiUsage(user.id).catch(e => console.error('AI billing check error:', e.message));
    } catch (saveErr) {
      console.error('DB save error (theme already sent to client):', saveErr);
    }

    return;
  } catch (err) {
    console.error('Theme generation error:', err);

    // Log error (don't let logging failure mask the real error)
    const errMeta = getClientMeta(req);
    try {
      await supabase.from('generation_log').insert({
        event_id: eventId,
        user_id: user.id,
        prompt: effectivePrompt,
        model: themeModel,
        input_tokens: typeof actualInputTokens !== 'undefined' ? actualInputTokens : 0,
        output_tokens: typeof actualOutputTokens !== 'undefined' ? actualOutputTokens : 0,
        latency_ms: Date.now() - startTime,
        status: 'error',
        error: (err.message || '').substring(0, 500),
        event_type: eventType,
        client_ip: errMeta.ip,
        client_geo: errMeta.geo,
        user_agent: errMeta.userAgent
      }).catch(() => {});
    } catch (logErr) {
      console.error('Failed to log generation error:', logErr);
    }

    sendSSE('error', { error: 'Failed to generate theme', message: err.message || 'Unknown error' });
    return res.end();
  }
}
