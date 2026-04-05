# Style Library Generation Prompt

Copy-paste the prompt below into a Claude conversation to generate style library templates. Claude outputs raw HTML with embedded metadata — just copy the entire output and paste it into the admin panel.

## How to Use

1. **Copy the prompt below** into a new Claude conversation
2. **Replace `[EVENT_TYPE]`** with your target type (e.g., "wedding", "kidsBirthday", "babyShower")
3. Claude generates **one complete HTML template** with metadata in a comment at the top
4. **Copy the entire HTML output** (from `<!-- STYLE_META` to `</html>`)
5. Say **"another"** or **"next"** to get a different design
6. Go to **Admin > Style Library > Bulk Upload > Paste** tab
7. Paste all templates at once (or one at a time) — the parser splits them automatically

> **Tip:** You can paste multiple templates in one go. The parser splits on `<!-- STYLE_META` boundaries. Each template is a complete HTML document — no JSON escaping, no wrapping needed.

---

## The Prompt

```
You are a world-class event invite designer creating HTML template samples for a style reference library. These templates will be studied by AI during future invite generation — they must be portfolio-worthy.

## OUTPUT FORMAT

Output a COMPLETE standalone HTML document with a metadata comment at the very top. The metadata comment MUST be the first thing in the output, before the DOCTYPE:

<!-- STYLE_META
name: Descriptive Style Name (e.g. "Midnight Garden Soiree")
eventTypes: wedding
tags: dark, botanical, serif, animation, elegant
designNotes: 2-3 sentences describing key CSS techniques, font choices, color strategy, and animation approach.
-->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=...');
    /* All CSS here */
  </style>
</head>
<body>
  <!-- Your invite design here -->
</body>
</html>

IMPORTANT:
- The STYLE_META comment MUST be the very first thing in your output
- eventTypes is comma-separated if multiple (e.g. "wedding, engagement")
- tags should be 4-8 descriptive words, comma-separated
- Output raw HTML directly — do NOT wrap in markdown code fences
- Do NOT output JSON — output the HTML document directly

## TECHNICAL REQUIREMENTS

### Hard Rules (Non-Negotiable)
- **Mobile-first responsive design**. Base styles target mobile (≤599px). Use CSS `@media` queries to enhance for tablet and desktop.
- **BREAKPOINTS** (use these exact values):
  - `@media (min-width: 600px) { /* Tablet */ }`
  - `@media (min-width: 1024px) { /* Desktop */ }`
- **Container widths**: Outermost container uses `max-width: 600px` (mobile), `768px` (tablet), `1080px` (desktop), with `margin: 0 auto`.
- **48px top padding on mobile** for iPhone notch safe area. On tablet/desktop, standard 40-72px padding.
- **Responsive typography**: Mobile min 14px body / 36px headings, Tablet 15px / 42px, Desktop 16px / 52px. Use `clamp()` for fluid headlines.
- **`data-field="title"`** attribute on the element containing the event title
- **`.rsvp-slot`** must be COMPLETELY EMPTY — no buttons, text, or children. The platform injects the RSVP form at runtime.
- **`.details-slot`** must be COMPLETELY EMPTY — platform injects `.detail-item`, `.detail-icon`, `.detail-label`, `.detail-value`
- **Google Fonts only** — NEVER use Inter, Roboto, Open Sans, Lato, Arial, or system fonts
- **CSS-only animations** — no JavaScript at all
- **WCAG AA contrast** — 4.5:1 for body text, 3:1 for headings, at ALL breakpoints
- **No fixed positioning, no iframes**
- Height: 3-5 phone screen scrolls on mobile, shorter on desktop (wider layout = less scroll)
- **SVG illustrations**: use `viewBox` with `preserveAspectRatio` so they scale. On desktop, position alongside content, not just stacked above.

### Required Page Sections (in order)
1. **THEMATIC HEADER** — animated or illustrated element specific to event type
2. **HERO SECTION** — large display headline with event title (data-field="title"). Title appears ONCE, never duplicated.
3. **EVENT DETAILS** — `<div class="details-slot"></div>` — EMPTY, platform injects content
4. **RSVP SECTION** — `<div class="rsvp-slot"></div>` — EMPTY, platform injects form

### RSVP Slot Styling (CSS only — style the platform-injected elements)
- **Mobile (base)**: `.rsvp-slot` layout: `display: flex; flex-direction: column; width: 100%;` — single column, full-width fields
- `.rsvp-slot input, .rsvp-slot select` — background, border, border-radius, padding (12px 14px), font-size (14px), width: 100%
- `.rsvp-slot label` — font-size 13px, font-weight 600, margin-bottom 4px
- `.rsvp-slot .rsvp-submit` — full-width button, min-height 52px, matching accent color, prominent
- `.rsvp-slot .rsvp-form-group` — margin-bottom 14px
- **Tablet+ (`@media min-width: 600px`)**: MAY switch to 2-column grid: `.rsvp-slot { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }` with `.rsvp-submit { grid-column: 1 / -1; }`
- **Desktop (`@media min-width: 1024px`)**: Same 2-column grid with `gap: 20px`, input padding `16px 18px`, font-size 16px, submit min-height 60px
- If RSVP background is dark/colored: `.rsvp-slot { color: #FFFFFF; }` so injected text inherits white

### Details Slot Styling (CSS only)
- `.detail-item` — `display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px;`
- `.detail-icon` — 24px, font-size 20px
- `.detail-label` — font-size 12px, uppercase, letter-spacing 0.5px, opacity 0.7
- `.detail-value` — font-size 15px, font-weight 500
- **Desktop (`@media min-width: 1024px`)**: `.details-slot` MAY use 2-column grid if 3+ details: `display: grid; grid-template-columns: 1fr 1fr; gap: 20px;`

## CREATIVE DIRECTION

- **UNFORGETTABLE** — every spacing, shadow, border-radius, animation timing feels intentional
- Choose a clear aesthetic direction and commit fully — bold maximalism AND refined minimalism both work
- **Bold, characterful display fonts** — typography does the heavy creative lifting
- **Animations are mandatory:**
  - Ambient background: theme-specific moving elements on infinite loop, 0.1-0.2 opacity
  - Entrance: staggered fade-up on load (animation-delay 0.1s increments)
  - Hover states on all interactive elements
  - RSVP button is the visual CLIMAX
- **SVG illustrations** when no photos — hand-crafted, detailed, layered
- **Background never plain white** — use pattern, texture, subtle gradient, or tinted base
- **Color:** One color dominates (60%+), max 2 accent colors. No purple gradients on white.
- **CSS custom properties** for all theme colors at `:root`

## RESPONSIVE DESIGN — DESKTOP MUST BE STUNNING, NOT JUST WIDER

- Mobile is the base — design mobile-first, then ENHANCE for larger screens using `@media` queries
- Desktop is NOT a stretched mobile view. Use the extra space deliberately:
  - Wider hero sections with side-by-side text + illustration layouts
  - More breathing room between sections (larger margins/padding)
  - Typography that takes advantage of wider measure (larger headings, better line lengths ~60-75 chars)
  - SVG illustrations can be larger, repositioned beside content rather than above
  - RSVP form can use 2-column grid for short fields on tablet+
  - Decorative/ambient animated elements should fill the wider viewport
- On tablet: refined intermediate — more padding, slightly larger type, modest layout shifts
- On desktop: premium experience — generous whitespace, sophisticated layout, hero-level typography
- NEVER just remove max-width and let mobile content stretch — actively design each breakpoint
- Every template MUST include `@media` queries for tablet (min-width: 600px) and desktop (min-width: 1024px)

## EVENT TYPE

Generate for: **[EVENT_TYPE]**

(Replace [EVENT_TYPE] with one of: wedding, kidsBirthday, adultBirthday, babyShower, bridalShower, engagement, graduation, holiday, dinnerParty, retirement, anniversary, sports, corporate)

Use fictional event details — creative name, venue, date, host. Vary cultural backgrounds.

## DIVERSITY RULE

Each time I ask for another template, you MUST vary significantly:
- Different color palette (fundamentally different, not shade variations)
- Different font pairing
- Different layout approach
- Different illustration/decorative style
- Different mood

Never repeat an aesthetic. Draw from: art deco, retro 70s, maximalist patterns, minimalist Scandinavian, Afrofuturist, vaporwave, brutalist, paper-cut art, ceramic tile, woodblock print, neon noir, stained glass, mosaic, editorial magazine, rustic, industrial loft, tropical, speakeasy, botanical, celestial, watercolor, collage, Memphis design, Swiss typography, Japanese minimalism.

Generate the first template now. Remember: output raw HTML with the STYLE_META comment at the top. No code fences, no JSON.
```

---

## Alternative: Template Factory (Built-in)

The admin panel also has a **Template Factory** for autonomous generation (uses your API credits):

1. Go to **Admin > Style Library > Template Factory**
2. Select event types, model, and count
3. Click **Start Generating** — runs autonomously with auto-tagging
4. Filter by **Unrated** to review, bulk-rate the good ones, archive the bad ones
