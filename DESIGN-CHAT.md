# Design Chat & Theme Generation Architecture

This document covers the complete invite generation and design chat tweak system — from initial theme creation through iterative refinement.

## Event Creation Flow (`v2/create/index.html`)

The creation page is a multi-step wizard:

| Step | View | What Happens |
|------|------|-------------|
| 1 | Chat | AI-powered conversation extracts event details (title, date, location, type, etc.) |
| 1→2 | RSVP Fields | User confirms/edits RSVP form fields, then confirms event details card |
| 2 | Generate | Initial theme generation via SSE streaming → preview with design chat |
| 3 | Summary | Final review → publish event |

### Step 1: Chat-Based Event Creation
- User describes their event in natural language
- `api/v2/chat.js` uses Claude to extract structured data: title, dates, location, event type, dress code, host name, tagline
- Chat supports follow-up questions, clarifications, style preferences
- Draft event is created in Supabase on first message (appears in dashboard immediately)
- Style preference textarea is pre-populated with context from the conversation

### Step 2: Theme Generation
- Calls `POST /api/v2/generate-theme` with event details, RSVP fields, style prompt, inspiration images, and person photos
- Response is SSE-streamed to avoid Vercel's 60s timeout
- Result: HTML, CSS, config JSON, and thank-you page HTML
- Stored as a versioned `event_themes` row in Supabase
- Multiple versions supported — user can browse a version gallery

## Initial Generation (`api/v2/generate-theme.js`, action=`generate`)

### SSE Streaming Architecture
All generation uses Server-Sent Events to avoid Vercel timeout limits:

```
Client                          Server (Vercel)
  |                                |
  |  POST /generate-theme          |
  |------------------------------->|
  |                                |  Set headers: text/event-stream
  |  event: status                 |  Start Claude API call
  |<-------------------------------|
  |                                |  Every 3s: `: keepalive\n\n`
  |  : keepalive                   |  (prevents Safari mobile disconnect)
  |<-------------------------------|
  |                                |  Claude finishes
  |  event: done                   |
  |  data: {theme_html, ...}       |
  |<-------------------------------|
```

**Client-side SSE parsing**: Uses `res.text()` (not ReadableStream) because Safari mobile kills ReadableStream on page blur. The full response is parsed line-by-line for `event:` and `data:` prefixes.

### AI Prompt Composition (3-Layer System)

```
STRUCTURAL_RULES (hardcoded, never editable)
  + CREATIVE_DIRECTION (from active prompt_version or default)
  + DESIGN_DNA (per-event-type guidance from prompt_version or default)
  = Final system prompt
```

See `CLAUDE.md` → "AI Prompt Architecture" for full details.

### JSON Response Handling
The AI returns a JSON object with: `theme_html`, `theme_css`, `theme_config`, `theme_thankyou_html`.

Robustness measures:
- Strip markdown code fences (``` wrapping)
- Accept both `snake_case` and `camelCase` keys (`theme_html` or `themeHtml`)
- Extract embedded `<style>` blocks if CSS is missing
- Handle full HTML documents (extract `<body>` content, `<head>` styles, font links)
- JSON repair: fix unclosed strings, braces, brackets from truncated streams

## Design Chat Tweak System

After initial generation, users refine their invite via a chat interface. Requests are routed through a **tiered system** that matches request complexity to the cheapest/fastest handler.

### Tier Overview

| Tier | Latency | Model | What It Handles | Cost |
|------|---------|-------|----------------|------|
| 1 | 0ms | None | Remove/modify RSVP fields | Free |
| 1.5 | ~1s | Haiku (256 tokens) | Add RSVP fields | Minimal |
| 1.75 | 0ms | None | Text swap ("change X to Y") | Free |
| 2 | ~5-15s | Haiku (4K tokens) | Text/copy changes | Low |
| 3 | ~15-60s | Sonnet (16K tokens) | Design/layout/style changes | Standard |

### Tier 1: Instant RSVP Field Changes (client-side only)

**Function**: `tryInstantRsvpFieldChange(text, hasPhotos)`

Detects field management requests using regex, no AI needed:
- **Remove**: "remove the dietary restrictions field", "delete number of children"
- **Modify**: "make phone required", "set email optional"
- **Combined**: "remove X and add Y" — splits on "and"/"&"/commas, processes each part

**Remove matching** is fuzzy: normalizes keys/labels (strip spaces, dashes, underscores) and checks substring containment in both directions. This is why removal is fast and accurate — it's matching against known field names.

**Combined commands**: The parser splits the message on conjunction words, processes each part independently, and returns a `mixed` result that applies sync changes immediately and queues async (add) changes.

### Tier 1.5: AI-Interpreted Field Addition (~1 second)

**Endpoint**: `POST /api/v2/generate-theme?action=interpretField`

Adding a field requires understanding natural language ("add a field for number of pets" → label: "Number of Pets", type: number, placeholder: "e.g., 2"). A quick Haiku call (256 max tokens) interprets the request:

```json
Input:  { "userMessage": "add a field for number of pets", "existingFields": [...] }
Output: { "label": "Number of Pets", "field_key": "number_of_pets",
          "field_type": "number", "is_required": false, "placeholder": "e.g., 2" }
```

Falls through to full AI tweak if interpretation fails.

### Tier 1.75: Instant Text Swap (client-side only)

**Function**: `tryInstantTextSwap(text, hasPhotos)`

Detects "change X to Y" / "replace X with Y" patterns and does a direct case-insensitive find-and-replace in the current HTML. No AI call at all.

**Exclusions**: If the old/new text contains design words (color, font, background, etc.), it falls through to the AI tiers since the user probably wants a design change, not a literal text replacement.

### Tier 2: Light Tweaks (Haiku, diff-based)

**Server-side classification** (`api/v2/generate-theme.js`):
```
isLightTweak = isTextSwap || (!hasPhotos && !designKeywords.some(kw => instructions.includes(kw)))
```

Design keywords: color, font, background, layout, animation, style, theme, photo, image, darker, lighter, bigger, smaller, redesign, etc.

**Response format** — diff-based, not full regen:
```json
{
  "html_replacements": [{"old": "exact substring", "new": "replacement"}],
  "rsvp_field_changes": null,
  "chat_response": "Changed the heading text!"
}
```

Replacements are applied sequentially with `.replace()`. Much faster and cheaper than regenerating the full theme.

### Tier 3: Design Tweaks (Sonnet, full regen)

For visual changes: colors, fonts, layout, animations, photos, style overhauls.

**Response format** — full theme output:
```json
{
  "theme_html": "...", "theme_css": "...",
  "theme_config": {...}, "theme_thankyou_html": "...",
  "chat_response": "Here's your updated design!",
  "rsvp_field_changes": null
}
```

Supports:
- Multiple photo embedding (grid, row, overlapping, staggered layouts)
- Thank-you page updates (only if visual changes warrant it)
- RSVP field changes returned from AI alongside design changes

### Redesign Clarification Flow

When the user sends a vague or broad request ("I don't like it", "change everything"), the system prompts for clarification before burning an expensive generation:

- **Full redesign detected**: "new design", "redesign", "start fresh", "completely different"
  - Options: "Keep theme, change layout" / "Keep colors, new design" / "Keep photos, change everything" / "Change everything"
- **Vague dissatisfaction**: "don't like", "not sure", "make changes", "hmm"
  - Options: "Change the theme/vibe" / "Change the layout" / "Change colors/fonts" / "Start fresh"
- **Specific instruction detected** (has "make the", "change the", "add", color words, etc.) → skip clarification, proceed directly

## RSVP Field Management

### Data Structure
```javascript
{
  field_key: "dietary_restrictions",
  label: "Dietary Restrictions",
  field_type: "text|number|select|checkbox|email|phone|textarea",
  is_required: false,
  options: ["Vegan", "Gluten-free"] || null,
  placeholder: "e.g., No nuts",
  enabled: true
}
```

### Field Change Pipeline
1. User sends chat message → `tryInstantRsvpFieldChange()` detects intent
2. For adds: `interpretField` API call → Haiku returns field definition
3. `applyRsvpFieldChanges()` modifies the local `rsvpFields` array
4. `saveCustomFields()` persists to Supabase via `POST /api/v2/events?action=saveFields`
5. `renderPreview()` re-renders the invite with updated fields
6. AI-generated tweaks can also return `rsvp_field_changes` — applied the same way

### Field Sources
Fields can be modified from two paths:
- **Client-side tiers** (1, 1.5): Instant or near-instant, regex + Haiku
- **Server-side AI** (tiers 2, 3): AI returns `rsvp_field_changes` array alongside design changes

Both paths converge on `applyRsvpFieldChanges()` → `saveCustomFields()`.

## Progress & Loading UX

### Generation Loading
- Cycling puns displayed during generation (shuffled randomly)
- Progress bar: fast ramp (12% increments), medium (8%), slow crawl (3%), capped at 92%
- Puns fade-transition every 2 seconds
- Progress bar updated directly (no full re-render) for smoothness

### Error Handling
- **504 timeout**: "That update took too long — try a simpler change"
- **Parse failure**: Show error with debug info, user can retry
- **Network failure**: Persistent error screen (not silent fallback)
- **413 payload too large**: Auto-retry without inspiration images

## Mobile-Specific Handling

Several Safari mobile bugs required workarounds:
- **ReadableStream killed on page blur**: Use `res.text()` instead of streaming reader
- **Connection drops**: SSE keepalive pings every 3 seconds
- **"Load failed" errors**: Auto-retry logic for network failures
- **Google Fonts not loading**: Ensure `@import` is first in `<style>` block
- **Dark-on-dark text flash**: Detail override styles injected before preview renders

## Version Gallery

- All generated versions stored in `themeVersions` array
- `activeVersionIndex` tracks current selection
- Users can browse previous versions in a thumbnail gallery
- Each version cached in sessionStorage for instant reload
- Version history includes both initial generations and tweak results

## Key Files

| File | Role |
|------|------|
| `v2/create/index.html` | Full creation wizard — chat, generation, design chat, preview, publish |
| `api/v2/generate-theme.js` | Theme generation, tweak routing, interpretField, SSE streaming |
| `api/v2/chat.js` | Chat-based event detail extraction |
| `api/v2/events.js` | Event CRUD, RSVP field persistence |
| `api/v2/prompt-test.js` | Admin prompt lab testing (same structural rules, different entry point) |
