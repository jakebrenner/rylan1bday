# Style Library Generation Prompt

Copy-paste the prompt below into a Claude conversation to generate style library templates. Each output is a single JSON object you can collect and bulk-upload into the admin panel.

## How to Use

1. **Copy the prompt below** into a new Claude conversation
2. **Replace `[EVENT_TYPE]`** with your target type (e.g., "wedding", "kidsBirthday", "babyShower")
3. Claude generates **one complete template** as JSON
4. Say **"another"** or **"next"** to get a different design (diversity rules are baked in)
5. Collect all the JSON objects, wrap them in `[ ... ]` with commas between
6. Go to **Admin > Style Library > Bulk Upload > Paste JSON** tab
7. Paste the JSON array and click **Parse & Upload**

> **Tip:** If Claude times out, the one-at-a-time approach prevents lost work. For faster sessions, try "generate 2" — but if it times out, go back to one at a time.

---

## The Prompt

```
You are a world-class event invite designer creating HTML template samples for a style reference library. These templates will be studied by AI during future invite generation — they must be portfolio-worthy.

## TECHNICAL REQUIREMENTS

Generate a complete, standalone HTML document:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=393, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=...');
    /* All CSS here — use CSS custom properties for colors */
    :root { --primary: #...; --secondary: #...; --accent: #...; --bg: #...; --text: #...; }
  </style>
</head>
<body>
  <!-- 1. THEMATIC HEADER — animated/illustrated element -->
  <!-- 2. HERO SECTION — large display headline with data-field="title" attribute -->
  <!-- 3. EVENT DETAILS — EMPTY div, platform injects content -->
  <div class="details-slot"></div>
  <!-- 4. RSVP SECTION — EMPTY div, platform injects form -->
  <div class="rsvp-slot"></div>
</body>
</html>
```

### Hard Rules (Non-Negotiable)
- **Max-width: 393px**, centered, mobile-first
- **48px top padding** (phone notch safe area)
- **`data-field="title"`** attribute on the element containing the event title
- **`.rsvp-slot`** must be COMPLETELY EMPTY — no buttons, text, or children
- **`.details-slot`** must be COMPLETELY EMPTY — platform injects `.detail-item`, `.detail-icon`, `.detail-label`, `.detail-value`
- **Google Fonts only** — NEVER use Inter, Roboto, Open Sans, Lato, Arial, or system fonts
- **CSS-only animations** — no JavaScript at all
- **WCAG AA contrast** — 4.5:1 for body text, 3:1 for headings. If dark background → white text. If light background → dark text.
- **No fixed positioning, no iframes**
- Height: 3-5 phone screen scrolls

### RSVP Slot Styling (CSS only)
Style these platform-injected classes in your CSS:
- `.rsvp-slot input, .rsvp-slot select` — background, border, border-radius, padding (12px 14px), font-size (14px), width: 100%
- `.rsvp-slot label` — font-size 13px, font-weight 600, margin-bottom 4px
- `.rsvp-slot .rsvp-submit` — full-width button, min-height 52px, matching accent color, prominent
- `.rsvp-slot .rsvp-form-group` — margin-bottom 14px
- `.rsvp-slot` layout: `display: flex; flex-direction: column; width: 100%;` — NEVER use grid or row layout
- If RSVP area has a dark/colored background, set `.rsvp-slot { color: #FFFFFF; }` so all injected text inherits white

### Details Slot Styling (CSS only)
- `.detail-item` — `display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px;`
- `.detail-icon` — 24px, font-size 20px
- `.detail-label` — font-size 12px, uppercase, letter-spacing 0.5px, opacity 0.7
- `.detail-value` — font-size 15px, font-weight 500

### Thank-You Page
Also include a thank-you page HTML in your output. Structure:
```html
<div class="thankyou-page">
  <div class="thankyou-decoration">
    <svg><!-- theme-matching decorative SVG, under 2KB, with CSS animation --></svg>
  </div>
  <div class="thankyou-hero"></div>  <!-- MUST BE EMPTY — platform fills -->
</div>
```
- `.thankyou-page` must match invite's background colors/fonts
- `.thankyou-hero` must be empty (platform injects title + subtitle)
- Include CSS for `.thankyou-title`, `.thankyou-subtitle`, calendar buttons (`.cal-apple`, `.cal-google`, `.cal-outlook`)

## CREATIVE DIRECTION

- **UNFORGETTABLE** — every spacing, shadow, border-radius, animation timing feels intentional
- Choose a clear aesthetic direction and commit fully — bold maximalism AND refined minimalism both work
- **Bold, characterful display fonts** — typography does the heavy creative lifting
- **Animations are mandatory:**
  - Ambient background: theme-specific moving elements (stars, leaves, snow, fish, etc.) on infinite loop, 0.1–0.2 opacity
  - Entrance: staggered fade-up on load (animation-delay 0.1s increments)
  - Hover states on all interactive elements
  - Decorative: gentle sway/float on header elements
  - RSVP button is the visual CLIMAX
- **SVG illustrations** when no photos — hand-crafted, detailed, layered with shadows and highlights
- **Background never plain white** — use pattern, texture, subtle gradient, or tinted base
- **Color:** One color dominates (60%+), max 2 accent colors. No purple gradients on white.

## EVENT TYPE

Generate for: **[EVENT_TYPE]**

(Replace [EVENT_TYPE] with one of: wedding, kidsBirthday, adultBirthday, babyShower, bridalShower, engagement, graduation, holiday, dinnerParty, retirement, anniversary, sports, corporate)

Use fictional event details — creative name, venue, date, host. Vary cultural backgrounds of names.

## OUTPUT FORMAT

Return EXACTLY this JSON object (not an array — one template per message):

```json
{
  "name": "Descriptive Style Name (e.g. 'Midnight Garden Soirée', 'Neon Retro Bash')",
  "html": "<!DOCTYPE html>\n<html>...(complete standalone HTML with embedded CSS)...</html>",
  "thankyou_html": "<div class=\"thankyou-page\">...(complete thank-you page HTML)...</div>",
  "eventTypes": ["wedding"],
  "tags": ["dark", "botanical", "serif", "animation", "elegant"],
  "designNotes": "2-3 sentences describing key CSS techniques, font choices, color strategy, and animation approach."
}
```

## DIVERSITY RULE

Each time I ask for another template, you MUST vary significantly:
- Different color palette (not just shade variations — fundamentally different)
- Different font pairing
- Different layout approach
- Different illustration/decorative style
- Different mood (if I generated elegant last time, try playful or bold or minimalist next)

Never repeat an aesthetic. Reference these style directions for variety:
Art deco, retro 70s, maximalist patterns, minimalist Scandinavian, Afrofuturist, vaporwave, brutalist, paper-cut art, ceramic tile, woodblock print, neon noir, stained glass, mosaic, editorial magazine, rustic, industrial loft, tropical, speakeasy, botanical, celestial, watercolor, collage, Memphis design, Swiss typography, Japanese minimalism.

Generate the first template now.
```

---

## Alternative: Template Factory (Built-in)

Instead of using this manual prompt, you can use the **Template Factory** built into the admin panel:

1. Go to **Admin > Style Library**
2. Click **Template Factory**
3. Select event types, model, and count
4. Click **Start Generating** — the system runs autonomously
5. Come back later and filter by **Unrated** to review results
6. Rate the good ones (they'll enter the weighted selection pool)
7. Archive the bad ones

The factory uses the same AI generation pipeline as production, including auto-tagging and the full prompt system.
