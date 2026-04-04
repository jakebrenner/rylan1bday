# Prompt Registry

> Central map of all AI prompts in the Ryvite codebase. Check this before modifying any prompt.
> See also: [Prompt Changelog](./prompt-changelog.md) for history and learnings.

## Protection Levels

| Level | Meaning | Before Modifying |
|-------|---------|-----------------|
| **LOCKED** | Platform contract. Breaking changes affect all invite rendering. | Get explicit user approval. Log in changelog. Mirror duplicates. |
| **GUARDED** | Core creative/behavioral prompts. Affect generation quality. | Confirm with user. Log in changelog. Check changelog for past learnings first. |
| **STANDARD** | Utility prompts. Narrower blast radius. | Use normal care. Log significant changes in changelog. |

## Invite Generation Prompts

These compose the main system prompt for theme generation. See CLAUDE.md "AI Prompt Architecture (3-Layer System)" for how they combine at runtime.

| Prompt | File | Line | Protection | Purpose |
|--------|------|------|------------|---------|
| STRUCTURAL_RULES | `api/v2/generate-theme.js` | 450 | LOCKED | Platform contract: JSON output format, `.rsvp-slot` rules, `data-*` attributes, mobile constraints (393px), WCAG contrast, thank-you page structure |
| STRUCTURAL_RULES *(copy)* | `api/v2/prompt-test.js` | 226 | LOCKED | Same — duplicated for Vercel serverless isolation |
| DEFAULT_CREATIVE_DIRECTION | `api/v2/generate-theme.js` | 607 | GUARDED | Design philosophy, typography rules, color approach, SVG illustration style, animation guidance, anti-patterns. Fallback when no DB version active. |
| DEFAULT_CREATIVE_DIRECTION *(copy)* | `api/v2/prompt-test.js` | 318 | GUARDED | Same — duplicated for Vercel serverless isolation |
| DESIGN_DNA | `api/v2/generate-theme.js` | 246 | GUARDED | Per-event-type guidance (13 types): mood, palette, illustration, typography per type. Fallback when DB version has no design_dna. |
| DESIGN_DNA *(copy)* | `api/v2/prompt-test.js` | 83 | GUARDED | Same — duplicated for Vercel serverless isolation |
| SYSTEM_PROMPT *(combined)* | `api/v2/generate-theme.js` | 661 | N/A | `STRUCTURAL_RULES + '\n\n' + DEFAULT_CREATIVE_DIRECTION` — auto-derived, not independently editable |

**Duplication warning:** STRUCTURAL_RULES, DEFAULT_CREATIVE_DIRECTION, and DESIGN_DNA exist in BOTH `generate-theme.js` and `prompt-test.js`. Changes to one MUST be mirrored in the other. Vercel bundles each serverless function independently, so they cannot share imports.

## Event Creation Chat Prompt

| Prompt | File | Line | Protection | Purpose |
|--------|------|------|------------|---------|
| SYSTEM_PROMPT (chat) | `api/v2/chat.js` | 47 | GUARDED | 3-phase event creation conversation: event details extraction, RSVP field selection, design brief building. ~142 lines. |

## Design Chat Tweak Prompts

These are constructed inline during tweak handling, not as top-level constants.

| Prompt | File | Line | Protection | Purpose |
|--------|------|------|------------|---------|
| Email Tweak Prompt | `api/v2/generate-theme.js` | 1983 | GUARDED | Email client-safe invite design: table-based layout, inline styles, Outlook VML, web-safe fonts. ~62 lines. |
| Light Tweak Prompt (Tier 2) | `api/v2/generate-theme.js` | 2047 | GUARDED | Text-only diff replacements via `html_replacements` array. Preserves design/layout. ~15 lines. |
| Design Tweak Prompt (Tier 3) | `api/v2/generate-theme.js` | 2063 | GUARDED | Full HTML/CSS redesign via chat. Preserves data attributes and RSVP slot. ~46 lines. |

## Utility Prompts

| Prompt | File | Line | Protection | Purpose |
|--------|------|------|------------|---------|
| interpretField | `api/v2/generate-theme.js` | 1662 | STANDARD | Parse natural language RSVP field requests into JSON field definitions. ~1 line. |
| classifyIntent | `api/v2/generate-theme.js` | 1733 | STANDARD | Classify user tweak request to determine tier routing (light vs design). ~1 line. |
| REFINE_PROMPT | `api/v2/prompt-test.js` | 859 | GUARDED | Senior UI designer polish pass: RSVP button sizing, contrast, spacing, layout QA. ~34 lines. |
| Quality Diagnosis | `api/v2/quality-monitor.js` | 835 | STANDARD | Diagnose quality issues in generated invites (root cause, severity, heal strategy). ~1 line inline. |
| Support Ticket Fix | `api/v2/quality-monitor.js` | 465 | STANDARD | Fix reported visual display issues in invites. Multi-line inline. |
| Quality Heal | `api/v2/quality-monitor.js` | 1140 | STANDARD | Auto-repair broken invites (HTML/CSS fixes, contrast, mobile layout). Multi-line inline. |
| Blog SEO | `api/v2/blog.js` | 593 | STANDARD | Generate SEO metadata (metaTitle, metaDescription, ogTitle, ogDescription). ~5 lines inline. |
| Blog SEO *(variant)* | `api/v2/blog.js` | 839 | STANDARD | Shorter SEO prompt variant used in a different code path. ~1 line inline. |
| FB Ads Analysis | `api/v2/fb-ads.js` | 294 | STANDARD | Analyze Facebook ad performance data and provide recommendations. ~5 lines inline. |

## Database-Managed Prompts

These are NOT in the codebase — they live in the `prompt_versions` Supabase table and are managed via the Admin UI (Prompt Versions tab).

| Field | Protection | Purpose |
|-------|------------|---------|
| `prompt_versions.creative_direction` | Managed via Admin UI | Active creative direction used in production. Overrides DEFAULT_CREATIVE_DIRECTION. |
| `prompt_versions.design_dna` | Managed via Admin UI | Active per-event-type guidance. Overrides hardcoded DESIGN_DNA. |

**Runtime flow:** `getActivePrompt()` in `generate-theme.js` (line 194) loads the active DB version. If found, it uses DB creative_direction + design_dna. If not found or empty, it falls back to the hardcoded constants above.

## Model Defaults

| Context | Default Model | File | Can Override? |
|---------|--------------|------|--------------|
| Event creation chat | `claude-haiku-4-5-20251001` | `api/v2/chat.js` | Yes, via `app_config.chat_model` |
| Theme generation | `claude-sonnet-4-6` | `api/v2/generate-theme.js` | Yes, via `app_config.theme_model` |
| Light tweaks (Tier 2) | `claude-haiku-4-5-20251001` | `api/v2/generate-theme.js` | No |
| Design tweaks (Tier 3) | Theme model (Sonnet) | `api/v2/generate-theme.js` | Via theme_model config |
| interpretField | `claude-haiku-4-5-20251001` | `api/v2/generate-theme.js` | No |
| classifyIntent | `claude-haiku-4-5-20251001` | `api/v2/generate-theme.js` | No |
| Quality diagnosis | `claude-haiku-4-5-20251001` | `api/v2/quality-monitor.js` | No |
| Quality heal | `claude-sonnet-4-6` | `api/v2/quality-monitor.js` | No |
| Refinement | `claude-sonnet-4-6` | `api/v2/prompt-test.js` | No |

---

*Last updated: 2026-04-03*
