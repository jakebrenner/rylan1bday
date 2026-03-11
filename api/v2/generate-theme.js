import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_THEME_MODEL = process.env.THEME_MODEL || 'claude-sonnet-4-6';

// Allow up to 300s on Vercel Pro (caps at 60s on Hobby)
export const config = { maxDuration: 300 };

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
3. **EVENT DETAILS** — Icon + text layout for date, time, location.
4. **RSVP SECTION** — \`<div class="rsvp-slot"><button class="rsvp-button">...</button></div>\`. The rsvp-slot MUST contain ONLY the button — the platform injects the real form at runtime. Make the button text fun and on-theme.

## RSVP BUTTON — CRITICAL PLATFORM RULES
- Full-width within its container (width: 100% or at least 280px) — NEVER shrink to fit text
- Min-height: 56px with generous padding (16px 32px minimum)
- Border-radius matching the design language (8-16px modern, 28px+ pill)
- Clear, high-contrast centered text — use flexbox (display:flex; align-items:center; justify-content:center)
- Font-size: 16-18px, bold/semibold
- NEVER use default browser button styling — always set appearance:none, explicit background, color, border
- Smooth hover transition (transform scale 1.02-1.05, subtle shadow lift, or color shift)
- NEVER overflow, clip, or break layout at 393px viewport width
- NEVER put form inputs/selects/labels inside \`.rsvp-slot\` — ONLY the button

## REQUIRED DATA ATTRIBUTES (for platform dynamic content updates)
- \`data-field="title"\` — on the element containing the event title text
- \`data-field="datetime"\` — on the container with date/time information
- \`data-field="location"\` — on the container with location information
- \`data-field="dresscode"\` — on the container with dress code (omit entirely if not specified)
- \`data-field="host"\` — on the element showing host name(s), if included

## TECHNICAL CONSTRAINTS — NON-NEGOTIABLE
- Max-width 393px (iPhone), centered, mobile-first
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

## THANK YOU PAGE (theme_thankyou_html) — EXACT STRUCTURE REQUIRED
The platform automatically injects calendar buttons and footer. You ONLY provide the hero content.
\`\`\`html
<div class="thankyou-page">
  <div class="thankyou-hero">
    <h1 class="thankyou-title">Thank You!</h1>
    <p class="thankyou-subtitle"><span class="thankyou-guest">Guest</span>, we can't wait to celebrate with you!</p>
  </div>
</div>
\`\`\`
Rules:
- NO emojis in the thank you page
- NO calendar buttons, NO footer — the platform handles these
- NO extra sections (dress code, bullet lists, event details)
- The subtitle must include \`<span class="thankyou-guest">Guest</span>\` placeholder
- Style .thankyou-page with same background treatment as the invite
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
- EVERY piece of text must have sufficient contrast against its background (WCAG AA minimum)
- NEVER put light text on light backgrounds or dark text on dark backgrounds
- When using background images or gradients, add a semi-transparent overlay or text-shadow
- Button text MUST contrast against the button background color

### CONCRETE CONTRAST RULES FOR EACH SECTION:
- **Event details band** (date, time, location): If the band background is dark (green, navy, black, charcoal, etc.), the text color MUST be white or very light. If the band is light, text MUST be dark. NEVER use a warm/muted color like coral, salmon, or rose on a dark background — it will be unreadable.
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
- **Ambient background**: floating/falling elements on infinite loop, varied speeds, 0.1-0.2 opacity
- **Photo animations**: bobbing for kids parties, subtle scale pulse for editorial, soft glow for romantic
- **Entrance**: staggered fade-up on page load (animation-delay: 0.1s increments) — choreographed reveal
- **Interactive**: hover states on all buttons with smooth transitions
- **Decorative**: gentle sway or float on header decorations
- Use transform and opacity for smooth performance.
- The RSVP button must feel like the CLIMAX of the page — the visual payoff of scrolling through the invite

## WHAT KILLS A GOOD INVITE — NEVER DO THESE
- Using Inter, Roboto, or system fonts
- Purple gradients on white backgrounds
- Evenly spaced, equal-weight visual elements — hierarchy matters
- Generic "party balloons" clipart as the only decoration
- No animations — the page should feel alive
- Light text on light backgrounds or dark text on dark backgrounds
- Playing it safe when the brief is minimal — lean into a strong POV

## INSPIRATION IMAGES
If provided, analyze them for color palette, visual mood, textures, typography style, and overall aesthetic. Use as strong creative direction.`;

// The old combined prompt — kept as fallback for backward compatibility
const SYSTEM_PROMPT = STRUCTURAL_RULES + '\n\n' + DEFAULT_CREATIVE_DIRECTION;

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
// Returns { context, selectedIds } — context is the prompt string, selectedIds for logging
async function loadStyleReferences(eventType, promptSpecificity = 0) {
  try {
    const limit = promptSpecificity >= 0.5 ? 1 : 2;
    // Fetch more candidates than needed so we can weight by admin_rating
    const fetchLimit = Math.max(limit * 3, 6);
    let res = await supabase
      .from('style_library')
      .select('*')
      .contains('event_types', [eventType])
      .order('admin_rating', { ascending: false, nullsFirst: false })
      .limit(fetchLimit);
    // Fallback if admin_rating column doesn't exist yet (migration not run)
    if (res.error) {
      res = await supabase
        .from('style_library')
        .select('*')
        .contains('event_types', [eventType])
        .limit(fetchLimit);
    }
    const data = res.data;
    if (!data || data.length === 0) return { context: '', selectedIds: [] };
    // Weighted selection: higher-rated styles get picked more often
    const selected = weightedStylePick(data, limit);
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
  const { eventId, prompt, feedback, rsvpFields, eventDetails, inspirationImages, inspirationImageUrls, tweakInstructions, currentHtml, currentCss, currentConfig, photoBase64, photoUrl, photoUrls } = req.body;

  // --- INTERPRET FIELD: quick Haiku call to parse natural language into field definition ---
  if (action === 'interpretField') {
    const { userMessage, existingFields } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

    try {
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
      let field;
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        field = JSON.parse(cleaned);
      } catch {
        return res.status(500).json({ error: 'Failed to parse field', raw: text });
      }
      return res.json({ success: true, field });
    } catch (err) {
      console.error('interpretField error:', err);
      return res.status(500).json({ error: err.message });
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

      if (isLightTweak) {
        // ── LIGHT TWEAK: diff-based approach (much smaller output) ──
        tweakMessage = `Here is an invite theme. The user wants a small text/content change.
${eventContext}
**Current HTML:**
\`\`\`html
${currentHtml}
\`\`\`

**User's request:** ${tweakInstructions}

Return a JSON object with ONLY the changes needed:
{
  "html_replacements": [{"old": "exact text to find", "new": "replacement text"}],
  "rsvp_field_changes": [...] or null,
  "chat_response": "Brief friendly message about what you changed"
}

Rules:
- "old" must be an EXACT substring from the current HTML (copy-paste it precisely, including tags)
- "new" is the replacement string
- For RSVP field changes: { "action": "remove"|"add"|"modify", "field_key": "...", "label": "...", "field_type": "text"|"number"|"select"|"checkbox"|"textarea", "is_required": false }
- RSVP fields are rendered by the platform, NOT in the HTML. Do NOT add form inputs to html_replacements.
- .rsvp-slot MUST contain ONLY a <button class="rsvp-button">
- Preserve all data-field attributes`;
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

      const tweakSystemPrompt = isLightTweak
        ? `You are modifying an event invite. Make ONLY the specific text, wording, or content changes requested. Do NOT change design, layout, colors, fonts, or CSS.

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
- Thank you page: ONLY provide .thankyou-page container with .thankyou-hero (.thankyou-title + .thankyou-subtitle with .thankyou-guest span). NO calendar buttons, NO footer — the platform injects those automatically. NO emojis. Match invite's background/fonts. Style .thankyou-page, .thankyou-hero, .thankyou-title, .thankyou-subtitle in CSS.
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
      // Fallback: idle timeout resolves if no text for 5s after text started
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
        stream.on('finalMessage', done);
        stream.on('end', done);
        stream.on('error', (err) => { if (!resolved) { resolved = true; clearInterval(idleCheck); clearInterval(keepalive); reject(err); } });

        // Safety: if text was flowing but stopped for 15s AND we have substantial content, assume done
        const idleCheck = setInterval(() => {
          if (chunkCount > 0 && Date.now() - lastChunkTime > 15000 && fullText.length > 3000) {
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

      const latency = Date.now() - startTime;

      sendSSE('status', { phase: 'saving' });

      // Parse the accumulated text — strip markdown fences
      let themeText = fullText.trim();
      if (themeText.startsWith('```')) {
        themeText = themeText.replace(/^```(?:json)?\s*\n?/, '');
        themeText = themeText.replace(/\n?\s*```\s*$/, '');
        themeText = themeText.trim();
      }
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
          throw new Error('Failed to parse theme JSON: ' + parseErr.message + ' | First 300 chars: ' + themeText.substring(0, 300));
        }
      }

      // ── Light tweak: apply diff-based html_replacements ──
      if (isLightTweak && theme.html_replacements && Array.isArray(theme.html_replacements)) {
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

      // Send result to client FIRST — Vercel may kill us before DB saves complete
      sendSSE('done', {
        success: true,
        theme: { id: 'pending', version: 0, html: theme.theme_html, css: theme.theme_css, config: tweakConfig },
        chatResponse: theme.chat_response || null,
        rsvpFieldChanges: theme.rsvp_field_changes || null,
        isLightTweak
      });

      // Save as new version (best-effort — client already has the theme)
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
          model: themeModel, input_tokens: 0,
          output_tokens: 0, latency_ms: latency
        };
        let { error: tweakThemeError } = await supabase
          .from('event_themes').insert(tweakInsert).select().single();
        if (tweakThemeError) console.error('Failed to save tweak theme:', tweakThemeError.message);

        const tweakMeta = getClientMeta(req);
        supabase.from('generation_log').insert({
          event_id: eventId, user_id: user.id, prompt: 'Tweak: ' + tweakInstructions.substring(0, 200),
          model: tweakModel, input_tokens: 0,
          output_tokens: 0, latency_ms: latency, status: 'success',
          is_tweak: true, event_type: eventDetails?.eventType || '',
          client_ip: tweakMeta.ip, client_geo: tweakMeta.geo, user_agent: tweakMeta.userAgent
        }).catch(() => {});
      } catch (saveErr) {
        console.error('Tweak DB save error (theme already sent to client):', saveErr);
      }

      return res.end();
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
    let rsvpFieldsDesc = 'Default fields: Name, RSVP Status (Attending/Declined/Maybe)';
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
Make the button text fun and on-theme (e.g., "Count Me In!", "I'll Be There!", "Let's Party!").

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
5. The "Party Details" / event info band is the #1 failure point — if its background is dark, ALL text inside MUST be white
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
      max_tokens: 16384,
      system: activePrompt.systemPrompt,
      messages: [{ role: 'user', content: messageContent }]
    });

    let fullText = '';
    let chunkCount = 0;

    // Keepalive: send SSE comment every 3s to prevent mobile Safari from killing the connection
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (e) { /* connection already closed */ }
    }, 3000);

    // Use .on('text') (proven to work) + resolve on 'finalMessage' event
    // Fallback: idle timeout resolves if no text for 5s after text started
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
      stream.on('finalMessage', done);
      stream.on('end', done);
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

    const latency = Date.now() - startTime;

    sendSSE('status', { phase: 'saving' });

    // Parse JSON response — handle various wrapping patterns
    let themeText = fullText.trim();
    // Strip markdown code fences (opening and closing separately for robustness)
    if (themeText.startsWith('```')) {
      themeText = themeText.replace(/^```(?:json)?\s*\n?/, '');
      themeText = themeText.replace(/\n?\s*```\s*$/, '');
      themeText = themeText.trim();
    }
    if (!themeText.startsWith('{')) {
      const firstBrace = themeText.indexOf('{');
      const lastBrace = themeText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        themeText = themeText.substring(firstBrace, lastBrace + 1);
      }
    }

    // Attempt to repair truncated JSON if parsing fails
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
        throw new Error('Failed to parse theme JSON: ' + parseErr.message + ' | First 300 chars: ' + themeText.substring(0, 300));
      }
    }

    // Accept both snake_case and camelCase keys from Claude
    if (!theme.theme_html && theme.html) { theme.theme_html = theme.html; }
    if (!theme.theme_css && theme.css) { theme.theme_css = theme.css; }
    if (!theme.theme_config && theme.config) { theme.theme_config = theme.config; }
    if (!theme.theme_thankyou_html && theme.thankyou_html) { theme.theme_thankyou_html = theme.thankyou_html; }

    // If CSS is missing but embedded in HTML <style> tags, extract it
    if (theme.theme_html && !theme.theme_css) {
      const styleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (styleMatch) {
        theme.theme_css = styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
        theme.theme_html = theme.theme_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      }
    }

    // If HTML is a full document, extract body content and head styles
    if (theme.theme_html && theme.theme_html.includes('<!DOCTYPE')) {
      // Extract <style> from <head> if not already done
      if (!theme.theme_css) {
        const headStyleMatch = theme.theme_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
        if (headStyleMatch) {
          theme.theme_css = headStyleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
        }
      }
      // Extract Google Fonts <link> tags
      const linkMatches = theme.theme_html.match(/<link[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi);
      if (linkMatches) {
        const fontUrl = linkMatches.map(l => { const m = l.match(/href=["']([^"']+)["']/); return m ? m[1] : null; }).filter(Boolean)[0];
        if (fontUrl && !theme.theme_config?.googleFontsImport) {
          if (!theme.theme_config) theme.theme_config = {};
          theme.theme_config.googleFontsImport = fontUrl;
        }
      }
      // Extract body content
      const bodyMatch = theme.theme_html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) {
        theme.theme_html = bodyMatch[1].trim();
      }
    }

    // Default empty CSS/config if still missing
    if (!theme.theme_css) theme.theme_css = '';
    if (!theme.theme_config) theme.theme_config = {};

    // If config is missing Google Fonts, try to extract from CSS @import
    if (!theme.theme_config.googleFontsImport) {
      const fontImportMatch = (theme.theme_css || '').match(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/);
      if (fontImportMatch) {
        // Store full @import statement so client can inject it directly into <style>
        theme.theme_config.googleFontsImport = "@import url('" + fontImportMatch[1] + "');";
        theme.theme_css = theme.theme_css.replace(/@import\s+url\([^)]+\);?\s*/g, '');
      }
    }
    // Normalize: ensure googleFontsImport is always a full @import statement
    if (theme.theme_config.googleFontsImport && !theme.theme_config.googleFontsImport.startsWith('@import')) {
      theme.theme_config.googleFontsImport = "@import url('" + theme.theme_config.googleFontsImport + "');";
    }

    if (!theme.theme_html) {
      const keys = Object.keys(theme).join(', ');
      throw new Error('Invalid theme response — missing theme_html. Got keys: [' + keys + ']. First 300 chars: ' + JSON.stringify(theme).substring(0, 300));
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
    }

    // CRITICAL: Send theme to client IMMEDIATELY before DB saves.
    // Vercel may kill the function at 60s — the user must have their invite first.
    // DB saves happen after; if they fail, the user still sees the invite (it just won't be persisted).
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
          input: 0,
          output: 0
        }
      }
    });

    // Now save to DB — if Vercel kills us here, the user already has their invite
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

      const genInsert = {
        event_id: eventId,
        version: nextVersion,
        is_active: true,
        prompt: effectivePrompt,
        html: theme.theme_html,
        css: theme.theme_css,
        config: theme.theme_config,
        model: themeModel,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: latency,
        prompt_version_id: activePrompt.promptVersionId || null
      };
      let { data: newTheme, error: themeError } = await supabase
        .from('event_themes').insert(genInsert).select().single();
      if (themeError && themeError.message?.includes('prompt_version_id')) {
        delete genInsert.prompt_version_id;
        ({ data: newTheme, error: themeError } = await supabase
          .from('event_themes').insert(genInsert).select().single());
      }
      if (themeError) console.error('Failed to save theme:', themeError.message);

      // Fire-and-forget: generation log + first_generation_at
      const genMeta = getClientMeta(req);
      supabase.from('generation_log').insert({
        event_id: eventId, user_id: user.id, prompt: effectivePrompt,
        model: themeModel, input_tokens: 0,
        output_tokens: 0, latency_ms: latency,
        status: 'success', event_type: eventType, style_library_ids: usedStyleIds,
        prompt_version_id: activePrompt.promptVersionId || null,
        client_ip: genMeta.ip, client_geo: genMeta.geo, user_agent: genMeta.userAgent
      }).catch(() => {});
      supabase.from('events')
        .update({ first_generation_at: new Date().toISOString() })
        .eq('id', eventId).is('first_generation_at', null)
        .then(() => {}).catch(() => {});
    } catch (saveErr) {
      console.error('DB save error (theme already sent to client):', saveErr);
    }

    return res.end();
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
        input_tokens: 0,
        output_tokens: 0,
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
