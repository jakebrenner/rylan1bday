# Ryvite - Project Guide

## External Scripts (Google Apps Script, SQL, etc.)

Whenever Code.gs, SQL migrations, cloud functions, or any other external script is created or modified:

1. **Always paste the FULL script directly in the chat** so the user can copy-paste it into the external editor (Google Apps Script, Supabase SQL editor, database console, etc.)
2. **Never** tell the user to "go find the file" or "open the migration file" — they need the complete code right in the conversation
3. After pasting, remind the user of any deployment steps required (e.g., "Deploy > Manage deployments > New version" for Google Apps Script, or "Run in Supabase SQL editor" for migrations)

### Current Google Apps Script (Code.gs)

The backend lives in Google Apps Script and is **not auto-deployed** from this repo. The file `Code.gs` in the repo is the source of truth. When it changes, the user must manually paste it into their Apps Script editor and deploy a new version.

**Deployment steps for Google Apps Script:**
1. Open the Apps Script editor
2. Replace the entire Code.gs contents with the updated version
3. Save (Ctrl+S)
4. Deploy > Manage deployments > Edit (pencil icon) > Version: **New version** > Deploy

**Schema notes:**
- Settings sheet columns (A-F): `eventId | eventName | zapierWebhook | invitePageUrl | customFields | smsMessage`
- Invites sheet columns (A-G): `Timestamp | EventID | InviteID | Name | Phone | Status | ResponseData`
- Admins sheet columns (A-E): `phone | eventId | adminFirst | adminLast | addedAt`
- `getOrCreateSheet()` auto-migrates missing header columns, so adding new columns to `*_HEADERS` arrays is safe
- Always use explicit column counts (`SETTINGS_HEADERS.length`) when reading ranges — never rely on `getDataRange()` for sheets that may have empty trailing columns

## Architecture

- **Frontend**: Static HTML/JS in `admin/`, `invite/`, `login/`
  - V1: `admin/`, `invite/`, `login/` — Google Sheets backend
  - V2: `v2/admin/`, `v2/invite/`, `v2/login/`, `v2/create/` — Supabase backend
- **API proxy (V1)**: `api/sheets.js` — Vercel serverless function that proxies to Google Apps Script
- **API (V2)**: `api/v2/*.js` — Vercel serverless functions connecting directly to Supabase + Claude API
- **Backend (V1)**: Google Apps Script web app (Code.gs) reading/writing Google Sheets
- **Backend (V2)**: Supabase (PostgreSQL + Auth + RLS)
- **AI**: Anthropic Claude API for invite theme generation and chat-based event creation
- **Environment variables**: `GAS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`

## Event Creation & Design Chat

> **Full architecture details**: See [`DESIGN-CHAT.md`](DESIGN-CHAT.md)

### Creation Flow (v2/create/index.html)
1. **Chat** → AI extracts event details (title, date, location, type) from natural language
2. **RSVP Fields** → User confirms/edits form fields, reviews event details card
3. **Generate** → Initial theme via SSE streaming → design chat for iterative refinement
4. **Summary** → Final review → publish

### Design Chat Tiered Tweak System
User refinement requests are routed to the cheapest/fastest handler that can fulfill them:

| Tier | Latency | What It Handles | How |
|------|---------|----------------|-----|
| 1 | 0ms | Remove/modify RSVP fields | Client-side regex matching against known fields |
| 1.5 | ~1s | Add RSVP fields | Haiku interprets field name/type (256 tokens) |
| 1.75 | 0ms | Text swap ("change X to Y") | Client-side find-and-replace in HTML |
| 2 | ~5-15s | Text/copy changes | Haiku returns diff-based replacements (4K tokens) |
| 3 | ~15-60s | Design/layout/style changes | Sonnet full theme regen (16K tokens) |

**Combined commands** are supported — "remove X and add Y" splits on conjunctions and processes each part through the appropriate tier.

**Redesign clarification** — vague requests ("I don't like it") prompt for specifics before burning an expensive generation.

## Supabase Schema (V2)

### Core Tables (`supabase/migration.sql`)
| Table | Purpose |
|-------|---------|
| `profiles` | User profiles extending Supabase auth.users (id, email, tier) |
| `events` | Core event data — one row per event (title, date, location, slug, status, generations_to_publish, published_at, first_generation_at) |
| `event_themes` | AI-generated invite designs, versioned per event (html, css, config, model, admin_rating, prompt_version_id) |
| `event_custom_fields` | Custom RSVP form field definitions per event |
| `guests` | Invitees and RSVP responses (name, email, phone, status, response_data) |
| `event_collaborators` | Multi-admin access per event |
| `generation_log` | AI generation audit trail — tracks model, tokens, latency, client IP/geo, style refs, prompt version, event type, is_tweak |
| `notification_log` | SMS/email notification tracking |
| `style_library` | HTML invite samples used as AI design references (admin_rating drives weighted selection) |
| `app_config` | Global application settings |

### Prompt Version Control (`supabase/migrate_prompt_versions.sql`)
| Table | Purpose |
|-------|---------|
| `prompt_versions` | Versioned creative prompts for invite generation. One active version drives production. |
| `prompt_test_runs` | Admin lab test results — stores full generated output (HTML/CSS/config/thankyou), model, tokens, latency, style_library_ids, test_session_id, 1-5 score, notes |

### Admin Ratings (`supabase/migrate_admin_ratings.sql`)
Adds `admin_rating`, `admin_notes`, `rated_by`, `rated_at` columns to both `style_library` and `event_themes`.
Also adds `times_used` to `style_library` and `prompt_version_id` to `event_themes`.

| View | Purpose |
|------|---------|
| `admin_theme_quality` | Aggregated admin quality ratings across all generated themes, grouped by prompt version and model |

### Test Run Metadata (`supabase/migrate_test_run_metadata.sql`)
Adds `style_library_ids` (text[]) and `result_thankyou_html` to `prompt_test_runs` for full generation metadata tracking.

| View | Purpose |
|------|---------|
| `test_run_analytics` | Comprehensive test run performance by prompt version, model, and event type |
| `style_effectiveness` | How effective each style library item is as a generation reference — correlates style usage with output quality ratings |

### Test Sessions (`supabase/migrate_test_sessions.sql`)
Adds `test_session_id` and `session_position` to `prompt_test_runs`. Groups matrix test generations (same inputs, different prompt×model combos) so they can be compared head-to-head.

| View | Purpose |
|------|---------|
| `test_session_comparisons` | Head-to-head comparisons within sessions — shows score rank, best/worst per session |
| `model_head_to_head` | Model win rates across all matrix tests — which models consistently produce higher-rated output |

### Generation Insights (`supabase/migrate_generation_insights.sql`)
Adds rich metadata to `generation_log` (client_ip, client_geo, style_library_ids, prompt_version_id, event_type, is_tweak, user_agent) and tracking columns to `events` (generations_to_publish, published_at, first_generation_at).

| View | Purpose |
|------|---------|
| `generation_satisfaction` | Generations-to-publish (GTP) metrics by event type — lower GTP = higher user satisfaction |
| `generation_geo_insights` | Generation patterns by geographic region and event type |
| `production_model_performance` | Real production generation performance by model, event type, and prompt version |

### User-Facing Ratings (`supabase/migrate_invite_ratings.sql`)
| Table | Purpose |
|-------|---------|
| `invite_ratings` | End-user ratings (1-5 stars + feedback) on invite designs. Links to `event_themes`. Supports host, guest, and anonymous raters. |
| `theme_rating_summary` (view) | Aggregated avg rating, total count, positive/negative counts per theme |

### Style Feedback Loop (`supabase/migrate_style_feedback_loop.sql`)
Adds `style_library_ids` to `event_themes` for direct traceability, and composite scoring views.

| View | Purpose |
|------|---------|
| `production_style_effectiveness` | Confidence-gated composite score (1-5) **per style per event type** — below 5 data points uses pure admin_rating, above blends in production quality (35%) and user satisfaction (25%) via Bayesian damping |
| `style_rating_impact` | Validates whether admin style ratings are predictive of output quality — groups by rating tier **and event type**, shows avg output quality per combination |

### Key Relationships
- `event_themes.event_id` → `events.id` (one event has many theme versions, one active)
- `guests.event_id` → `events.id`
- `prompt_test_runs.prompt_version_id` → `prompt_versions.id` (admin lab tests)
- `invite_ratings.event_theme_id` → `event_themes.id` (user-facing ratings on actual invites)
- `invite_ratings.guest_id` → `guests.id` (optional — null for host/anonymous ratings)

## AI Prompt Architecture (3-Layer System)

The system prompt for invite generation is split into three layers:

1. **STRUCTURAL RULES** (hardcoded in `api/v2/generate-theme.js` and `api/v2/prompt-test.js`)
   - Platform contract: JSON output format, `.rsvp-slot` class, `data-*` attributes, no-JS animations, thank-you page structure
   - **Never editable** — ensures generated invites work on the platform
   - Duplicated in both files because Vercel serverless functions can't import from each other

2. **CREATIVE DIRECTION** (stored in `prompt_versions.creative_direction`)
   - Design philosophy, typography rules, color approach, SVG illustration style, animation guidance, anti-patterns
   - **Freely editable** — iterate on creative quality without breaking platform compatibility
   - Falls back to `DEFAULT_CREATIVE_DIRECTION` constant if no active DB version exists

3. **DESIGN DNA** (stored in `prompt_versions.design_dna` as JSONB)
   - Per-event-type guidance for all 14 event types (kidsBirthday, wedding, corporate, etc.)
   - Specifies mood, palette approach, illustration suggestions, typography feel per type
   - Falls back to hardcoded `DESIGN_DNA` constant if empty

**Runtime composition**: `final_prompt = STRUCTURAL_RULES + "\n\n" + creative_direction`
Design DNA is injected separately via `buildEventTypeContext()` / `buildPromptContext()`.

### Prompt Version Workflow
1. Admin creates/edits versions in Prompt Versions tab (creative direction + design DNA)
2. Admin tests versions in Prompt Lab: select multiple prompts × models → matrix test
3. Admin rates results (1-5 stars) → saved to `prompt_test_runs`
4. Reporting dashboard shows which prompt×model combos perform best
5. Admin activates the winning version → immediately used in production

## Admin API Endpoints (`api/v2/admin.js`)

All endpoints require `Authorization: Bearer <token>` and use `?action=<name>`.

### Prompt Version CRUD
- `listPromptVersions` (GET) — all versions, ordered by version desc
- `getPromptVersion` (GET, `?versionId=`) — single version with full creative_direction + design_dna
- `getActivePromptVersion` (GET) — the currently active production version
- `savePromptVersion` (POST) — create or update (pass `id` in body to update)
- `activatePromptVersion` (POST, `{versionId}`) — set as active (deactivates others)
- `deletePromptVersion` (POST, `{versionId}`) — cannot delete active version

### Test Runs & Lab Ratings
- `saveTestRun` (POST) — save a lab test result with `testSessionId` and `sessionPosition`, returns `{testRunId}`
- `listTestRuns` (GET, `?promptVersionId=&limit=`) — list test runs
- `getTestSession` (GET, `?sessionId=`) — all runs in a session with head-to-head comparison data
- `sessionInsights` (GET) — model head-to-head win rates and high-spread sessions across all matrix tests
- `updateTestRunScore` (POST, `{testRunId, score, notes}`) — update rating on a test run
- `testRunStats` (GET) — aggregated reporting: by prompt, by model, by combo, by event type, by style reference, score distribution

### Admin Ratings (Styles + Themes)
- `rateStyle` (POST, `{styleId, rating, notes}`) — rate a style library item 1-5 (affects weighted selection)
- `listThemes` (GET) — browse all generated themes with pagination + filters:
  - `?page=&limit=` — pagination (default 20, max 100)
  - `?ratingFilter=unrated|rated|1|2|3|4|5` — filter by admin rating
  - `?model=` — filter by Claude model
  - `?eventType=` — filter by event type
  - `?promptVersionId=` — filter by prompt version
  - `?sortBy=created_at|admin_rating|latency_ms&sortDir=asc|desc` — sorting
  - Returns: themes with event info, prompt version label, admin rating data
- `rateTheme` (POST, `{themeId, rating, notes}`) — rate a generated theme 1-5
- `themeQualityStats` (GET) — aggregated admin quality stats across all rated themes (by model, by prompt version, score distribution)

### Prompt Test API (`api/v2/prompt-test.js`)
- POST with `{model, eventDetails, styleLibraryIds, promptVersionId?}` — generates a test invite
- If `promptVersionId` is provided, loads that version's creative_direction from DB
- If omitted, uses the hardcoded default prompt

### Ratings API (`api/v2/ratings.js`)
No auth required — supports host, guest, and anonymous raters.
- `submit` (POST) — submit or update a rating `{eventId, eventThemeId, rating, feedback, raterType, fingerprint}`
- `summary` (GET, `?eventThemeId=`) — rating summary with all individual ratings
- `check` (GET, `?eventThemeId=&fingerprint=`) — check if host already rated this theme

## Rating Systems (3 levels)

| | Lab Ratings | Admin Theme Ratings | User-Facing Ratings |
|---|---|---|---|
| **Table** | `prompt_test_runs.score` | `event_themes.admin_rating` | `invite_ratings` |
| **Who rates** | Admin in Prompt Lab | Admin reviewing all generations | Hosts and guests (end users) |
| **What's rated** | Test generations (may never go live) | All real user-generated themes | Live invite designs |
| **Purpose** | Compare prompt×model combos | Track real-world generation quality | End-user satisfaction |
| **Feeds into** | Prompt version decisions | `admin_theme_quality` view, quality trends | `theme_rating_summary` view |
| **Auth required** | Admin token | Admin token | None (dedup by fingerprint) |
| **Status** | Implemented | API ready, admin UI not yet built | Host rating UI live, guest UI not yet built |

### Style Library Weighted Selection (Composite Feedback Loop)
- Selection uses a **confidence-gated composite score** (via `production_style_effectiveness` view):
  - **Event-type-aware**: scores are computed per `(style, event_type)` pair — a 5-star wedding rating doesn't boost the style's score for birthdays
  - **Below 5 data points** (per event type): pure `admin_rating` (prevents small-sample distortion at low volume)
  - **Above 5 data points**: gradually blends in production signals via Bayesian damping (`blend = n/(n+5)`)
    - **40% admin style rating** — curator's assessment of the template (`style_library.admin_rating`)
    - **35% production theme quality** — avg admin rating of themes generated using this style (`event_themes.admin_rating`)
    - **25% user satisfaction** — avg end-user rating of themes using this style (`invite_ratings`), falls back to lab scores
  - At 5 data points → 50% blend | 10 → 67% | 20 → 80% | 50 → 91%
- Falls back to `admin_rating`-only weighting if the `production_style_effectiveness` view isn't available
- **Exponential scaling** (`weight^1.8`) amplifies quality differences: 5-star = 18x weight vs 1-star = 1x (compared to old linear 5x/1x)
- `event_themes.style_library_ids` stores which styles influenced each generation (enables production correlation)
- `style_library.times_used` tracks how often each style is selected (for identifying over/under-used styles)
- `event_themes.prompt_version_id` tracks which prompt version produced each theme (set at generation time)
- `style_rating_impact` view validates whether admin ratings are predictive of actual output quality (per event type)

### Key Metrics
- **Generations-to-Publish (GTP)**: Number of theme generations before a user publishes their event. Lower = better UX. Tracked on `events.generations_to_publish`, computed when status first changes to "published".
- **First-try publish rate**: % of events published after just 1 generation. Available via `generation_satisfaction` view.
- **Geographic insights**: Client IP and Vercel geo headers (country, region, city, lat/lng) are logged per generation for understanding regional style preferences.
- **Style effectiveness**: Which style library references correlate with higher quality ratings. Available via `style_effectiveness` view and `testRunStats` API.

## Development Notes

- Phone numbers are normalized to 10-digit US format (strip +1 prefix)
- Custom fields config is stored as JSON string in the `customFields` column (V1) or JSONB (V2)
- RSVP response data is stored as JSON string in the `ResponseData` column (V1) or JSONB `response_data` (V2)
- The V1 API proxy sends POST bodies as `Content-Type: text/plain` to avoid GAS redirect issues
- V2 admin panel is a single-file HTML app with vanilla JS (no framework) at `v2/admin/index.html`
- V2 create page is a single-file HTML app with vanilla JS at `v2/create/index.html`
- Vercel serverless functions are isolated — shared constants (like `STRUCTURAL_RULES`) must be duplicated across files

### SSE Streaming & Mobile Safari
- All AI generation uses Server-Sent Events (SSE) to avoid Vercel's 60s timeout
- Client reads full response via `res.text()` — NOT ReadableStream (Safari mobile kills it on page blur)
- Server sends `: keepalive\n\n` every 3 seconds to prevent mobile connection drops
- Google Fonts `@import` must be first line in `<style>` block or they silently fail
- AI JSON responses may need repair: strip markdown fences, fix unclosed strings/braces, accept both `snake_case` and `camelCase` keys
