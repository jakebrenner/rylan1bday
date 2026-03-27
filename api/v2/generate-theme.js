import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
// AI generation is included in the $4.99 event price — no per-generation billing

const client = new Anthropic();
let _openaiClient = null;
function getOpenAIClient() {
  if (!_openaiClient && process.env.OPENAI_API_KEY) {
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-6';

// Allow up to 300s on Vercel Pro (caps at 60s on Hobby)
export const config = { maxDuration: 300 };

// Helper: detect if a model ID is an OpenAI model
function isOpenAIModel(model) {
  return model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
}

// Helper: o-series reasoning models use max_completion_tokens instead of max_tokens
function isOpenAIReasoningModel(model) {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
}

// Build OpenAI token limit param — reasoning models need max_completion_tokens
function openaiTokenParam(model, tokens) {
  return isOpenAIReasoningModel(model) ? { max_completion_tokens: tokens } : { max_tokens: tokens };
}

// AI model pricing per 1M tokens — must match billing.js, chat.js, ratings.js, admin.js
// Source: https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
// Source: https://openai.com/api/pricing/
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
  'gpt-4.1':                   { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':              { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':              { input: 0.10, output: 0.40 },
  'o3':                        { input: 2.00, output: 8.00 },
  'o4-mini':                   { input: 1.10, output: 4.40 },
};

function calcGenerationCost(model, inputTokens, outputTokens) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  // costCentsExact preserves precision for generation_log.cost_cents column
  return { rawCostCents: Math.round(rawCost * 100), costCentsExact: Math.round(rawCost * 100 * 10000) / 10000 };
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

// ── OpenAI compatibility: non-streaming call (for interpretField, classifyIntent, etc.) ──
async function openaiCreate(model, systemPrompt, userContent, maxTokens) {
  const oai = getOpenAIClient();
  if (!oai) throw new Error('OpenAI API key not configured — set OPENAI_API_KEY env var');
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(typeof userContent === 'string'
      ? [{ role: 'user', content: userContent }]
      : [{ role: 'user', content: userContent }])
  ];
  const response = await oai.chat.completions.create({
    model,
    ...openaiTokenParam(model, maxTokens),
    messages,
  });
  const text = response.choices?.[0]?.message?.content || '';
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    }
  };
}

// ── OpenAI compatibility: streaming call (returns async iterable of text chunks + usage) ──
function openaiStream(model, systemPrompt, userContent, maxTokens) {
  const oai = getOpenAIClient();
  if (!oai) throw new Error('OpenAI API key not configured — set OPENAI_API_KEY env var');

  // Convert Anthropic-style content blocks to OpenAI format
  let userMessage;
  if (Array.isArray(userContent)) {
    // Convert image blocks from Anthropic format to OpenAI format
    userMessage = userContent.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        };
      }
      return { type: 'text', text: String(block) };
    });
  } else {
    userMessage = userContent;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  // Return an object that mimics Anthropic's stream interface
  const listeners = { text: [], end: [], error: [], finalMessage: [] };
  const streamObj = {
    on(event, cb) { listeners[event] = listeners[event] || []; listeners[event].push(cb); return streamObj; },
  };

  // Start streaming in background
  const streamPromise = (async () => {
    try {
      const stream = await oai.chat.completions.create({
        model,
        ...openaiTokenParam(model, maxTokens),
        messages,
        stream: true,
        stream_options: { include_usage: true },
      });

      let totalText = '';
      let usage = { input_tokens: 0, output_tokens: 0 };

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          totalText += delta;
          for (const cb of listeners.text) cb(delta);
        }
        // Final chunk with usage stats
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens || 0,
            output_tokens: chunk.usage.completion_tokens || 0,
          };
        }
      }

      const finalMsg = { usage };
      for (const cb of listeners.finalMessage) cb(finalMsg);
      for (const cb of listeners.end) cb();
    } catch (err) {
      for (const cb of listeners.error) cb(err);
    }
  })();

  // Attach the promise so callers can await if needed
  streamObj._promise = streamPromise;
  return streamObj;
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
2. **HERO SECTION** — Large display headline with event title/names/tagline. Photo treatment if photos provided. CRITICAL: The event title must appear exactly ONCE in the hero — NEVER duplicate names, repeat the title, or split it across multiple elements that show the same information. For weddings with "Jake & Sarah's Wedding", do NOT separately show "Jake &" on one line, "Sarah's Wedding" on another, THEN repeat "& Sarah" again below. The title should be a single, coherent display.
3. **EVENT DETAILS** — \`<div class="details-slot"></div>\`. The platform injects event details (date, time, location, dress code) at runtime — just like the RSVP form. You MUST NOT put any text, icons, or labels inside this div. Style it via CSS to match the theme. The platform injects children with classes: \`.detail-item\`, \`.detail-icon\`, \`.detail-label\`, \`.detail-value\` — style these in theme_css.
4. **RSVP SECTION** — \`<div class="rsvp-slot"></div>\`. The rsvp-slot MUST be completely empty — the platform injects the RSVP form fields (name input, status dropdown, custom fields, submit button) directly into this div at runtime. NEVER put a button, link, text, or any content inside the rsvp-slot. NEVER create a "gate" or "reveal" pattern — the RSVP form is ALWAYS visible inline on the page, not hidden behind a button. You can add a heading above it like "KINDLY REPLY" or "RSVP" but the actual \`.rsvp-slot\` div must be empty.

## RSVP SLOT — CRITICAL PLATFORM RULES
- The \`.rsvp-slot\` is an EMPTY container. The platform fills it with form fields at runtime.
- NEVER put buttons, links, "Open Invitation", "RSVP Now", or ANY content inside \`.rsvp-slot\` — it must be completely empty like \`.details-slot\`
- NEVER create a click-to-reveal or button-gated pattern for the RSVP. The form is ALWAYS visible.
- Style \`.rsvp-slot\` with: \`display: flex; flex-direction: column; width: 100%;\`
- NEVER set \`.rsvp-slot\` to \`display: grid\`, \`flex-direction: row\`, or \`flex-wrap: wrap\` with side-by-side children
- All children of \`.rsvp-slot\` will be full-width form fields — style them via CSS to match the theme

## RSVP FORM STYLING — CRITICAL (platform injects these elements at runtime)
- The platform injects: text inputs, select dropdowns, labels, and a submit button into \`.rsvp-slot\`
- All injected form fields MUST render as a **single column** (stacked vertically, full-width)
- Style these classes in theme_css to match the theme:
  - \`.rsvp-slot input, .rsvp-slot select\` — form inputs. Set background, border, border-radius, padding (12px 14px), font-size (14px), color, width: 100%
  - \`.rsvp-slot label\` — field labels. Set font-size (13px), font-weight (600), color, margin-bottom (4px)
  - \`.rsvp-slot .rsvp-submit\` — the submit button. Make it prominent, full-width, min-height 52px, matching the theme's accent color
  - \`.rsvp-slot .rsvp-form-group\` — each field group (label + input). Set margin-bottom (14px)
- RSVP fields and submit button MUST ALWAYS be single-column. NEVER use two-column grid or side-by-side layouts — this is a 393px mobile viewport
- If the theme has a dark/colored RSVP section background, ensure form text and labels have sufficient contrast (white text on dark bg)

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

/* PLATFORM-INJECTED ELEMENTS — style these in theme_css to match the invite */
/* The platform injects calendar buttons, event recap, CTA, and footer after your HTML. */
/* You CANNOT generate these elements, but you MUST style them so they look polished. */
.cal-btn { border-radius: /* match invite button style */; font-family: /* same as invite */; }
/* Use ONE consistent color for all calendar buttons — NOT 3 different colors */
.cal-apple, .cal-google, .cal-outlook { background: /* one color from your palette */; color: #fff; }
/* On dark backgrounds: use rgba(255,255,255,0.12) with border:1px solid rgba(255,255,255,0.25) for a glassmorphic look */
/* On light backgrounds: use your primary/accent color as solid background */
.thankyou-event-recap { background: /* rgba overlay matching theme */; color: /* readable text */; border-radius: /* match invite style */; }
.thankyou-cta-section { border-top-color: /* subtle separator matching theme */; }
.thankyou-cta-btn { background: /* match invite button style */; color: #fff; border-radius: /* match invite style */; }
.thankyou-footer { color: /* readable on the thank you background */; }
\`\`\`

## TEXT CONTRAST — CRITICAL, NEVER VIOLATE
- EVERY piece of text must have sufficient contrast against its background (WCAG AA minimum)
- NEVER put light text on light backgrounds or dark text on dark backgrounds
- When using background images or gradients, add a semi-transparent overlay or text-shadow
- Button text MUST contrast against the button background color

### CONCRETE CONTRAST RULES FOR EACH SECTION:
- **Details slot** (\`.details-slot\`): If background is dark, \`.detail-label\` and \`.detail-value\` MUST be white (#FFFFFF/#FAFAFA). If light, use dark text (#1A1A1A). NEVER use accent colors as text on dark backgrounds.
- **Hero section**: If the background is dark or uses a dark gradient, title and subtitle text MUST be white/cream/very light.
- **RSVP section** (\`.rsvp-slot\`): The platform injects form labels, inputs, selects, and a submit button into \`.rsvp-slot\` at runtime. You MUST style \`.rsvp-slot\` with an explicit \`color\` that contrasts against its background. If the RSVP area has a dark/colored background, set \`.rsvp-slot { color: #FFFFFF; }\` or \`.rsvp-slot { color: #FAFAFA; }\`. If light background, set \`.rsvp-slot { color: #1A1A1A; }\`. The injected form elements use \`color: inherit\`, so whatever color you set on \`.rsvp-slot\` cascades to ALL labels, inputs, and text. Button text must be white on dark buttons or dark on light buttons. No exceptions.
- **RSVP form inputs**: Style \`.rsvp-slot input\`, \`.rsvp-slot select\`, \`.rsvp-slot textarea\` with readable text color. On dark backgrounds use \`color: #FFFFFF\` and \`background: rgba(255,255,255,0.15)\`. On light backgrounds use \`color: #1A1A1A\` and \`background: rgba(0,0,0,0.05)\`. NEVER leave input text color as a dark color on a dark RSVP background.
- **Thank you page**: The \`.thankyou-page\` background MUST match the invite. If dark, set \`.thankyou-title\`, \`.thankyou-subtitle\` to #FFFFFF. Style \`.cal-btn\`, \`.thankyou-event-recap\`, \`.thankyou-cta-btn\`, \`.thankyou-footer\` with appropriate contrast. On dark backgrounds use glassmorphic buttons (rgba(255,255,255,0.12) + border) and light text. On light backgrounds use your primary color for buttons and dark text.
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
// COMPLETENESS AUTO-FILL: Quick Haiku call to generate missing pieces
// Runs after main generation if thank you page, fonts, or config are missing.
// ═══════════════════════════════════════════════════════════════════
async function generateMissingPieces(theme, missingPieces, eventDetails) {
  const needsThankyou = missingPieces.includes('thankyou_html');
  const needsFonts = missingPieces.includes('googleFontsImport');
  const needsBgColor = missingPieces.includes('backgroundColor');
  const needsHeadlineFont = missingPieces.includes('fontHeadline');

  // Extract key visual info from the existing theme to guide the fill
  const cssSnippet = (theme.theme_css || '').substring(0, 2000); // First 2KB of CSS for context
  const htmlSnippet = (theme.theme_html || '').substring(0, 1000); // First 1KB of HTML for context
  const config = theme.theme_config || {};

  let prompt = `You are a theme completeness assistant. An AI designer generated an event invite but MISSED some required pieces. Your job is to fill in ONLY the missing pieces based on the existing theme.

## EXISTING THEME CONTEXT
Event: ${eventDetails?.title || 'Event'} (${eventDetails?.eventType || 'other'})
Existing config: ${JSON.stringify({ primaryColor: config.primaryColor, secondaryColor: config.secondaryColor, accentColor: config.accentColor, backgroundColor: config.backgroundColor, fontHeadline: config.fontHeadline, fontBody: config.fontBody, googleFontsImport: config.googleFontsImport })}

CSS preview (first 2KB):
\`\`\`css
${cssSnippet}
\`\`\`

HTML preview (first 1KB):
\`\`\`html
${htmlSnippet}
\`\`\`

## WHAT'S MISSING — Generate ONLY these:
${needsThankyou ? `
### thankyou_html (REQUIRED)
Generate a complete thank you page wrapper that visually matches the invite theme.
Rules:
- Must be a \`<div class="thankyou-page">\` containing a \`<div class="thankyou-decoration">\` with an inline SVG illustration (under 2KB, with CSS animation) and an empty \`<div class="thankyou-hero"></div>\`
- .thankyou-page MUST have a background matching the invite (gradient, color, or pattern)
- .thankyou-hero MUST be completely empty — the platform fills it
- NO text, NO emojis, NO calendar buttons inside
- The SVG illustration should match the event type and theme mood

### thankyou_css (REQUIRED if thankyou_html is provided)
CSS rules for .thankyou-page, .thankyou-decoration, .thankyou-hero, .thankyou-title, .thankyou-subtitle, .cal-btn, .cal-apple, .cal-google, .cal-outlook, .thankyou-event-recap, .thankyou-cta-section, .thankyou-cta-btn, .thankyou-footer
- Colors and fonts MUST match the invite theme
- On dark backgrounds: use rgba(255,255,255,0.12) for buttons with border:1px solid rgba(255,255,255,0.25)
- On light backgrounds: use primary/accent color for buttons
` : ''}
${needsFonts ? `
### googleFontsImport (REQUIRED)
Analyze the CSS font-family declarations and provide the correct Google Fonts @import URL.
Format: @import url('https://fonts.googleapis.com/css2?family=...');
` : ''}
${needsBgColor ? `
### backgroundColor (REQUIRED)
Analyze the CSS and determine the main background color of the invite body. Return as hex.
` : ''}
${needsHeadlineFont ? `
### fontHeadline (REQUIRED)
Analyze the CSS font-family declarations for h1/h2 elements and return the headline font name.
` : ''}

## OUTPUT FORMAT
Return ONLY a valid JSON object with the missing pieces:
{
  ${needsThankyou ? '"thankyou_html": "<div class=\\"thankyou-page\\">...</div>",' : ''}
  ${needsThankyou ? '"thankyou_css": ".thankyou-page { ... } .thankyou-decoration { ... } ...",' : ''}
  ${needsFonts ? '"googleFontsImport": "@import url(\'...\');",' : ''}
  ${needsBgColor ? '"backgroundColor": "#hex",' : ''}
  ${needsHeadlineFont ? '"fontHeadline": "Font Name",' : ''}
  "fontBody": "Font Name or null"
}`;

  const startTime = Date.now();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: needsThankyou ? 4096 : 512,
    system: 'You are a precise JSON generator. Return ONLY valid JSON, no markdown fences, no explanation.',
    messages: [{ role: 'user', content: prompt }]
  });

  const latency = Date.now() - startTime;
  console.log('[completeness] Haiku fill completed in', latency, 'ms');

  let text = response.content[0]?.text || '';
  // Strip markdown fences if present
  text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```$/g, '').trim();

  try {
    const result = JSON.parse(text);
    // Normalize thankyou_html escaping
    if (result.thankyou_html) {
      while (result.thankyou_html.includes('\\"')) result.thankyou_html = result.thankyou_html.replace(/\\"/g, '"');
      if (result.thankyou_html.includes('\\n')) result.thankyou_html = result.thankyou_html.replace(/\\n/g, '\n');
    }
    if (result.thankyou_css) {
      while (result.thankyou_css.includes('\\"')) result.thankyou_css = result.thankyou_css.replace(/\\"/g, '"');
      if (result.thankyou_css.includes('\\n')) result.thankyou_css = result.thankyou_css.replace(/\\n/g, '\n');
    }
    // Normalize googleFontsImport
    if (result.googleFontsImport && !result.googleFontsImport.startsWith('@import')) {
      result.googleFontsImport = "@import url('" + result.googleFontsImport + "');";
    }
    return result;
  } catch (e) {
    console.error('[completeness] Failed to parse Haiku response:', text.substring(0, 200));
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// ROBUST THEME RESPONSE PARSER (duplicated from prompt-test.js — Vercel
// serverless functions can't share imports)
// ═══════════════════════════════════════════════════════════════════
function parseThemeResponse(rawText) {
  let text = (typeof rawText === 'string' ? rawText : '').trim();
  // ALL paths funnel through normalizeThemeKeys at the end to fix escaping
  if (text.match(/^<!DOCTYPE/i) || text.match(/^<html/i)) return normalizeThemeKeys(extractThemeFromHtmlDoc(text));
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
      if (htmlMatch) return normalizeThemeKeys(extractThemeFromHtmlDoc(htmlMatch[0]));
    } else if (text.match(/^\{\s*--/) || text.match(/^\s*:root\s*\{/)) {
      // Model returned raw CSS (possibly followed by HTML)
      const htmlStart = text.match(/<(div|section|main|header|article)\b/i);
      if (htmlStart) {
        const htmlIdx = text.indexOf(htmlStart[0]);
        return normalizeThemeKeys({ theme_html: text.substring(htmlIdx).trim(), theme_css: text.substring(0, htmlIdx).trim(), theme_config: {}, theme_thankyou_html: '' });
      }
      if (text.includes('.') && text.includes('{')) {
        return normalizeThemeKeys({ theme_html: '', theme_css: text, theme_config: {}, theme_thankyou_html: '' });
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
      if (rawText.includes('<div') || rawText.includes('<section') || rawText.includes('<style')) return normalizeThemeKeys(extractThemeFromHtmlDoc(rawText));
      // Try splitting CSS + HTML if raw text contains HTML elements
      const htmlTag = rawText.match(/<(div|section|main|header|article)\b/i);
      if (htmlTag) {
        const idx = rawText.indexOf(htmlTag[0]);
        const html = rawText.substring(idx).trim();
        if (html.length > 100) return normalizeThemeKeys({ theme_html: html, theme_css: rawText.substring(0, idx).trim(), theme_config: {}, theme_thankyou_html: '' });
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
  // Fix multi-level escaped quotes in HTML/CSS (models sometimes output \\\" or deeper nesting)
  // Loop until stable — one pass of \\" → \" still leaves a backslash-quote
  while (theme.theme_html && theme.theme_html.includes('\\"')) theme.theme_html = theme.theme_html.replace(/\\"/g, '"');
  while (theme.theme_css && theme.theme_css.includes('\\"')) theme.theme_css = theme.theme_css.replace(/\\"/g, '"');
  while (theme.theme_thankyou_html && theme.theme_thankyou_html.includes('\\"')) theme.theme_thankyou_html = theme.theme_thankyou_html.replace(/\\"/g, '"');
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

  // 9. Content completeness — required platform elements
  if (html) {
    const hasDetailsSlot = /class\s*=\s*["'][^"']*\bdetails-slot\b/.test(html);
    const hasLegacyDetails = /data-field\s*=\s*["'](datetime|location)["']/.test(html);
    if (!hasDetailsSlot && !hasLegacyDetails) issues.push('missing_details_slot');

    const hasRsvpSlot = /class\s*=\s*["'][^"']*\brsvp-slot\b/.test(html) || /class\s*=\s*["'][^"']*\brsvp-button\b/.test(html);
    if (!hasRsvpSlot) issues.push('missing_rsvp_slot');

    const hasTitleField = /data-field\s*=\s*["']title["']/.test(html);
    if (!hasTitleField) issues.push('missing_title_field');

    // Check for meaningful text content (strip tags, check remaining text length)
    const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (textOnly.length < 20) issues.push('content_too_sparse');
  }

  // 9b. Thank you page completeness
  if (!theme.theme_thankyou_html || theme.theme_thankyou_html.trim().length < 50) {
    issues.push('missing_thankyou_html');
  }
  // 9c. Config completeness — these drive the fallback rendering on the client
  if (!theme.theme_config?.googleFontsImport) issues.push('missing_google_fonts_import');
  if (!theme.theme_config?.backgroundColor) issues.push('missing_background_color');

  // ── 10. CSS Visual Rendering Analysis ──
  // Catch CSS patterns that produce invisible/broken output the AI commonly generates.
  // These are auto-repaired by repairTheme() before the client ever sees them.
  if (css && html) {
    // 10a. Invisible text — color matching background-color on same selector
    const ruleBlocks = css.match(/[^{}]+\{[^}]+\}/g) || [];
    for (const rule of ruleBlocks) {
      const colorMatch = rule.match(/(?:^|;\s*)color\s*:\s*([^;!}]+)/i);
      const bgMatch = rule.match(/background(?:-color)?\s*:\s*([^;!}]+)/i);
      if (colorMatch && bgMatch) {
        const c = colorMatch[1].trim().toLowerCase().replace(/\s+/g, '');
        const bg = bgMatch[1].trim().toLowerCase().replace(/\s+/g, '');
        // Exact match (white on white, #fff on #fff, etc.) — not gradient backgrounds
        if (c === bg && !bg.includes('gradient') && !bg.includes('url(')) {
          issues.push('css_invisible_text');
          break;
        }
      }
    }

    // 10b. Offscreen positioning — elements pushed way off viewport
    if (/(?:left|right|top|margin-left|margin-right|transform)\s*:\s*-(?:9{3,}|[5-9]\d{3,})px/i.test(css)) {
      issues.push('css_offscreen_content');
    }
    // translateX/Y with large negative values
    if (/translate[XY]?\s*\(\s*-(?:9{3,}|[1-9]\d{3,})px/i.test(css)) {
      issues.push('css_offscreen_content');
    }

    // 10c. Zero-dimension key containers
    const keySelectors = ['rsvp-slot', 'details-slot', 'rsvp-button'];
    for (const sel of keySelectors) {
      // Find rule blocks that target this selector
      const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');
      const selMatch = css.match(selRegex);
      if (selMatch) {
        const rules = selMatch[1];
        if (/(?:^|;\s*)(?:width|height)\s*:\s*0(?:px)?\s*(?:[;!}]|$)/i.test(rules) &&
            !/overflow/.test(rules)) {
          issues.push('css_zero_dimension_' + sel.replace('-', '_'));
        }
      }
    }

    // 10d. Permanent opacity:0 without animation (elements invisible forever)
    // Check if any key element has opacity:0 but no animation that restores it
    for (const sel of keySelectors) {
      const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');
      const selMatch = css.match(selRegex);
      if (selMatch) {
        const rules = selMatch[1];
        if (/opacity\s*:\s*0\s*[;!}]/i.test(rules)) {
          // Check if there's an animation that would restore it
          const animName = rules.match(/animation(?:-name)?\s*:\s*([\w-]+)/i);
          if (animName) {
            // Check if the @keyframes ends at opacity > 0
            const kfRegex = new RegExp('@keyframes\\s+' + animName[1] + '\\s*\\{([\\s\\S]*?)\\}\\s*\\}', 'i');
            const kfMatch = css.match(kfRegex);
            if (kfMatch && /(?:to|100%)\s*\{[^}]*opacity\s*:\s*(?:0(?:\.0+)?)\s*[;!}]/i.test(kfMatch[1])) {
              issues.push('css_animation_hides_' + sel.replace('-', '_'));
            } else if (!kfMatch) {
              // opacity:0 with animation referencing nonexistent keyframes
              issues.push('css_opacity_zero_' + sel.replace('-', '_'));
            }
          } else {
            // opacity:0 with no animation at all — permanently invisible
            issues.push('css_opacity_zero_' + sel.replace('-', '_'));
          }
        }
      }
    }

    // 10e. Overflow clipping on containers with very small fixed heights
    for (const sel of ['rsvp-slot', 'details-slot']) {
      const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');
      const selMatch = css.match(selRegex);
      if (selMatch) {
        const rules = selMatch[1];
        const hasOverflowHidden = /overflow\s*:\s*hidden/i.test(rules);
        const heightMatch = rules.match(/(?:max-)?height\s*:\s*(\d+)px/i);
        if (hasOverflowHidden && heightMatch && parseInt(heightMatch[1]) < 30) {
          issues.push('css_clipped_' + sel.replace('-', '_'));
        }
      }
    }

    // 10f. display:none on key elements (outside @media queries)
    // Strip @media blocks first, then check for display:none on key selectors
    const cssNoMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    for (const sel of keySelectors) {
      const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');
      const selMatch = cssNoMedia.match(selRegex);
      if (selMatch && /display\s*:\s*none/i.test(selMatch[1])) {
        issues.push('css_display_none_' + sel.replace('-', '_'));
      }
    }

    // 10g. visibility:hidden on key elements (outside @media and @keyframes)
    const cssNoMediaKf = cssNoMedia.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    for (const sel of keySelectors) {
      const selRegex = new RegExp('\\.' + sel.replace('-', '[-]?') + '\\s*\\{([^}]+)\\}', 'i');
      const selMatch = cssNoMediaKf.match(selRegex);
      if (selMatch && /visibility\s*:\s*hidden/i.test(selMatch[1])) {
        issues.push('css_visibility_hidden_' + sel.replace('-', '_'));
      }
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

  // Inject missing platform elements so the client can still inject content
  if (issues.includes('missing_title_field')) {
    // Try to add data-field="title" to the first prominent heading
    const headingMatch = (theme.theme_html || '').match(/<(h[12])\b([^>]*)>/i);
    if (headingMatch) {
      const tag = headingMatch[0];
      if (!tag.includes('data-field')) {
        theme.theme_html = theme.theme_html.replace(tag, tag.replace('>', ' data-field="title">'));
        console.log('[repairTheme] Added data-field="title" to existing heading');
      }
    }
  }

  if (issues.includes('missing_rsvp_slot')) {
    // Inject minimal RSVP slot at end of HTML
    theme.theme_html = (theme.theme_html || '') + '\n<div class="rsvp-slot"></div>';
    console.log('[repairTheme] Injected missing .rsvp-slot');
  }

  if (issues.includes('missing_details_slot')) {
    // Inject details slot before RSVP slot if possible, otherwise at end
    const rsvpIdx = (theme.theme_html || '').indexOf('rsvp-slot');
    if (rsvpIdx > 0) {
      // Find the opening tag of the rsvp-slot container
      const beforeRsvp = theme.theme_html.lastIndexOf('<', rsvpIdx);
      if (beforeRsvp >= 0) {
        theme.theme_html = theme.theme_html.slice(0, beforeRsvp) + '<div class="details-slot"></div>\n' + theme.theme_html.slice(beforeRsvp);
        console.log('[repairTheme] Injected missing .details-slot before rsvp-slot');
      }
    } else {
      theme.theme_html = (theme.theme_html || '') + '\n<div class="details-slot"></div>';
      console.log('[repairTheme] Injected missing .details-slot at end');
    }
  }

  // ── CSS Visual Rendering Repairs ──
  // Fix CSS patterns that produce invisible/broken output.
  // These repairs are surgical — they target only the specific broken property
  // without regenerating the entire theme.

  // Helper: replace a CSS property within a specific selector's rule block
  function replaceCssProperty(css, selectorPart, propRegex, replacement) {
    const selRegex = new RegExp('(\\.' + selectorPart.replace('-', '[-]?') + '\\s*\\{)([^}]+)(\\})', 'i');
    return css.replace(selRegex, (match, open, rules, close) => {
      return open + rules.replace(propRegex, replacement) + close;
    });
  }

  // 10a. Invisible text (color same as background) — set text to contrasting color
  if (issues.includes('css_invisible_text')) {
    const ruleBlocks = (theme.theme_css || '').match(/([^{}]+)\{([^}]+)\}/g) || [];
    for (const rule of ruleBlocks) {
      const colorMatch = rule.match(/(?:^|;\s*)color\s*:\s*([^;!}]+)/i);
      const bgMatch = rule.match(/background(?:-color)?\s*:\s*([^;!}]+)/i);
      if (colorMatch && bgMatch) {
        const c = colorMatch[1].trim().toLowerCase().replace(/\s+/g, '');
        const bg = bgMatch[1].trim().toLowerCase().replace(/\s+/g, '');
        if (c === bg && !bg.includes('gradient') && !bg.includes('url(')) {
          // Flip text to contrasting color: light bg → dark text, dark bg → light text
          const isLightBg = /(?:white|#f|#e|rgb\s*\(\s*2[0-5]\d|rgba?\s*\(\s*2[0-5]\d)/i.test(bg);
          const contrastColor = isLightBg ? '#1a1a1a' : '#ffffff';
          theme.theme_css = theme.theme_css.replace(
            new RegExp('(color\\s*:\\s*)' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            '$1' + contrastColor
          );
          console.log('[repairTheme] Fixed invisible text: set color to', contrastColor);
          break; // Fix first occurrence
        }
      }
    }
  }

  // 10b. Offscreen content — remove offscreen positioning
  if (issues.includes('css_offscreen_content')) {
    theme.theme_css = theme.theme_css
      .replace(/(?:left|right|margin-left|margin-right)\s*:\s*-(?:9{3,}|[5-9]\d{3,})px[^;]*;?/gi, '')
      .replace(/transform\s*:\s*translate[XY]?\s*\(\s*-(?:9{3,}|[1-9]\d{3,})px[^;)]*\)[^;]*;?/gi, '');
    console.log('[repairTheme] Removed offscreen positioning rules');
  }

  // 10c/10d/10f/10g. Fix display:none, visibility:hidden, opacity:0, zero dimensions on key elements
  const keySels = ['rsvp-slot', 'details-slot', 'rsvp-button'];
  for (const sel of keySels) {
    const selKey = sel.replace('-', '_');
    if (issues.some(i => i === 'css_display_none_' + selKey)) {
      theme.theme_css = replaceCssProperty(theme.theme_css, sel, /display\s*:\s*none\s*;?/gi, 'display: block;');
      console.log('[repairTheme] Fixed display:none on .' + sel);
    }
    if (issues.some(i => i === 'css_visibility_hidden_' + selKey)) {
      theme.theme_css = replaceCssProperty(theme.theme_css, sel, /visibility\s*:\s*hidden\s*;?/gi, 'visibility: visible;');
      console.log('[repairTheme] Fixed visibility:hidden on .' + sel);
    }
    if (issues.some(i => i === 'css_opacity_zero_' + selKey || i === 'css_animation_hides_' + selKey)) {
      theme.theme_css = replaceCssProperty(theme.theme_css, sel, /opacity\s*:\s*0\s*;?/gi, 'opacity: 1;');
      console.log('[repairTheme] Fixed opacity:0 on .' + sel);
    }
    if (issues.some(i => i === 'css_zero_dimension_' + selKey)) {
      theme.theme_css = replaceCssProperty(theme.theme_css, sel, /(?:width|height)\s*:\s*0(?:px)?\s*;?/gi, '');
      console.log('[repairTheme] Removed zero width/height on .' + sel);
    }
    if (issues.some(i => i === 'css_clipped_' + selKey)) {
      theme.theme_css = replaceCssProperty(theme.theme_css, sel, /overflow\s*:\s*hidden\s*;?/gi, 'overflow: visible;');
      console.log('[repairTheme] Fixed overflow clipping on .' + sel);
    }
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

  // Parse action early so we can skip generation limits for lightweight operations
  const action = req.query?.action || req.body?.action || 'generate';
  const isLightweightAction = action === 'interpretField' || action === 'classifyIntent' || action === 'tweak';

  // Check per-event generation limits (free tier: 1 + 1 redo, paid: soft cap 10)
  // Skip for lightweight actions (interpretField, classifyIntent, tweak) — these are cheap
  // Haiku calls for text/RSVP edits and should always be allowed on free/unpaid events.
  // The frontend gates design changes (Tier 3) behind the paywall; only text tweaks get through.
  try {
    const eventIdForCheck = !isLightweightAction ? req.body?.eventId : null;
    if (eventIdForCheck) {
      // Get event payment status + free generation flags
      const { data: eventForLimit } = await supabase
        .from('events')
        .select('payment_status, user_id, free_generation_used, free_redo_used')
        .eq('id', eventIdForCheck)
        .single();

      if (eventForLimit && eventForLimit.user_id === user.id) {
        // Unpaid events — check if user has credits to unlock before blocking
        if (eventForLimit.payment_status === 'unpaid') {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('purchased_event_credits, free_event_credits')
            .eq('id', user.id)
            .single();

          let newStatus = null;
          if (profileData && (profileData.purchased_event_credits || 0) > 0) {
            newStatus = 'paid';
            await supabase.from('profiles').update({ purchased_event_credits: (profileData.purchased_event_credits || 0) - 1 }).eq('id', user.id);
          } else if (profileData && (profileData.free_event_credits || 0) > 0) {
            // Admin-granted free credits give full paid access (not limited free-tier)
            newStatus = 'paid';
            await supabase.from('profiles').update({ free_event_credits: (profileData.free_event_credits || 0) - 1 }).eq('id', user.id);
          } else {
            // Check if this is the user's ONLY event (first event is free)
            // Count all events to prevent loopholes from refunded/archived events
            const { count: totalEventCount } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
            if ((totalEventCount || 0) <= 1) newStatus = 'free';
          }

          if (newStatus) {
            await supabase.from('events').update({ payment_status: newStatus }).eq('id', eventIdForCheck);
            eventForLimit.payment_status = newStatus;
          }
        }

        // Refunded events must pay before generating
        if (eventForLimit.payment_status === 'refunded') {
          return res.status(403).json({
            error: 'This event requires payment before generating designs. Upgrade for $4.99.',
            limitReached: true,
            requiresPayment: true,
            freeRedoAvailable: false,
            generationCount: 0,
            generationLimit: 0
          });
        }

        // Unpaid and free events both get 1 free generation + 1 redo
        if (eventForLimit.payment_status === 'free' || eventForLimit.payment_status === 'unpaid') {
          const freeGenUsed = eventForLimit.free_generation_used;
          const freeRedoUsed = eventForLimit.free_redo_used;
          const isFreeRedo = req.body?.freeRedo === true;

          // Column exists and first gen is used
          if (freeGenUsed === true) {
            // Allow one redo if the design was completely wrong
            if (isFreeRedo && freeRedoUsed !== true) {
              // Allow — redo will be marked as used after success
              req._isFreeRedo = true;
            } else {
              return res.status(403).json({
                error: freeRedoUsed
                  ? 'Your free event includes 1 AI design. Upgrade to $4.99 for unlimited designs.'
                  : 'Your free event includes 1 AI design. If the design was completely wrong, tell me what\'s off and I can try once more.',
                limitReached: true,
                requiresPayment: true,
                freeRedoAvailable: freeRedoUsed !== true,
                generationCount: 1,
                generationLimit: 1
              });
            }
          }
          // Column doesn't exist (null/undefined) — fallback to generation_log count
          else if (freeGenUsed == null) {
            const { count: fallbackCount } = await supabase
              .from('generation_log')
              .select('id', { count: 'exact', head: true })
              .eq('event_id', eventIdForCheck)
              .eq('status', 'success');

            if ((fallbackCount || 0) >= 2) {
              return res.status(403).json({
                error: 'Your free event includes 1 AI design. Upgrade to $4.99 for unlimited designs.',
                limitReached: true,
                requiresPayment: true,
                freeRedoAvailable: false,
                generationCount: fallbackCount,
                generationLimit: 1
              });
            }
          }
          // freeGenUsed === false → first generation, allow it
        }

        // Paid events: soft cap at 10 (include flag but don't block)
        if (eventForLimit.payment_status === 'paid') {
          const { count: eventGenCount } = await supabase
            .from('generation_log')
            .select('id', { count: 'exact', head: true })
            .eq('event_id', eventIdForCheck)
            .eq('status', 'success');

          if ((eventGenCount || 0) >= 10) {
            res.softCapReached = true;
          }
        }
      }
    }
  } catch (e) {
    console.error('Generation limit check failed, blocking generation:', e.message);
    return res.status(500).json({ error: 'Unable to verify generation limits. Please try again.' });
  }

  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages, inspirationImageUrls, tweakInstructions, currentHtml, currentCss, currentConfig, photoBase64, photoUrl, photoUrls, existingPhotos, basedOnThemeId, previewMode, currentEmailHtml, classifiedIntent } = req.body;

  // --- INTERPRET FIELD: quick Haiku call to parse natural language into field definition ---
  if (action === 'interpretField') {
    const { userMessage, existingFields, eventId: fieldEventId } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

    try {
      const fieldStartTime = Date.now();
      const fieldList = (existingFields || []).map(f => f.label).join(', ');
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: 'You interpret natural language requests to add RSVP form fields. Return ONLY a JSON array, no markdown.',
        messages: [{ role: 'user', content: `The user said: "${userMessage}"

Existing fields: ${fieldList || 'none'}

Return a JSON array of field objects to add (even if just one):
[{"label": "Human-readable label", "field_key": "snake_case_key", "field_type": "text|number|textarea|email|phone|select|checkbox", "is_required": false, "placeholder": "helpful placeholder text"}]

Rules:
- Pick the most appropriate field_type (number for counts/quantities, textarea for messages/notes, etc.)
- label should be clean and title-case (e.g. "Number of Pets", "Song Request")
- placeholder should be a helpful example (e.g. "e.g., 2", "Any song that gets you moving!")
- Do NOT duplicate existing fields
- If the user mentions multiple fields, return one object per field` }]
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
        is_tweak: true, cost_cents: fieldCost.costCentsExact
      });
      if (fieldLogError) console.error('Field generation_log insert failed:', fieldLogError.message);
      if (fieldEventId) {
try {
          const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: fieldEventId, p_cost_cents: fieldCost.rawCostCents });
          if (rpcErr) {
            const { data } = await supabase.from('events').select('total_cost_cents').eq('id', fieldEventId).single();
            if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + fieldCost.rawCostCents }).eq('id', fieldEventId);
          }
        } catch (e) { /* non-critical */ }
      }
      // AI generation included in $4.99 event price — no per-generation billing

      let fields;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        const parsed = JSON.parse(cleaned);
        fields = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return res.status(500).json({ error: 'Failed to parse field', raw: text });
      }
      return res.json({ success: true, fields, field: fields[0], metadata: { cost: fieldCost } });
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
      const classifyStartTime = Date.now();
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
  "intent": "add_field|remove_field|modify_field|design_change|text_change|add_photo|detail_change|question|broken_render|unclear",
  "confidence": 0.0 to 1.0,
  "summary": "One sentence: what the user wants",
  "clarification": "A friendly question to ask if you're not confident (null if confident)",
  "suggested_options": ["option1", "option2", "option3"] or null
}

Rules:
- "add_field": user wants to add an RSVP form field (e.g. "add number of adults", "I need a dietary field")
- "design_change": visual changes (colors, fonts, layout, style, animations, spacing). Also includes requests that reference design elements like "remove the image", "change the text below the photo", "make the picture bigger" — these are about the DESIGN, not about uploading new photos
- "text_change": change, add, or remove specific text/wording/copy in the invite (e.g. "remove where it says Live August 2026", "add description text", "change the heading")
- "add_photo": user explicitly wants to UPLOAD or INCLUDE a new photo/image in the design (e.g. "add my photo", "I want to upload a picture", "include a selfie"). NOT for referencing existing design elements — "remove the image at the top" is text_change or design_change, NOT add_photo
- "detail_change": user wants to change event details like date, time, location, venue, dress code, or event title (e.g. "change the date to April 20", "move the time to 7pm", "update the location"). These changes happen in the Details tab, not through design tweaks
- "question": user is asking a question, not requesting a change
- "broken_render": user is reporting the invite looks broken, is missing content/text/fields, appears blank, cut off, or didn't render correctly (e.g. "it's missing all the text", "nothing is showing", "where are the fields", "the invite is blank")
- "unclear": you genuinely can't determine what they want
- confidence 0.9+: crystal clear request. confidence 0.5-0.8: probably understand but should confirm. confidence <0.5: genuinely unclear
- For add_field with confidence >= 0.8, include "field_details": {"label": "...", "field_type": "..."} so we can skip a second AI call
- The clarification should be warm, conversational, and show you understood SOMETHING (never "what do you mean?")
- suggested_options: 2-3 clickable options that help the user clarify (null if confident)` }]
      });

      const text = resp.content[0]?.text?.trim() || '';
      const classifyInputTokens = resp.usage?.input_tokens || 0;
      const classifyOutputTokens = resp.usage?.output_tokens || 0;
      const classifyLatency = Date.now() - classifyStartTime;
      const classifyCost = calcGenerationCost('claude-haiku-4-5-20251001', classifyInputTokens, classifyOutputTokens);
      let classification;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        classification = JSON.parse(cleaned);
      } catch {
        // If parsing fails, return a conservative "unclear" classification
        classification = { intent: 'unclear', confidence: 0.3, summary: 'Could not classify', clarification: "I want to make sure I get this right — could you tell me a bit more about what you'd like to change?", suggested_options: null };
      }
      // Log classifyIntent to generation_log — these add up
      const classifyMeta = getClientMeta(req);
      try {
        await supabase.from('generation_log').insert({
          user_id: user.id, event_id: eventId || null,
          prompt: 'classifyIntent: ' + userMessage.substring(0, 200),
          model: 'claude-haiku-4-5-20251001', input_tokens: classifyInputTokens,
          output_tokens: classifyOutputTokens, latency_ms: classifyLatency, status: 'success',
          is_tweak: true, cost_cents: classifyCost.costCentsExact, event_type: eventType || '',
          client_ip: classifyMeta.ip, client_geo: classifyMeta.geo, user_agent: classifyMeta.userAgent
        });
      } catch (e) { console.error('classifyIntent generation_log insert failed:', e.message); }
      if (eventId) {
        try { await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: classifyCost.rawCostCents }); } catch (e) { /* non-critical */ }
      }
      // AI generation included in $4.99 event price — no per-generation billing
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
    // PRIMARY SIGNAL: Use the client's AI intent classification (from Haiku classifier)
    // FALLBACK: Keyword-based heuristic when no classification is available
    const lowerInstructions = tweakInstructions.toLowerCase();
    const hasPhotos = (photoUrls?.length > 0) || photoUrl || photoBase64;
    const hasInspirationPhotos = inspirationImageUrls?.length > 0;
    let isLightTweak;
    if (classifiedIntent) {
      // Trust the AI classifier — it understands context ("below the image" ≠ design change)
      isLightTweak = ['text_change', 'add_field', 'remove_field', 'modify_field'].includes(classifiedIntent);
      // Photos always force design mode (need to embed/reference images)
      if (hasPhotos || hasInspirationPhotos) isLightTweak = false;
      console.log(`[tweak] Using AI classification: intent=${classifiedIntent}, isLightTweak=${isLightTweak}`);
    } else {
      // Fallback: keyword-based heuristic (no classifier ran — e.g. photos attached skip classification)
      const designKeywords = [
        'color', 'colour', 'font', 'background', 'layout', 'animation', 'animate',
        'style', 'theme', 'themed', 'darker', 'lighter', 'bigger', 'smaller', 'spacing',
        'margin', 'padding', 'border', 'shadow', 'gradient',
        'minimalist', 'maximalist', 'elegant', 'bold', 'modern', 'vintage',
        'vibe', 'mood', 'redesign', 'overhaul',
        'move', 'position', 'align', 'center',
        'css', 'width', 'height', 'size', 'rounded', 'hover'
      ];
      // Removed 'photo' and 'image' from designKeywords — these are too often used
      // as positional references ("below the image") not design change requests.
      // The AI classifier handles photo/image intent correctly.
      const hasDesignKeyword = designKeywords.some(kw => new RegExp('\\b' + kw + '\\b').test(lowerInstructions));
      const isTextSwap = /\b(?:change|replace|update|switch)\b.+\b(?:to|with|for|into)\b/i.test(lowerInstructions)
        && !/\b(?:color|colour|font|background|layout|theme|style)\s+(?:to|with|for|into)\b/i.test(lowerInstructions)
        && !hasDesignKeyword;
      isLightTweak = isTextSwap || (!hasPhotos && !hasInspirationPhotos && !hasDesignKeyword);
      console.log(`[tweak] Using keyword fallback: hasDesignKeyword=${hasDesignKeyword}, isLightTweak=${isLightTweak}`);
    }
    const tweakModel = isLightTweak ? 'claude-haiku-4-5-20251001' : themeModel;
    const tweakMaxTokens = isLightTweak ? 4096 : 16384;
    console.log(`[tweak] Final routing: ${isLightTweak ? 'LIGHT' : 'DESIGN'} tweak, model: ${tweakModel}`);

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
- .rsvp-slot MUST be completely EMPTY — the platform injects the RSVP form at runtime. NEVER put buttons or content inside it
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

IMPORTANT: The .rsvp-slot div must be completely EMPTY — the platform injects the RSVP form at runtime. Do NOT add buttons, form inputs, selects, textareas, labels, or ANY content inside .rsvp-slot.`;

        // Handle multiple photos (new) or single photo (legacy)
        const allPhotoUrls = photoUrls?.length > 0 ? photoUrls : (photoUrl ? [photoUrl] : []);
        if (existingPhotos && allPhotoUrls.length > 0) {
          // Photos already in the design — user is asking to modify how they appear
          tweakMessage += `\n\nThe design already contains ${allPhotoUrls.length} user-uploaded photo(s) at these URLs:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\nThe user is asking to modify how these photos appear in the design. Keep these EXACT URLs but apply the changes requested. Make the photo treatment creative and eye-catching — consider animated frames, fun CSS effects, themed borders, creative cropping with object-fit/object-position, or playful layouts that match the event theme.`;
        } else if (allPhotoUrls.length > 0) {
          tweakMessage += `\n\nThe user has uploaded ${allPhotoUrls.length} photo(s) they want incorporated into the design. Use these EXACT URLs in <img> tags:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\nIncorporate the photos in a creative, eye-catching way that makes the invite feel special and unique. Consider: animated photo frames with CSS keyframes, themed decorative borders matching the event type (birthday balloons, wedding flowers, etc.), polaroid-style scattered layouts with fun tilts, photos with creative CSS shapes (circle, hexagon, star clip-paths), floating/bouncing animation effects, or face cutouts placed into illustrated scenes. Don't just drop photos in a basic rectangle — make them a showpiece. Style with appropriate sizing (max-width: 100%), border-radius, CSS animations, and creative framing that fits the theme. For multiple photos, use an engaging layout (staggered grid, overlapping with rotation, cascading polaroids).`;
        } else if (photoBase64) {
          tweakMessage += `\n\nThe user has also provided a photo they want incorporated into the design. Use this image as an inline base64 data URI in an <img> tag where it makes sense for the design. Make the photo treatment creative and eye-catching — consider animated frames, themed borders, or playful CSS effects.`;
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

      // Build message content — include photos as image blocks for visual context
      let messageContent = [{ type: 'text', text: tweakMessage }];
      if (photoBase64 && !photoUrl) {
        messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } });
      }
      // Include inspiration images as visual context (fetched and converted to base64)
      if (inspirationImageUrls?.length > 0 && !photoUrls?.length) {
        try {
          const inspoBase64s = await fetchImagesAsBase64(inspirationImageUrls);
          for (const b64 of inspoBase64s) {
            messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
          }
          console.log(`[tweak] Added ${inspoBase64s.length} inspiration images as visual context`);
        } catch (e) {
          console.warn('[tweak] Failed to fetch inspiration images:', e.message);
        }
      }

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
- .rsvp-slot MUST be completely EMPTY — the platform injects the RSVP form at runtime. NEVER put buttons or content inside it — fields are rendered by the platform, NOT in HTML
- NEVER remove structural elements: .rsvp-slot, .details-slot, [data-field="title"], or their CSS styles — even if user doesn't mention them
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
- \`.rsvp-slot\` MUST be completely EMPTY — the platform injects the form at runtime. NO buttons, links, or content inside it
- The platform injects the real RSVP form at runtime from the field definitions (NOT from the HTML)
- To add/remove/modify RSVP fields, use the "rsvp_field_changes" array in your response — do NOT add form inputs to HTML
- Example: user says "remove birthday message field" → include { "action": "remove", "field_key": "birthday_message_for_max" } in rsvp_field_changes
- Example: user says "add a song request field" → include { "action": "add", "field_key": "song_request", "label": "Song Request", "field_type": "text", "is_required": false, "placeholder": "What song gets you dancing?" }

### STRUCTURAL INTEGRITY (CRITICAL — never remove these elements):
- \`<div class="rsvp-slot">...</div>\` — RSVP form container (platform-managed). MUST remain in output.
- \`<div class="details-slot">...</div>\` — event details container (platform-managed). MUST remain in output.
- Any element with \`data-field="title"\` — the event title. MUST remain in output.
- All CSS classes that style these elements (.rsvp-slot, .details-slot, .rsvp-submit, .rsvp-form-group, .detail-item, .detail-label, .detail-value) MUST remain in the CSS.
Even if the user's request doesn't mention these elements, they MUST be preserved exactly as they appear in the current HTML. Removing them breaks the invite.

### Design rules:
- Max-width 393px, mobile-first, WCAG AA contrast
- Google Fonts only (include @import in theme_config.googleFontsImport)
- NEVER use Inter, Roboto, Arial, or system fonts — always characterful fonts
- No JavaScript, no external images (except Google Fonts and user-uploaded photos)
- Make minimal changes — only what the user asked for, keep everything else exactly the same
- Preserve and enhance CSS animations — every invite should feel alive with entrance animations, ambient motion, and hover effects
- Thank you page: Provide .thankyou-page container with a REQUIRED decorative SVG illustration (in .thankyou-decoration div) + empty .thankyou-hero div. The platform injects "Thank You!" title, subtitle, calendar buttons, and footer. NO text, NO emojis, NO calendar buttons, NO footer in your output. MUST include a theme-matching SVG illustration with CSS animation. Match invite's background/fonts. Style .thankyou-page, .thankyou-decoration, .thankyou-hero, .thankyou-title, .thankyou-subtitle in CSS.
- TEXT CONTRAST: EVERY text element must be clearly readable against its background. Never light-on-light or dark-on-dark. Buttons must have contrasting text. This is non-negotiable. CONCRETE RULE: on any dark/colored background section, text MUST be #FFFFFF or #FAFAFA. On light backgrounds, text MUST be #1A1A1A or darker. Do NOT use theme accent colors (coral, salmon, rose, etc.) as text on dark backgrounds.
- For photo additions: use the EXACT URL(s) provided in <img> tags. Make the photo treatment creative and eye-catching — animated frames, themed borders, CSS clip-paths, polaroid layouts, floating effects. Don't just drop photos in a basic rectangle.`;

      const stream = isOpenAIModel(tweakModel)
        ? openaiStream(tweakModel, tweakSystemPrompt, messageContent, tweakMaxTokens)
        : client.messages.stream({
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
      let lightTweakFailed = false; // Track if light tweak needs escalation
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
        if (isLightTweak) {
          // Light tweak parse failed — mark for escalation instead of returning chatOnly
          console.warn('[tweak] Light tweak parse failed — will escalate to Sonnet:', parseErr.message);
          lightTweakFailed = true;
          theme = null;
        } else {
          // Design tweak parse failure — return as chat response (no escalation path)
          const chatOnlyCost = calcGenerationCost(tweakModel, tweakInputTokens, tweakOutputTokens);
          const chatOnlyMeta = getClientMeta(req);
          const chatOnlyLogResult = await supabase.from('generation_log').insert({
            event_id: eventId, user_id: user.id, prompt: 'Tweak (chat): ' + tweakInstructions.substring(0, 200),
            model: tweakModel, input_tokens: tweakInputTokens,
            output_tokens: tweakOutputTokens, latency_ms: Date.now() - startTime, status: 'success',
            is_tweak: true, cost_cents: chatOnlyCost.costCentsExact, event_type: eventDetails?.eventType || '',
            client_ip: chatOnlyMeta.ip, client_geo: chatOnlyMeta.geo, user_agent: chatOnlyMeta.userAgent
          });
          if (chatOnlyLogResult.error) console.error('Chat-only tweak log failed:', chatOnlyLogResult.error.message);
          if (eventId) {
            try {
              const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: chatOnlyCost.rawCostCents });
              if (rpcErr) {
                const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
                if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + chatOnlyCost.rawCostCents }).eq('id', eventId);
              }
            } catch (e) { /* non-critical */ }
          }
          sendSSE('done', {
            success: true,
            chatOnly: true,
            chatResponse: fullText.trim(),
            theme: null,
            metadata: { model: tweakModel, latencyMs: Date.now() - startTime, tokens: { input: tweakInputTokens, output: tweakOutputTokens }, cost: chatOnlyCost }
          });
          res.end();
          return;
        }
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
          if (appliedCount === 0 && theme.html_replacements.length > 0) {
            console.warn('[tweak] Zero email replacements matched — marking for escalation');
            lightTweakFailed = true;
          } else {
            theme.theme_html = currentHtml;
            theme.theme_css = currentCss;
            theme.theme_config = { ...(currentConfig || {}), emailHtml: patchedEmail };
          }
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
        // If zero replacements applied and there were actual replacements attempted, escalate
        if (appliedCount === 0 && theme.html_replacements.length > 0) {
          console.warn('[tweak] Zero replacements matched — marking for escalation');
          lightTweakFailed = true;
        } else {
          theme.theme_html = patchedHtml;
          theme.theme_css = currentCss;
          theme.theme_config = currentConfig || {};
        }
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

      // ── ESCALATION: If light tweak failed, retry with Sonnet as a full design tweak ──
      if (lightTweakFailed) {
        console.log('[tweak] ESCALATING to Sonnet — light tweak could not fulfill the request');
        sendSSE('status', { phase: 'escalating', message: 'Trying a more thorough approach...' });
        res.write(': keepalive\n\n');

        // Log the failed Haiku attempt
        const failedCost = calcGenerationCost(tweakModel, tweakInputTokens, tweakOutputTokens);
        const failedMeta = getClientMeta(req);
        try {
          await supabase.from('generation_log').insert({
            event_id: eventId, user_id: user.id, prompt: 'Tweak (escalated): ' + tweakInstructions.substring(0, 200),
            model: tweakModel, input_tokens: tweakInputTokens, output_tokens: tweakOutputTokens,
            latency_ms: Date.now() - startTime, status: 'escalated',
            is_tweak: true, cost_cents: failedCost.costCentsExact, event_type: eventDetails?.eventType || '',
            client_ip: failedMeta.ip, client_geo: failedMeta.geo, user_agent: failedMeta.userAgent
          });
        } catch (logErr) { console.error('[escalation] Failed to log escalated attempt:', logErr.message); }

        // Build the full design tweak message (same as the design tweak path)
        const escalationModel = themeModel; // Use the same model as design tweaks
        const escalationMessage = `Here is an existing invite theme. The user is using the chat designer to modify their invite.
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

IMPORTANT: The .rsvp-slot div must be completely EMPTY — the platform injects the RSVP form at runtime. Do NOT add buttons, form inputs, selects, textareas, labels, or ANY content inside .rsvp-slot.

${currentConfig?.thankyouHtml ? `**Current Thank You Page HTML:**\n\`\`\`html\n${currentConfig.thankyouHtml}\n\`\`\`\nIf your changes affect the visual style (colors, fonts, spacing, backgrounds), update the thank you page to match. If the change is content-only (e.g., changing text, adding an element to the invite), you may set theme_thankyou_html to null to keep it unchanged.` : ''}

Return the updated theme as a JSON object: { "theme_html": "...", "theme_css": "...", "theme_thankyou_html": "..." or null if unchanged, "theme_config": { ... }, "chat_response": "Brief friendly message about what you changed", "rsvp_field_changes": [...] or null if no RSVP field changes }. Make ONLY the changes the user requested — keep everything else exactly the same. If the thank you page doesn't need changes, set theme_thankyou_html to null.`;

        // Build escalation system prompt — must be the FULL design tweak prompt, not the light tweak one
        // The original tweakSystemPrompt was built for light tweaks (html_replacements format).
        // For escalation we need the full design format (theme_html, theme_css, etc.)
        const escalationSystemPrompt = isEmailMode
          ? tweakSystemPrompt // Email mode already uses full prompt
          : `You are an elite invite designer modifying event invites. A simpler approach failed to make the user's requested change, so you need to return the COMPLETE updated theme.

## OUTPUT FORMAT
Return ONLY a valid JSON object with the COMPLETE updated theme:
{
  "theme_html": "...the COMPLETE updated HTML...",
  "theme_css": "...the COMPLETE updated CSS...",
  "theme_thankyou_html": null,
  "theme_config": { "primaryColor": "...", "backgroundColor": "...", "fontHeadline": "...", "fontBody": "...", "googleFontsImport": "@import url('...');", "mood": "...", "loadingPun": "..." },
  "chat_response": "Brief friendly message about what you changed",
  "rsvp_field_changes": null
}

## CRITICAL STRUCTURAL RULES (NEVER violate these)

### Data attributes (REQUIRED — always preserve):
- \`data-field="title"\` — on the event title element
- \`data-field="datetime"\` — on date/time container (if present)
- \`data-field="location"\` — on location container (if present)
- \`data-field="dresscode"\` — on dress code container (if present)
- \`data-field="host"\` — on host name element (if present)

### RSVP form section:
- \`.rsvp-slot\` MUST be completely EMPTY — the platform injects the form at runtime. NO buttons, links, or content inside it
- To add/remove/modify RSVP fields, use "rsvp_field_changes" — do NOT add form inputs to HTML

### STRUCTURAL INTEGRITY (CRITICAL — never remove these elements):
- \`<div class="rsvp-slot">...</div>\` — RSVP form container. MUST remain in output.
- \`<div class="details-slot">...</div>\` — event details container. MUST remain in output.
- Any element with \`data-field="title"\` — the event title. MUST remain in output.

### Design rules:
- Max-width 393px, mobile-first, WCAG AA contrast
- Google Fonts only (include @import in theme_config.googleFontsImport)
- No JavaScript, no external images (except Google Fonts and user-uploaded photos)
- Make ONLY the changes the user asked for — keep EVERYTHING else exactly the same
- TEXT CONTRAST: EVERY text element must be readable against its background`;

        const escalationContent = [{ type: 'text', text: escalationMessage }];
        const escalationStream = client.messages.stream({
          model: escalationModel,
          max_tokens: 16384,
          system: escalationSystemPrompt,
          messages: [{ role: 'user', content: escalationContent }]
        });

        let escalationText = '';
        let escalationChunks = 0;
        let escalationFinalMsg = null;

        const escalationKeep = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch (e) {}
        }, 3000);

        const escFinalPromise = new Promise(r => { escalationStream.on('finalMessage', (msg) => { escalationFinalMsg = msg; r(msg); }); });
        await new Promise((resolve, reject) => {
          let resolved = false;
          let lastChunk = Date.now();
          const done = () => { if (!resolved) { resolved = true; clearInterval(escIdleCheck); clearInterval(escalationKeep); resolve(); } };
          escalationStream.on('text', (text) => { escalationText += text; escalationChunks++; lastChunk = Date.now(); });
          escalationStream.on('finalMessage', () => done());
          escalationStream.on('end', () => done());
          escalationStream.on('error', (err) => { if (!resolved) { resolved = true; clearInterval(escIdleCheck); clearInterval(escalationKeep); reject(err); } });
          const escIdleCheck = setInterval(() => {
            if (escalationChunks > 0 && Date.now() - lastChunk > 15000 && escalationText.length > 3000) done();
          }, 1000);
          setTimeout(() => {
            if (!resolved) {
              if (escalationText.length > 0) done();
              else { resolved = true; clearInterval(escIdleCheck); clearInterval(escalationKeep); reject(new Error('Escalation stream timeout')); }
            }
          }, 120000);
        });

        // Parse escalation result
        theme = parseThemeResponse(escalationText);
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

        // Update token counts for the escalation
        const escInputTokens = escalationFinalMsg?.usage?.input_tokens || Math.round((escalationSystemPrompt.length + escalationMessage.length) / 4);
        const escOutputTokens = escalationFinalMsg?.usage?.output_tokens || Math.round(escalationText.length / 4);
        tweakInputTokens += escInputTokens;
        tweakOutputTokens += escOutputTokens;

        console.log(`[tweak] Escalation complete — ${escalationText.length} chars, ${escalationChunks} chunks`);
      }

      // Merge config — handle thank you page and email based on tweak type
      const tweakConfig = theme.theme_config || currentConfig || {};
      const isFullDesignTweak = !isLightTweak || lightTweakFailed; // Tier 3 or escalated
      if (theme.theme_thankyou_html && theme.theme_thankyou_html !== null) {
        // AI generated a new thank you page — use it
        tweakConfig.thankyouHtml = theme.theme_thankyou_html;
      } else if (isFullDesignTweak) {
        // Full design change — old thank you page won't match new design.
        // Auto-generate a new one via completeness check.
        console.log('[tweak] Full design tweak without new thankyou — auto-generating to match new theme');
        try {
          res.write(': keepalive\n\n');
          const tyFill = await generateMissingPieces(theme, ['thankyou_html'], eventDetails);
          if (tyFill.thankyou_html) {
            tweakConfig.thankyouHtml = tyFill.thankyou_html;
            if (tyFill.thankyou_css) {
              theme.theme_css = (theme.theme_css || '') + '\n' + tyFill.thankyou_css;
            }
            console.log('[tweak] Auto-generated new thank you page:', tyFill.thankyou_html.length, 'chars');
          } else if (currentConfig?.thankyouHtml) {
            tweakConfig.thankyouHtml = currentConfig.thankyouHtml; // Fallback to old
          }
        } catch (e) {
          console.warn('[tweak] Auto-generate thankyou failed:', e.message);
          if (currentConfig?.thankyouHtml) tweakConfig.thankyouHtml = currentConfig.thankyouHtml;
        }
        // Full design tweak — clear old emailHtml so client regenerates from new config colors
        tweakConfig.emailHtml = null;
      } else if (currentConfig?.thankyouHtml) {
        // Light tweak — preserve old thank you page (colors didn't change)
        tweakConfig.thankyouHtml = currentConfig.thankyouHtml;
      }
      // Preserve emailHtml across light (non-design) tweaks only
      if (!isFullDesignTweak && !tweakConfig.emailHtml && currentConfig?.emailHtml) {
        tweakConfig.emailHtml = currentConfig.emailHtml;
      }

      // ── SERVER-SIDE THEME VALIDATION for tweaks (same as generation path) ──
      const tweakValidation = validateThemeIntegrity(theme);
      if (!tweakValidation.valid) {
        console.warn('[tweak] Theme validation failed:', tweakValidation.issues.join(', '), '— attempting auto-repair');
        repairTheme(theme, tweakValidation.issues);
        const tweakRecheck = validateThemeIntegrity(theme);
        if (!tweakRecheck.valid) {
          console.error('[tweak] Theme still has issues after repair:', tweakRecheck.issues.join(', '));
        } else {
          console.log('[tweak] Theme auto-repair succeeded');
        }
      }

      // Save tweak theme to DB BEFORE closing SSE so it's reliable
      // If escalated, use the escalation model for cost calculation (more expensive)
      const finalTweakModel = lightTweakFailed ? (themeModel || 'claude-sonnet-4-5-20250514') : tweakModel;
      const tweakCost = lightTweakFailed
        ? { // Combine both costs: Haiku attempt + Sonnet escalation
            ...calcGenerationCost(finalTweakModel, tweakInputTokens, tweakOutputTokens),
            escalated: true
          }
        : calcGenerationCost(tweakModel, tweakInputTokens, tweakOutputTokens);
      let savedTweakThemeId = 'pending';
      let savedTweakVersion = 0;
      try {
        const { data: existingThemes } = await supabase
          .from('event_themes')
          .select('id, version, design_group_id')
          .eq('event_id', eventId)
          .order('version', { ascending: false })
          .limit(1);

        const nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;
        // Tweaks inherit the design group from the theme being tweaked
        const parentGroupId = existingThemes?.[0]?.design_group_id || null;

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
        if (parentGroupId) tweakInsert.design_group_id = parentGroupId;
        var { data: newTweakTheme, error: tweakThemeError } = await supabase
          .from('event_themes').insert(tweakInsert).select().single();
        // If design_group_id column doesn't exist yet, retry without it
        if (tweakThemeError && tweakThemeError.message?.includes('design_group_id')) {
          delete tweakInsert.design_group_id;
          ({ data: newTweakTheme, error: tweakThemeError } = await supabase
            .from('event_themes').insert(tweakInsert).select().single());
        }
        if (tweakThemeError) console.error('Failed to save tweak theme:', tweakThemeError.message);
        if (newTweakTheme) {
          savedTweakThemeId = newTweakTheme.id;
          savedTweakVersion = nextVersion;
        }
      } catch (saveErr) {
        console.error('Tweak theme DB save failed:', saveErr);
      }

      // Mark free redo as used BEFORE sending response (prevents race with next request)
      if (req._isFreeRedo) {
        await supabase.from('events')
          .update({ free_redo_used: true })
          .eq('id', eventId)
          .in('payment_status', ['free', 'unpaid']);
      }

      // Collect content warnings for the client (post-repair)
      const tweakFinalCheck = validateThemeIntegrity(theme);
      const tweakContentWarnings = tweakFinalCheck.issues.filter(i => i.startsWith('missing_') || i === 'content_too_sparse');

      // ── Quality signal: Content warnings persist after tweak repair ──
      if (tweakContentWarnings.length > 0) {
        try {
          await supabase.from('quality_incidents').insert({
            event_id: eventId, user_id: user.id,
            trigger_type: 'content_warning',
            trigger_data: { contentWarnings: tweakContentWarnings, htmlLength: theme.theme_html.length, isTweak: true },
            theme_snapshot: { html: theme.theme_html, css: theme.theme_css, config: tweakConfig },
            validation_results: { server: tweakContentWarnings },
            resolution_type: 'unresolved'
          });
        } catch (e) { console.error('[quality] Tweak content warning incident failed:', e.message); }
      }

      // ── Log tweak to generation_log BEFORE res.end() — uses estimated tokens ──
      const tweakMeta = getClientMeta(req);
      let tweakLogId = null;
      const tweakLogResult = await supabase.from('generation_log').insert({
        event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
        model: lightTweakFailed ? finalTweakModel : tweakModel, input_tokens: tweakInputTokens,
        output_tokens: tweakOutputTokens, latency_ms: Date.now() - startTime, status: lightTweakFailed ? 'escalated_success' : 'success',
        is_tweak: true, cost_cents: tweakCost.costCentsExact, event_type: eventDetails?.eventType || '',
        client_ip: tweakMeta.ip, client_geo: tweakMeta.geo, user_agent: tweakMeta.userAgent
      }).select('id').single();
      if (tweakLogResult.error) console.error('Tweak generation_log insert failed:', tweakLogResult.error.message);
      else tweakLogId = tweakLogResult.data?.id;

      // ── Increment persistent event cost BEFORE res.end() ──
      try {
        const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: tweakCost.rawCostCents });
        if (rpcErr) {
          const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
          if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + tweakCost.rawCostCents }).eq('id', eventId);
        }
      } catch (e) { /* non-critical */ }

      // Send result to client with real DB ID
      sendSSE('done', {
        success: true,
        softCapReached: !!res.softCapReached,
        contentWarnings: tweakContentWarnings.length > 0 ? tweakContentWarnings : undefined,
        theme: { id: savedTweakThemeId, version: savedTweakVersion, html: theme.theme_html, css: theme.theme_css, config: tweakConfig },
        chatResponse: theme.chat_response || null,
        rsvpFieldChanges: theme.rsvp_field_changes || null,
        isLightTweak,
        metadata: {
          model: lightTweakFailed ? finalTweakModel : tweakModel,
          escalated: lightTweakFailed || false,
          latencyMs: Date.now() - startTime,
          tokens: { input: tweakInputTokens, output: tweakOutputTokens },
          cost: tweakCost
        }
      });
      res.end();

      // ── BACKGROUND: Update with accurate token counts (non-critical) ──
      try {
        await Promise.race([tweakFinalPromise, new Promise(r => setTimeout(r, 5000))]);
        const finalTweakInputTokens = tweakFinalMessage?.usage?.input_tokens || tweakInputTokens;
        const finalTweakOutputTokens = tweakFinalMessage?.usage?.output_tokens || tweakOutputTokens;

        if (finalTweakInputTokens !== tweakInputTokens || finalTweakOutputTokens !== tweakOutputTokens) {
          if (savedTweakThemeId && savedTweakThemeId !== 'pending') {
            await supabase.from('event_themes')
              .update({ input_tokens: finalTweakInputTokens, output_tokens: finalTweakOutputTokens })
              .eq('id', savedTweakThemeId);
          }
          if (tweakLogId) {
            await supabase.from('generation_log')
              .update({ input_tokens: finalTweakInputTokens, output_tokens: finalTweakOutputTokens })
              .eq('id', tweakLogId);
          }
          const finalTweakCost = calcGenerationCost(tweakModel, finalTweakInputTokens, finalTweakOutputTokens);
          const costDelta = finalTweakCost.rawCostCents - tweakCost.rawCostCents;
          if (costDelta > 0) {
            await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: costDelta }).catch(() => {});
          }
        }
      } catch (e) { /* non-critical — estimated tokens already saved */ }

      return;
    } catch (err) {
      console.error('Theme tweak error:', err);
      const tweakErrMeta = getClientMeta(req);
      try {
        const tweakErrLogResult = await supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + (tweakInstructions || '').substring(0, 200),
          model: tweakModel, input_tokens: 0, output_tokens: 0, latency_ms: Date.now() - startTime, status: 'error', error: err.message,
          is_tweak: true, event_type: eventDetails?.eventType || '', client_ip: tweakErrMeta.ip, client_geo: tweakErrMeta.geo, user_agent: tweakErrMeta.userAgent
        });
        if (tweakErrLogResult.error) console.error('Tweak error log failed:', tweakErrLogResult.error.message);
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

  // ── Incident pattern awareness: avoid known-bad patterns in generation ──
  let incidentAvoidanceNote = '';
  try {
    const { data: recentPatterns } = await supabase
      .rpc('get_quality_root_cause_patterns_simple')
      .catch(() => ({ data: null }));

    // Fallback: direct query if the RPC doesn't exist
    if (!recentPatterns) {
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentIncidents } = await supabase
        .from('quality_incidents')
        .select('trigger_type, trigger_data')
        .gte('created_at', since7d)
        .eq('trigger_type', 'broken_render')
        .limit(50);

      if (recentIncidents && recentIncidents.length >= 5) {
        // Aggregate common missing elements
        const missingCounts = {};
        const cssCounts = {};
        recentIncidents.forEach(i => {
          const td = i.trigger_data || {};
          (td.missing || []).forEach(m => { missingCounts[m] = (missingCounts[m] || 0) + 1; });
          (td.cssIssues || []).forEach(c => { cssCounts[c] = (cssCounts[c] || 0) + 1; });
        });
        const topMissing = Object.entries(missingCounts).sort((a,b) => b[1]-a[1]).slice(0, 3);
        const topCss = Object.entries(cssCounts).sort((a,b) => b[1]-a[1]).slice(0, 3);

        if (topMissing.length > 0 || topCss.length > 0) {
          incidentAvoidanceNote = '\n\nKNOWN ISSUES TO AVOID (based on recent quality incidents):\n';
          topMissing.forEach(([el, count]) => {
            incidentAvoidanceNote += `- "${el}" element has been missing in ${count} recent generations. ENSURE it is present.\n`;
          });
          topCss.forEach(([issue, count]) => {
            const issueMap = {
              invisible_title: 'Title text is invisible (opacity:0 or same color as background). ENSURE title has visible, contrasting color.',
              low_contrast_title: 'Title has poor contrast ratio. ENSURE text color contrasts with background.',
              offscreen_rsvp: 'RSVP section is positioned offscreen. ENSURE rsvp-slot is within viewport.',
              hidden_details: 'Details section has display:none. ENSURE details-slot is visible.',
              tiny_details: 'Details section has zero/tiny height. ENSURE it has adequate min-height.'
            };
            incidentAvoidanceNote += `- ${issueMap[issue] || issue} (${count} incidents)\n`;
          });
        }
      }
    }
  } catch (e) {
    // Don't block generation if pattern query fails
    console.warn('[generate] Incident pattern query failed:', e.message);
  }

  // Append incident avoidance note to system prompt if patterns found
  if (incidentAvoidanceNote) {
    activePrompt.systemPrompt += incidentAvoidanceNote;
  }

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
The \`.rsvp-slot\` MUST be completely EMPTY — the platform injects the RSVP form at runtime. NEVER put buttons, links, or content inside it.
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
      userMessage += `\n\n══════════════════════\nPHOTOS\n══════════════════════\n${allPhotoUrls.length} photo(s) provided. Use these EXACT URLs in <img> tags:\n${allPhotoUrls.map((url, i) => `Photo ${i + 1}: ${url}`).join('\n')}\n\nIncorporate the photos in a creative, eye-catching way that makes the invite feel special and unique. Consider: animated photo frames with CSS keyframes, themed decorative borders matching the event type, polaroid-style layouts with fun tilts, creative CSS shapes (circle, hexagon, star clip-paths), floating/bouncing animation effects, or face cutouts placed into illustrated scenes. Don't just drop photos in a basic rectangle — make them a showpiece. Style with appropriate sizing, border-radius, box-shadow, CSS animations, and creative framing that fits the theme.`;
    }

    if (feedback) {
      userMessage += `\n\n**Feedback on previous version (incorporate this):**\n${feedback}`;
    }

    // Final contrast reminder (recency bias — model pays most attention to end of prompt)
    userMessage += `\n\n══════════════════════
⚠️ FINAL CHECK — TEXT CONTRAST (NON-NEGOTIABLE)
══════════════════════
Before outputting, mentally walk through EVERY text element and verify:
1. Dark/colored background sections (navy, green, black, charcoal, brown, etc.) → text MUST be #FFFFFF or #FAFAFA
2. Light background sections → text MUST be #1A1A1A or darker
3. Buttons → text color must contrast against the button's background color
4. NEVER use accent colors (coral, salmon, rose, gold, etc.) as text on dark backgrounds — they FAIL contrast
5. The .details-slot CSS — if its background is dark, .detail-label and .detail-value MUST be white
6. The .rsvp-slot CSS — if the RSVP section has a dark/colored background, ALL labels, inputs, and text inside .rsvp-slot MUST be white/light. Set .rsvp-slot label { color: #FFFFFF; } and .rsvp-slot input, .rsvp-slot select { color: #FFFFFF; }
7. The .thankyou-page CSS — .thankyou-title and .thankyou-subtitle must contrast against the page background
8. NEVER let ANY text have the same or similar color as its background — minimum 4.5:1 contrast ratio
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
    // Use .on('text') (proven to work) + resolve on 'end' event
    // Do NOT use stream.finalMessage() — it blocks past Vercel's 60s timeout
    const stream = isOpenAIModel(themeModel)
      ? openaiStream(themeModel, activePrompt.systemPrompt, messageContent, 12288)
      : client.messages.stream({
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

    // ── COMPLETENESS CHECK: Auto-generate missing pieces via quick Haiku call ──
    // The main generation sometimes omits the thank you page, googleFontsImport,
    // or config colors. Instead of falling back to ugly defaults on the client,
    // we detect what's missing and make a targeted follow-up call to fill gaps.
    const missingPieces = [];
    if (!theme.theme_thankyou_html || theme.theme_thankyou_html.trim().length < 50) {
      missingPieces.push('thankyou_html');
    }
    if (!theme.theme_config.googleFontsImport) {
      missingPieces.push('googleFontsImport');
    }
    if (!theme.theme_config.backgroundColor) {
      missingPieces.push('backgroundColor');
    }
    if (!theme.theme_config.fontHeadline) {
      missingPieces.push('fontHeadline');
    }

    if (missingPieces.length > 0) {
      console.warn('[completeness] Missing pieces detected:', missingPieces.join(', '), '— requesting auto-fill via Haiku');
      try {
        res.write(': keepalive\n\n'); // Keep connection alive during follow-up
        const fillResult = await generateMissingPieces(theme, missingPieces, eventDetails);
        if (fillResult.thankyou_html) {
          theme.theme_thankyou_html = fillResult.thankyou_html;
          console.log('[completeness] Auto-generated thank you HTML:', fillResult.thankyou_html.length, 'chars');
        }
        if (fillResult.googleFontsImport) {
          theme.theme_config.googleFontsImport = fillResult.googleFontsImport;
          console.log('[completeness] Auto-filled googleFontsImport');
        }
        if (fillResult.backgroundColor) {
          theme.theme_config.backgroundColor = fillResult.backgroundColor;
          console.log('[completeness] Auto-filled backgroundColor');
        }
        if (fillResult.fontHeadline) {
          theme.theme_config.fontHeadline = fillResult.fontHeadline;
          console.log('[completeness] Auto-filled fontHeadline');
        }
        if (fillResult.fontBody && !theme.theme_config.fontBody) {
          theme.theme_config.fontBody = fillResult.fontBody;
        }
        if (fillResult.thankyou_css) {
          theme.theme_css = (theme.theme_css || '') + '\n' + fillResult.thankyou_css;
          console.log('[completeness] Auto-filled thank you CSS:', fillResult.thankyou_css.length, 'chars');
        }
      } catch (fillErr) {
        console.error('[completeness] Auto-fill failed (client fallback will be used):', fillErr.message);
      }
    }

    // Store thank you HTML in config to avoid DB schema change
    if (theme.theme_thankyou_html) {
      theme.theme_config.thankyouHtml = theme.theme_thankyou_html;
    } else {
      // Log whether fallback will work — AI CSS may still have .thankyou-page rules
      const hasTyCssRules = (theme.theme_css || '').includes('.thankyou-page');
      console.warn('[generate] thankyouHtml is empty after completeness check. CSS has .thankyou-page rules:', hasTyCssRules, '— client fallback will be used');
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

    // CRITICAL: Mark free generation as used BEFORE sending response to client.
    // If we wait until after res.end(), the client can fire a tweak request before
    // the DB update completes, bypassing the free tier limit.
    const freeUpdate = { free_generation_used: true };
    if (req._isFreeRedo) freeUpdate.free_redo_used = true;
    await supabase.from('events')
      .update(freeUpdate)
      .eq('id', eventId)
      .in('payment_status', ['free', 'unpaid']);

    // CRITICAL: All DB saves (theme, generation_log, cost increment) happen BEFORE res.end().
    // Vercel suspends/terminates execution after res.end(), so post-response DB operations
    // are unreliable and were causing ~50x cost tracking discrepancies.
    const genCost = calcGenerationCost(themeModel, genInputTokens, genOutputTokens);
    console.log('[cost] Pre-save cost:', { genCost, model: themeModel, inputTokens: genInputTokens, outputTokens: genOutputTokens });

    // Collect content warnings for the client (post-repair)
    const finalCheck = validateThemeIntegrity(theme);
    const contentWarnings = finalCheck.issues.filter(i => i.startsWith('missing_') || i === 'content_too_sparse');

    // ── Quality signal: Content warnings persist after repair ──
    if (contentWarnings.length > 0) {
      try {
        await supabase.from('quality_incidents').insert({
          event_id: eventId, user_id: user.id,
          trigger_type: 'content_warning',
          trigger_data: { contentWarnings, htmlLength: theme.theme_html.length },
          theme_snapshot: { html: theme.theme_html, css: theme.theme_css, config: theme.theme_config },
          validation_results: { server: contentWarnings },
          resolution_type: 'unresolved'
        });
      } catch (e) { console.error('[quality] Content warning incident failed:', e.message); }
    }

    // ── Save theme to event_themes BEFORE res.end() ──
    let newTheme = null;
    let nextVersion = 1;
    try {
      const { data: existingThemes } = await supabase
        .from('event_themes')
        .select('id, version')
        .eq('event_id', eventId)
        .order('version', { ascending: false })
        .limit(1);

      nextVersion = existingThemes?.length > 0 ? existingThemes[0].version + 1 : 1;

      await supabase
        .from('event_themes')
        .update({ is_active: false })
        .eq('event_id', eventId)
        .eq('is_active', true);

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
      if (basedOnThemeId) {
        genInsert.based_on_theme_id = basedOnThemeId;
        try {
          const { data: sourceTheme } = await supabase
            .from('event_themes')
            .select('design_group_id')
            .eq('id', basedOnThemeId)
            .single();
          if (sourceTheme?.design_group_id) {
            genInsert.design_group_id = sourceTheme.design_group_id;
          }
        } catch (e) { /* proceed without group inheritance */ }
      }
      let themeError;
      ({ data: newTheme, error: themeError } = await supabase
        .from('event_themes').insert(genInsert).select().single());
      if (themeError && (themeError.message?.includes('prompt_version_id') || themeError.message?.includes('style_library_ids') || themeError.message?.includes('design_group_id'))) {
        delete genInsert.prompt_version_id;
        delete genInsert.style_library_ids;
        delete genInsert.design_group_id;
        ({ data: newTheme, error: themeError } = await supabase
          .from('event_themes').insert(genInsert).select().single());
      }
      if (themeError) {
        console.error('Failed to save theme:', themeError.message);
      } else if (newTheme) {
        savedThemeId = newTheme.id;
        savedThemeVersion = newTheme.version;
      }

      // New full generation (not based on existing) starts its own design group
      if (newTheme?.id && !themeError && !basedOnThemeId) {
        await supabase.from('event_themes')
          .update({ design_group_id: newTheme.id.toString() })
          .eq('id', newTheme.id);
      }
    } catch (saveErr) {
      console.error('Theme DB save error:', saveErr);
    }

    await supabase.from('events')
      .update({ first_generation_at: new Date().toISOString() })
      .eq('id', eventId).is('first_generation_at', null);

    // ── Log to generation_log BEFORE res.end() — uses estimated tokens ──
    const genMeta = getClientMeta(req);
    let genLogId = null;
    const genLogResult = await supabase.from('generation_log').insert({
      event_id: eventId, user_id: user.id, prompt: effectivePrompt,
      model: themeModel, input_tokens: genInputTokens,
      output_tokens: genOutputTokens, latency_ms: latency,
      status: 'success', cost_cents: genCost.costCentsExact, event_type: eventType, style_library_ids: usedStyleIds,
      prompt_version_id: activePrompt.promptVersionId || null,
      client_ip: genMeta.ip, client_geo: genMeta.geo, user_agent: genMeta.userAgent
    }).select('id').single();
    if (genLogResult.error) console.error('generation_log insert failed:', genLogResult.error.message);
    else genLogId = genLogResult.data?.id;

    // ── Increment persistent event cost BEFORE res.end() ──
    try {
      const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: genCost.rawCostCents });
      if (rpcErr) {
        const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
        if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + genCost.rawCostCents }).eq('id', eventId);
      }
    } catch (e) { /* non-critical */ }

    // ── Quality signal: High GTP (3+ generations without publish) ──
    try {
      const { count: themeCount } = await supabase
        .from('event_themes').select('id', { count: 'exact', head: true })
        .eq('event_id', eventId);
      if (themeCount >= 3) {
        const { data: evt } = await supabase.from('events').select('status').eq('id', eventId).single();
        if (evt && evt.status !== 'published') {
          await supabase.from('quality_incidents').insert({
            event_id: eventId, user_id: user.id,
            event_theme_id: newTheme?.id || null,
            trigger_type: 'high_gtp',
            trigger_data: { generationCount: themeCount },
            theme_snapshot: { html: theme.theme_html, css: theme.theme_css, config: theme.theme_config },
            resolution_type: 'unresolved'
          });
        }
      }
    } catch (e) { /* non-critical quality monitoring */ }

    // ── Send response and close connection — all critical saves are done ──
    sendSSE('done', {
      success: true,
      softCapReached: !!res.softCapReached,
      contentWarnings: contentWarnings.length > 0 ? contentWarnings : undefined,
      theme: {
        id: newTheme?.id || 'pending',
        version: nextVersion,
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
    res.end();

    // ── BACKGROUND: Update with accurate token counts (non-critical) ──
    // If Vercel kills the function here, we still have estimated tokens logged above.
    try {
      await Promise.race([finalMessagePromise, new Promise(r => setTimeout(r, 5000))]);
      const finalInputTokens = genFinalMessage?.usage?.input_tokens || genInputTokens;
      const finalOutputTokens = genFinalMessage?.usage?.output_tokens || genOutputTokens;
      console.log('[cost] Background token update:', { finalInputTokens, finalOutputTokens, hadFinalMsg: !!genFinalMessage });

      if (finalInputTokens !== genInputTokens || finalOutputTokens !== genOutputTokens) {
        const finalCost = calcGenerationCost(themeModel, finalInputTokens, finalOutputTokens);
        // Update event_themes with accurate tokens
        if (newTheme?.id) {
          await supabase.from('event_themes')
            .update({ input_tokens: finalInputTokens, output_tokens: finalOutputTokens })
            .eq('id', newTheme.id);
        }
        // Update generation_log with accurate tokens
        if (genLogId) {
          await supabase.from('generation_log')
            .update({ input_tokens: finalInputTokens, output_tokens: finalOutputTokens })
            .eq('id', genLogId);
        }
        // Adjust event cost delta if markup changed significantly
        const costDelta = finalCost.rawCostCents - genCost.rawCostCents;
        if (costDelta > 0) {
          await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: costDelta }).catch(() => {});
        }
      }
    } catch (e) { /* non-critical — estimated tokens already saved */ }

    return;
  } catch (err) {
    console.error('Theme generation error:', err);

    // Log error (don't let logging failure mask the real error)
    const errMeta = getClientMeta(req);
    try {
      const errLogResult = await supabase.from('generation_log').insert({
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
      });
      if (errLogResult.error) console.error('Error log insert failed:', errLogResult.error.message);
    } catch (logErr) {
      console.error('Failed to log generation error:', logErr);
    }

    sendSSE('error', { error: 'Failed to generate theme', message: err.message || 'Unknown error' });
    return res.end();
  }
}
