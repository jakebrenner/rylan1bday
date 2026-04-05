# Ryvite — Technical Overview

> **Audience:** Technical Product Manager
> **Purpose:** Understand Ryvite's architecture, AI system, and quality pipeline to improve invite creation reliability, speed, and user flow.
> **Last updated:** April 5, 2026 (v7 — template import pipeline: automated validation, review queue, admin approval workflow)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [User Flow (End-to-End)](#3-user-flow-end-to-end)
4. [AI System Deep Dive](#4-ai-system-deep-dive)
5. [Quality & Reliability Pipeline](#5-quality--reliability-pipeline)
6. [Rating & Feedback Systems](#6-rating--feedback-systems)
7. [Key Metrics](#7-key-metrics)
8. [Known Constraints & Bottlenecks](#8-known-constraints--bottlenecks)
9. [Opportunities for Improvement](#9-opportunities-for-improvement)

---

## 1. Executive Summary

Ryvite is an AI-powered event invitation platform. Users describe their event in natural language via a chat interface, and the system generates a fully custom HTML/CSS invite design — complete with RSVP form, animations, and a thank-you page — in under 60 seconds. Users can iteratively refine the design through a tiered tweak system that routes requests to the cheapest/fastest handler capable of fulfilling them.

**Core loop:** Chat → Generate → Refine → Publish → Send invitations

The system is built on three pillars:
- **Vercel** — static frontend + serverless API functions
- **Supabase** — PostgreSQL database, auth, row-level security
- **Anthropic Claude API** — AI generation across Haiku, Sonnet, and Opus models

---

## 2. Architecture Overview

### 2.1 Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Frontend** | Vanilla JS, single-file HTML apps | No framework. Files: `v2/create/`, `v2/admin/`, `v2/event/`, `v2/login/` |
| **API** | Vercel serverless functions (Node.js) | `api/v2/*.js` — each file is an independent bundle |
| **Database** | Supabase (PostgreSQL + Auth + RLS) | Row-level security, JSONB for flexible schemas |
| **AI** | Anthropic Claude API | Primary: Sonnet. Also: Haiku (fast/cheap), Opus (quality fallback) |
| **AI (secondary)** | OpenAI API | Supported models: GPT-4.1, GPT-4.1-mini, o3, o4-mini |
| **SMS** | ClickSend API | Invitation delivery and admin alerts |
| **Payments** | Stripe | Event-level billing, subscription tiers |
| **Error reporting** | Custom pipeline | DB → support ticket → email → SMS alert chain |

### 2.2 Key API Endpoints

| Endpoint | Timeout | Purpose |
|----------|---------|---------|
| `api/v2/generate-theme.js` | 300s, 1024MB | Theme generation, tweaks, intent classification, field interpretation |
| `api/v2/chat.js` | 120s | Event detail extraction via conversational AI |
| `api/v2/prompt-test.js` | 300s, 1024MB | Admin prompt lab — test prompt×model combos |
| `api/v2/quality-monitor.js` | 120s | Incident reporting, AI diagnosis, auto-heal |
| `api/v2/admin.js` | default (10s) | CRUD for prompt versions, test runs, ratings, styles, activation history, bulk upload/rating |
| `api/v2/ratings.js` | default (10s) | User-facing invite ratings (no auth required) |
| `api/v2/events.js` | default (10s) | Event CRUD, RSVP, publish |
| `api/v2/auth.js` | default (10s) | Login (magic link), signup, token refresh |
| `api/v2/billing.js` | default (10s) | Stripe integration, payment verification |
| `api/v2/template-import.js` | 30s | Template import pipeline — validates, auto-repairs, and inserts AI-generated templates into style_library with pending_review status |

### 2.3 Key Database Tables

| Table | Purpose |
|-------|---------|
| `events` | Core event data (title, date, location, slug, status, generations_to_publish) |
| `event_themes` | AI-generated invite designs, versioned per event (html, css, config, model, ratings) |
| `guests` | Invitees and RSVP responses |
| `profiles` | User profiles (tier, credits) |
| `style_library` | Curated HTML invite samples used as AI design references (status: pending_review/approved/rejected, source: manual/pipeline/admin) |
| `template_import_log` | Audit trail for pipeline imports — tracks success, validation failures, insert errors per batch |
| `prompt_versions` | Versioned creative prompts — one active version drives production |
| `prompt_test_runs` | Admin lab test results with scores |
| `generation_log` | AI generation audit trail (model, tokens, latency, cost, geo) |
| `quality_incidents` | Broken render / quality issue tracking |
| `invite_ratings` | End-user ratings (1–5 stars + feedback) on invite designs |
| `prompt_activation_history` | Audit trail for prompt version activations — tracks who activated what version, when, and what it replaced |
| `suggested_rules` | Auto-suggested prompt rules from pattern detection |

### 2.4 Infrastructure Constraints

- **No background work after `res.json()`** — Vercel terminates the function once a response is sent. All async work (logging, notifications) must complete before responding.
- **Functions can't import from each other** — Vercel bundles each file independently. Shared constants (like `STRUCTURAL_RULES`, `DESIGN_DNA`) are duplicated across `generate-theme.js` and `prompt-test.js`.
- **Default timeout is 10s** — AI-heavy endpoints require explicit `maxDuration` in `vercel.json`.
- **SSE streaming is required** for AI calls that may exceed 60s — uses `res.write()` with keepalive pings instead of buffering.

---

## 3. User Flow (End-to-End)

### 3.1 Creation Flow Steps

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 1: CHAT          Step 2: RSVP         Step 3: GENERATE & REFINE  │
│  ┌──────────────┐      ┌──────────────┐     ┌───────────────────────┐  │
│  │ User types   │      │ Confirm/edit │     │ AI generates theme    │  │
│  │ event details│─────▶│ RSVP form    │────▶│ User refines via      │  │
│  │ in natural   │      │ fields       │     │ design chat (tiered)  │  │
│  │ language     │      │              │     │                       │  │
│  └──────────────┘      └──────────────┘     └───────────┬───────────┘  │
│                                                         │              │
│                                             ┌───────────▼───────────┐  │
│                                             │ Step 4: PUBLISH       │  │
│                                             │ Review → Publish →    │  │
│                                             │ Send invitations      │  │
│                                             └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Step-by-Step Detail

| Step | What Happens | Model Used | Latency |
|------|-------------|------------|---------|
| **1. Chat** | User describes event in conversation. AI extracts: title, eventType (14 types), date, location, creative brief. Max 1 question per message. hostEmail and hostName are auto-injected from the logged-in user's profile — AI never asks for these if already known. | **Haiku** (~1024 tokens) | ~1–2s per message |
| **2. RSVP Fields** | System proposes 1 event-specific custom field (Name, Email, Phone, Status are built-in). User confirms, adds, or removes fields. Minimal by design — no dietary restrictions or meal choices suggested. | Client-side (+ Haiku for custom field interpretation) | Instant (+ ~1s for AI fields) |
| **3. Generate** | Auto-triggered when AI has vibe/theme direction — no manual "Generate" button click required. Full theme generation via SSE streaming. Returns: HTML, CSS, theme_config (colors, fonts, mood), thank-you page HTML. AI is instructed to always include `theme_thankyou_html` — if missing, a Ryvite-branded fallback with confetti SVG and coral/gold/mint gradient is shown. | **Sonnet** (default, ~16K tokens) | ~15–60s |
| **4. Refine** | Design chat — iterative tweaks routed through tiered system (see §4.4). | Varies by tier | 0ms – 60s |
| **5. Publish** | Final review, guest list builder, send invitations via email/SMS. | None | Instant |

### 3.3 Authentication & Guest Mode

- **Guest mode**: Unauthenticated users can start chatting immediately. Messages accumulate in `_guestMessages[]` and are replayed after login/signup.
- **Auth**: Magic link email (Supabase Auth). `authFetch()` wrapper auto-refreshes expired tokens on 401 responses.
- **Post-login redirect**: Stored in `localStorage.post_login_redirect` to resume flow after authentication.

### 3.4 Draft Persistence

- `saveCreateState()` serializes full state to `localStorage` (messages, RSVP fields, extracted data).
- `autoSaveDraft()` periodically persists to API.
- Drafts are cleared after publish.

---

## 4. AI System Deep Dive

### 4.1 Three-Layer Prompt Architecture

The system prompt for invite generation is split into three layers to separate platform stability from creative iteration:

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: STRUCTURAL RULES (hardcoded, never edited)        │
│  ─────────────────────────────────────────────────────────── │
│  • JSON output format (theme_css, theme_config, theme_html, │
│    thankyou_html)                                           │
│  • Platform contract: .rsvp-slot, .details-slot,            │
│    data-field="title" must exist                            │
│  • Responsive viewport: mobile-first with breakpoints at    │
│    600px (tablet) and 1024px (desktop), 1080px max-width    │
│  • 48px top safe area on mobile for iPhone notch            │
│  • WCAG AA contrast, no JS, no external images              │
│  • Google Fonts only                                        │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: CREATIVE DIRECTION (editable via prompt_versions) │
│  ─────────────────────────────────────────────────────────── │
│  • Design philosophy ("unforgettable, not just functional") │
│  • Typography rules, color approach                         │
│  • SVG illustration style, animation guidance               │
│  • Responsive design ("desktop must be stunning, not just   │
│    wider" — side-by-side layouts, 2-col RSVP, larger type)  │
│  • Anti-patterns to avoid                                   │
│  • Falls back to DEFAULT_CREATIVE_DIRECTION constant        │
├─────────────────────────────────────────────────────────────┤
│  LAYER 3: DESIGN DNA (per event type, injected dynamically) │
│  ─────────────────────────────────────────────────────────── │
│  • 14 event types: kidsBirthday, adultBirthday, wedding,    │
│    babyShower, retirement, holiday, corporate, etc.         │
│  • Each has `must` (non-negotiable) + `consider` (aesthetic │
│    suggestions the model may override)                      │
│  • Intensity adapts based on prompt specificity score       │
│  • Falls back to hardcoded DESIGN_DNA constant              │
└─────────────────────────────────────────────────────────────┘
```

**Runtime composition:**
```
system_prompt = STRUCTURAL_RULES + "\n\n" + creative_direction
user_message  = event_details + event_type_DNA + style_references + user_prompt + photos
```

**Typical input token budget:** ~7,000–11,000 tokens total (system ~4–6K, styles ~2–3K, user ~1–2K).

### 4.2 Model Strategy

| Model | Use Cases | Max Output Tokens | Cost (per 1M tokens) |
|-------|-----------|-------------------|---------------------|
| **Haiku** (`claude-haiku-4-5-20251001`) | Chat, intent classification, field interpretation, AI diagnosis, auto-tagging | ~1,024 | $1 in / $5 out |
| **Sonnet** (`claude-sonnet-4-6`) | Default theme generation, design tweaks, auto-heal | ~16,384 | $3 in / $15 out |
| **Opus** (`claude-opus-4-6`) | Escalation fallback for generation | ~16,384 | $15 in / $75 out |

**Philosophy:** Use the cheapest model that can handle the task. Haiku for understanding, Sonnet for creation, Opus only as a reliability backstop.

### 4.3 Model Escalation Chain

When the primary model is slow or produces insufficient output, the system automatically escalates:

```
Primary Model (env var or Sonnet)
  │  timeout: 45s, min output: 2KB
  │
  ▼ (if fails)
Sonnet (claude-sonnet-4-6)
  │  timeout: 60s, min output: 2KB
  │
  ▼ (if fails)
Opus (claude-opus-4-6)
     timeout: 120s, min output: 2KB
```

**Additional safeguards during streaming:**
- **Idle check:** 15s without new chunks → mark as done
- **Hard timeout:** 120s total → force completion
- **Keepalive ping:** SSE comment (`: keepalive\n\n`) every 3s to prevent mobile connection drops

### 4.4 Tiered Tweak System (Design Chat)

User refinement requests are routed to the cheapest/fastest handler that can fulfill them:

| Tier | Latency | Model | What It Handles | How |
|------|---------|-------|----------------|-----|
| **1** | 0ms | None (client-side) | Add/remove RSVP fields | State management, no API call |
| **1.75** | 0ms | None (client-side) | Text swap ("change X to Y") | Regex match → find-and-replace in HTML/CSS |
| **2** | ~1–15s | Haiku | Intent classification, field interpretation | Haiku classifies intent (add_field, remove_field, design_change, text_change, question). Routes accordingly. |
| **3** | ~15–60s | Sonnet/Opus | Full design/layout/style changes | Complete theme regeneration via SSE streaming |

**Routing logic (in `sendDesignChat()`):**
1. Check for client-side text swap (Tier 1.75) via regex
2. Call `classifyIntent` (Haiku) to determine what the user wants
3. If intent is field-related → handle client-side (Tier 1)
4. If intent is text/copy → Haiku diff-based replacement (Tier 2)
5. If intent is design/layout/style → full Sonnet regeneration (Tier 3)

**Combined commands** ("remove plus-ones and make it more festive") are split on conjunctions and each part routes independently.

**Redesign clarification:** Vague requests ("I don't like it") prompt for specifics before spending on an expensive generation.

### 4.5 Style Library & Weighted Selection

The style library contains curated HTML invite samples used as design references in the AI prompt.

**Selection algorithm:**
1. Filter styles by event type
2. Determine how many references to include based on **prompt specificity score** (0–1):
   - Score ≥ 0.5 (specific prompt) → 1 style reference
   - Score < 0.5 (vague prompt) → 2 style references
3. Load 3–6× the needed count as a candidate pool
4. Apply **weighted random selection** using composite scores

**Prompt specificity scoring** (0–1 scale, additive):
| Signal | Weight |
|--------|--------|
| Prompt length > 50 chars | +0.15 |
| Color/tone keywords | +0.15 |
| Typography keywords | +0.10 |
| Mood/aesthetic keywords | +0.15 |
| Visual/texture keywords | +0.10 |
| Animation keywords | +0.10 |

**Composite scoring formula** (per style × event type pair):

```
IF data_points < 5:
  score = admin_rating (pure curator assessment)

IF data_points ≥ 5:
  blend = data_points / (data_points + 5)    ← Bayesian damping
  score = (1 - blend) × admin_rating
        + blend × (0.40 × admin_style_rating
                 + 0.35 × avg_production_theme_quality
                 + 0.25 × avg_user_satisfaction)
```

**Exponential weight scaling:** `weight = score^1.8`
- Score 5 → weight 18.1 (dominant)
- Score 3 → weight 7.2
- Score 1 → weight 1.0

This ensures high-rated styles are strongly preferred while low-rated styles still appear occasionally for diversity.

**Template Factory (Admin Panel):**
The admin panel includes a built-in Template Factory for autonomous bulk generation of style library samples:
1. Admin selects event types, model, and count (1–100)
2. System loops autonomously: generate dummy event data → generate theme → auto-tag → save to library
3. Each template is saved immediately (progress persists if browser is closed)
4. Admin reviews by filtering to "Unrated" → rate good ones (enter weighted selection pool) → archive bad ones
5. Supports multi-select + bulk rating for fast triage

**Bulk upload/rating APIs:**
- `bulkUploadStyles` — batch insert up to 50 style library items in one call
- `bulkRateStyles` — apply ratings to multiple styles at once
- JSON paste upload in admin UI — accepts structured JSON from external Claude sessions

**External generation prompt:** `docs/style-generation-prompt.md` provides a ready-to-use prompt for generating templates in Claude chat conversations (one template per message to avoid timeouts).

**Template Import Pipeline:**
External scheduled tasks can push AI-generated templates via `api/v2/template-import.js`:
1. Auth via `x-api-key` header (rate-limited to 50 req/hr)
2. Auto-repair: injects missing platform elements (`.rsvp-slot`, `.details-slot`, `data-field="title"`), strips markdown fences, closes unclosed CSS braces, removes hallucinated images
3. Validation: mirrors `generate-theme.js` checks — platform elements, CSS/HTML length, no scripts/event handlers, no external images, Google Fonts only
4. On pass: inserts into `style_library` with `status = 'pending_review'`, `source = 'pipeline'`, default `admin_rating = 3`
5. Admin reviews via `pending-templates` / `review-template` actions in admin API
6. Only `status = 'approved'` styles appear in production generation queries
7. All imports logged to `template_import_log` for audit (view: `pipeline_import_stats`)

### 4.6 Prompt Version Management

Admins iterate on the creative direction (Layer 2) through a structured workflow:

```
Create version → Test in Prompt Lab → Rate results → Activate winner
```

**Prompt Lab (matrix testing):**
- Select multiple prompt versions × models × event types
- Generate test invites for each combination
- Rate each output 1–5 stars
- Results grouped by `test_session_id` for head-to-head comparison
- Analytics views: `test_run_analytics`, `test_session_comparisons`, `model_head_to_head`

**Activation:** Exactly one version is active at a time. Activating a new version atomically deactivates the previous one. Takes effect immediately in production. Each activation is recorded in `prompt_activation_history` (who, when, what it replaced). The `prompt_versions` table also tracks `activated_at` and `activated_by` columns directly.

**Activation history API:**
- `listActivationHistory` (GET) — activation history timeline with enriched version details
- `getActivationStats` (GET, `?historyId=`) — production generation count, quality scores, and comparison vs previous version for an activation period

### 4.7 Output Validation & Repair

Generated output passes through 20+ validation checks before delivery:

| Category | Checks |
|----------|--------|
| **Platform elements** | Missing `.rsvp-slot`, `.details-slot`, `data-field="title"` |
| **CSS integrity** | Unclosed braces, empty/too-short CSS, malformed `@keyframes`, stray `@import` |
| **Structural** | HTML too short, markdown fences in output, JSON leaked into HTML |
| **Visual rendering** | Invisible text (color matches background), offscreen content, `display:none`, `opacity:0`, zero dimensions, excessive clipping |
| **Content** | Hallucinated image URLs (strips non-Supabase URLs) |

**Auto-repair mechanisms:**
- Inject missing platform elements (`.rsvp-slot`, `.details-slot`)
- Close unclosed CSS/HTML tags
- Fix text contrast (ensure WCAG AA)
- Remove offscreen positioning
- Strip malformed `@keyframes`
- Extract CSS from `<style>` blocks if `theme_css` is empty

### 4.8 JSON Response Parsing

AI responses frequently need repair:
- Strip markdown fences (` ```json ... ``` `)
- Fix unclosed strings/braces in truncated output
- Accept both `snake_case` and `camelCase` keys
- Handle full HTML documents returned instead of JSON
- Repair escaped quotes and whitespace issues

---

## 5. Quality & Reliability Pipeline

### 5.1 Quality Monitor System

The quality monitor (`api/v2/quality-monitor.js`) tracks and auto-heals broken invite renders.

**Incident triggers:**

| Trigger | Description |
|---------|-------------|
| `broken_render` | Client-side CSS/content validation failed |
| `low_rating` | User rated a generated theme < 3 stars |
| `high_gtp` | 3+ generations without publishing |
| `user_complaint` | User reported a visual problem |
| `content_warning` | Generated content flagged |
| `auto_heal_failure` | A previous healing attempt failed |

**Incident flow:**
```
Client detects issue → Report incident → AI diagnosis (Haiku) → Auto-heal (Sonnet)
                                              │
                                              ▼
                                     Classify root cause:
                                     css_missing, css_broken, css_invisible,
                                     css_offscreen, css_contrast, content_truncated,
                                     structure_broken, render_error, style_mismatch,
                                     user_dissatisfaction, unknown
                                              │
                                              ▼
                                     Severity: critical / major / minor
                                              │
                                              ▼
                                     Can auto-heal? → Yes → Execute heal strategy
                                                     No  → Flag for manual review
```

**Heal strategies:**
- `regenerate` — Full theme regeneration with incident context
- `css_repair` — Minimal CSS edits for visual issues
- `content_inject` — Fill missing content

**Deduplication:** Max 1 incident per event+trigger within 5 minutes. Guest incidents rate-limited to 1 per IP per event per 10 minutes.

### 5.2 Pattern Detection & Auto-Suggested Rules

When 5+ incidents share the same root cause within 24 hours, the system:

1. Detects the pattern
2. Uses Haiku to generate a concise prompt rule (1–2 sentences)
3. Stores in `suggested_rules` table with status `pending`
4. Admin reviews in dashboard → `apply` (add to prompt version), `dismiss`, or `needs_deploy`

This creates a self-improving loop where production failures automatically surface prompt improvements.

### 5.3 Client-Side Resilience

| Mechanism | What It Does |
|-----------|-------------|
| **Broken render detection** | `validateContentCompleteness()` checks for missing title, details, RSVP, text content on iframe load |
| **Auto-regeneration** | First broken render auto-triggers regeneration; polls `quality-monitor` for healed theme |
| **Fallback options** | After 2+ failures, offers fallback (simpler template) |
| **Token refresh** | `authFetch()` auto-retries on 401 with refreshed Supabase token |
| **Client error reporting** | `reportClientError()` sends to API with context (funnel step, component, event ID). Rate-limited to 20 errors per page load |
| **Fallback CSS** | `buildSrcdoc()` extracts CSS from `<style>` blocks and injects guaranteed fallback styles if `theme_css` is empty |

### 5.4 Error Reporting Pipeline

When a 500 error occurs in the API, the error reporter (`api/v2/lib/error-reporter.js`) executes a multi-channel pipeline:

```
API error → Log to api_error_log table
          → Auto-create support ticket (bug_report)
          → Email admin with full context + Claude Code fix prompt
          → SMS alert to opted-in admin subscribers
```

Each notification includes: endpoint, action, error message, stack trace, request context (method, origin, IP, geo).

---

## 6. Rating & Feedback Systems

### 6.1 Three-Tier Rating System

| | Lab Ratings | Admin Theme Ratings | User-Facing Ratings |
|---|---|---|---|
| **Table** | `prompt_test_runs.score` | `event_themes.admin_rating` | `invite_ratings` |
| **Who rates** | Admin in Prompt Lab | Admin reviewing all generations | Hosts and guests |
| **What's rated** | Test generations (may never go live) | All real user-generated themes | Live invite designs |
| **Purpose** | Compare prompt × model combos | Track production generation quality | End-user satisfaction |
| **Feeds into** | Prompt version decisions | `admin_theme_quality` view, style selection | `theme_rating_summary` view, style selection |
| **Auth** | Admin token | Admin token | None (dedup by fingerprint) |

### 6.2 Closed Feedback Loop

All three rating tiers feed back into the style library's weighted selection algorithm:

```
Admin rates styles (baseline)
       │
       ▼
Styles used in generation ──→ Admin rates output themes (35% weight)
       │                              │
       ▼                              ▼
Users rate live invites (25% weight)  ◄──── composite score per (style, event_type)
       │                                           │
       ▼                                           ▼
production_style_effectiveness view ──→ Weighted selection for next generation
```

**Traceability chain:**
- `event_themes.style_library_ids` → which styles influenced each generation
- `event_themes.prompt_version_id` → which prompt version produced it
- `style_library.times_used` → usage frequency per style

### 6.3 Quality Analytics Views

| View | What It Shows |
|------|--------------|
| `admin_theme_quality` | Aggregated admin ratings by prompt version and model |
| `theme_rating_summary` | Avg rating, count, positive/negative per theme |
| `production_style_effectiveness` | Confidence-gated composite score per style × event type |
| `style_rating_impact` | Whether admin ratings are predictive of output quality (per event type) |
| `test_run_analytics` | Test run performance by prompt version, model, event type |
| `test_session_comparisons` | Head-to-head within matrix test sessions |
| `model_head_to_head` | Model win rates across all matrix tests |
| `generation_satisfaction` | GTP metrics by event type |
| `generation_geo_insights` | Generation patterns by region |
| `production_model_performance` | Real production perf by model, event type, prompt version |
| `auto_score_summary` | AI auto-score averages by prompt version and model |
| `auto_score_calibration` | Compares auto_score vs admin_rating for accuracy tracking |

### 6.4 AI-Powered Prompt Optimization Pipeline

Closes the loop from data collection to prompt improvement:

```
Every generation ──→ Haiku auto-scores 1-5 (fire-and-forget)
       │                      │
       ▼                      ▼
Quality incidents    auto_score_summary view
User feedback        ──────────┐
GTP metrics                    ▼
Admin ratings   ──→ Prompt Health Analyst (Sonnet, on-demand)
Model performance              │
Root cause patterns            ▼
                    Structured recommendations
                    (weaknesses + specific prompt fixes)
                               │
                               ▼
                    "Apply" → creates draft prompt version
                               │
                               ▼
                    Admin reviews → activates → monitor results
```

| Component | Endpoint | Model | Trigger | Cost |
|-----------|----------|-------|---------|------|
| Auto-Scorer | `generate-theme.js` (inline) | Haiku | Every generation | ~$0.002/gen |
| Health Analyst | `prompt-health.js` | Sonnet | Admin clicks "Run Analysis" | ~$0.05-0.15/run |

**Tables:** `prompt_health_analyses` (analysis results + data snapshots), `prompt_health_recommendations` (individual suggestions with pending/applied/dismissed status)

**Admin UI:** "Prompt Health" sub-tab in AI Control Center showing health score (1-10), weaknesses, suggestions with "Apply Fix" buttons, patterns, regression risks, and analysis history.

---

## 7. Key Metrics

### 7.1 Generations-to-Publish (GTP)

**Definition:** Number of theme generations before a user publishes their event. Lower GTP = higher satisfaction with generation quality.

- Tracked on `events.generations_to_publish` (computed when status first changes to "published")
- Triggers a `high_gtp` quality incident at 3+ generations without publish
- Available via `generation_satisfaction` view, broken down by event type

**Related metric:** **First-try publish rate** — % of events published after just 1 generation.

### 7.2 Generation Latency

- Median/average latency computed from last 7 days of `generation_log`
- Served via `GET /api/v2/generate-theme?action=avgLatency` (5-minute cache)
- Used in the frontend loading screen to set user time expectations

### 7.3 Cost Tracking

Each AI call logs to `generation_log`:
- `model`, `input_tokens`, `output_tokens`, `latency_ms`, `status`
- `cost_cents` (computed from model pricing table)
- `is_tweak` (refinement vs fresh generation)
- Event-level cost aggregated via `events.total_cost_cents`

### 7.4 Geographic Insights

Client IP and Vercel geo headers (country, region, city, lat/lng) logged per generation:
- Available via `generation_geo_insights` view
- Enables analysis of regional style preferences and event type distribution

---

## 8. Known Constraints & Bottlenecks

### 8.1 Infrastructure

| Constraint | Impact | Mitigation |
|-----------|--------|-----------|
| Vercel 300s max timeout | Long generations may timeout | Model escalation chain, SSE streaming |
| No background work after response | Can't fire-and-forget async tasks | All logging/notification before `res.json()` |
| Functions can't import each other | STRUCTURAL_RULES & DESIGN_DNA duplicated in 2 files (~500 lines each) | Manual sync required when updating |
| Default 10s timeout | Non-AI endpoints must be fast | Explicit `maxDuration` for AI endpoints |

### 8.2 Mobile & Browser

| Constraint | Impact | Mitigation |
|-----------|--------|-----------|
| Mobile Safari kills ReadableStream on page blur | Can't use streaming reader | Use `res.text()` to read full SSE response |
| Mobile Safari connection drops | Long generations fail | SSE keepalive ping every 3s |
| Google Fonts `@import` ordering | Fonts silently fail if not first line in `<style>` | Validation checks, auto-repair |
| iPhone notch/Dynamic Island | Content hidden behind safe area | 48px top safe area enforced in structural rules |

### 8.3 AI Output

| Constraint | Impact | Mitigation |
|-----------|--------|-----------|
| JSON truncation | Incomplete themes | Robust parser closes unclosed braces/strings |
| Hallucinated image URLs | Broken images in invites | Strip all non-Supabase URLs |
| CSS errors | Visual rendering issues | 20+ validation checks + auto-repair |
| Model inconsistency | Same prompt → different quality | Escalation chain, style references for consistency |
| `generate-theme.js` is 4500+ lines | Hard to maintain, review, test | — |

### 8.4 Rate Limits & Billing

| Constraint | Details |
|-----------|---------|
| Free tier | 2 AI designs per event (configurable in `app_config`) |
| Paid tier | Soft cap at 10 per event (logs but doesn't block) |
| Refunded events | Require new payment before generating |
| Design chat (free tier) | Only Tier 1.75 text swaps allowed (no AI calls) |

---

## 9. Opportunities for Improvement

### 9.1 Reliability

| Opportunity | Details |
|------------|---------|
| **Expand output validation** | Track auto-repair success rates; add checks for common failure modes discovered via `suggested_rules` |
| **Auto-heal success tracking** | Measure how often auto-healed themes pass subsequent validation. Currently no feedback loop on heal quality. |
| **Prompt rule auto-application** | Pattern-detected rules currently require manual admin review. Consider auto-applying for high-confidence, low-risk rules. |
| **Reduce code duplication** | STRUCTURAL_RULES and DESIGN_DNA are duplicated across files. A shared config approach (e.g., `api/v2/lib/`) would prevent drift. |
| **Structured output** | Claude supports constrained JSON output — could eliminate JSON parsing/repair entirely. |

### 9.2 Speed

| Opportunity | Details |
|------------|---------|
| **Optimize model routing** | Analyze GTP and rating data per model to find the best cost/quality/speed balance per event type |
| **Expand Tier 1.75** | More client-side pattern matching (color swaps, font changes) to avoid AI calls entirely |
| **Cache style references** | Style library queries happen every generation. In-memory or edge caching could save ~100–200ms per call. |
| **Parallel generation** | Generate 2–3 theme variants simultaneously and let the user pick — may reduce GTP at the cost of more compute |
| **Haiku for first draft** | Use Haiku for an instant "preview quality" draft, then Sonnet for the polished version — perceived speed improvement |

### 9.3 User Flow

| Opportunity | Details |
|------------|---------|
| **GTP reduction** | Analyze high-GTP events by event type, prompt specificity, and style references to identify what drives regeneration |
| **Design chat intent accuracy** | Track intent classification accuracy (Tier 2). Misrouted intents waste time (wrong tier) or money (unnecessary full regen). |
| **Payment gate UX** | Free users hitting generation limits see upgrade prompts. Analyze conversion rate and drop-off at this gate. |
| **Onboarding optimization** | Guest mode → auth → generation is a multi-step funnel. Measure drop-off at each transition. |
| **Photo handling** | Photos are compressed client-side to 800px JPEG (~200KB) before upload — no file size limit on input. Uploaded to Supabase Storage via `/api/v2/upload`. Failed image loads are stripped silently — user may not know their photo wasn't used. |

---

## Appendix: File Reference

| File | Lines | Role |
|------|-------|------|
| `api/v2/generate-theme.js` | ~4,500 | Main AI generation, tweaks, validation, repair |
| `api/v2/chat.js` | ~334 | Conversational event detail extraction |
| `api/v2/prompt-test.js` | ~1,000 | Admin prompt lab testing |
| `api/v2/quality-monitor.js` | ~1,000 | Incident tracking, AI diagnosis, auto-heal |
| `api/v2/admin.js` | ~2,000 | Admin CRUD (prompts, tests, ratings, styles) |
| `api/v2/ratings.js` | ~200 | User-facing invite ratings |
| `api/v2/lib/error-reporter.js` | ~298 | Error pipeline (DB → email → SMS) |
| `v2/create/index.html` | ~9,000 | Main creation frontend (chat, generate, refine, publish) |
| `v2/admin/index.html` | ~10,000 | Admin panel (prompts, lab, styles, quality) |
| `v2/event/index.html` | ~1,500 | Invite display, RSVP, guest experience |
| `vercel.json` | ~100 | Deployment config, timeouts, routes |
| `supabase/` | — | Database migrations (schema, views, indexes) |
