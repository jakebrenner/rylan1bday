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
  - V2: `v2/admin/`, `v2/invite/`, `v2/login/` — Supabase backend
- **API proxy (V1)**: `api/sheets.js` — Vercel serverless function that proxies to Google Apps Script
- **API (V2)**: `api/v2/*.js` — Vercel serverless functions connecting directly to Supabase + Claude API
- **Backend (V1)**: Google Apps Script web app (Code.gs) reading/writing Google Sheets
- **Backend (V2)**: Supabase (PostgreSQL + Auth + RLS)
- **AI**: Anthropic Claude API for invite theme generation
- **Environment variables**: `GAS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`

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
| `prompt_test_runs` | Admin lab test results — stores full generated output (HTML/CSS/config/thankyou), model, tokens, latency, style_library_ids, 1-5 score, notes |

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
- `saveTestRun` (POST) — save a lab test result, returns `{testRunId}` for later score updates
- `listTestRuns` (GET, `?promptVersionId=&limit=`) — list test runs
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

## Rating Systems (3 levels)

| | Lab Ratings | Admin Theme Ratings | User-Facing Ratings |
|---|---|---|---|
| **Table** | `prompt_test_runs.score` | `event_themes.admin_rating` | `invite_ratings` |
| **Who rates** | Admin in Prompt Lab | Admin reviewing all generations | Hosts and guests (end users) |
| **What's rated** | Test generations (may never go live) | All real user-generated themes | Live invite designs |
| **Purpose** | Compare prompt×model combos | Track real-world generation quality | End-user satisfaction |
| **Feeds into** | Prompt version decisions | `admin_theme_quality` view, quality trends | `theme_rating_summary` view |
| **Auth required** | Admin token | Admin token | None (dedup by fingerprint) |
| **Status** | Implemented | API ready, admin UI not yet built | Schema ready, UI not yet built |

### Style Library Weighted Selection
- `style_library.admin_rating` (1-5) drives weighted random selection during generation
- Weight formula: rating value = weight multiplier (5-star = 5x, 1-star = 1x, unrated = 2x neutral)
- Higher-rated styles are more likely to be picked as references, but selection is probabilistic (not deterministic)
- `style_library.times_used` tracks how often each style is selected (for identifying over/under-used styles)
- `event_themes.prompt_version_id` tracks which prompt version produced each theme (set at generation time)

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
- Vercel serverless functions are isolated — shared constants (like `STRUCTURAL_RULES`) must be duplicated across files
