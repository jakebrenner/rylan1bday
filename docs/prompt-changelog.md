# Prompt Changelog

All modifications to AI prompts must be logged here with rationale and learnings.
This is the institutional memory for prompt tuning — read it before making changes to avoid repeating mistakes.

> See [Prompt Registry](./prompt-registry.md) for the full map of all prompts and their locations.

## Entry Format

```
### YYYY-MM-DD — Short description
- **Prompt(s)**: Which prompt(s) changed (use names from registry)
- **Change**: What was modified (brief)
- **Rationale**: Why this change was made
- **Learning**: What we observed/learned that drove this (or "Initial entry")
- **Result**: Outcome after deployment — "Pending", "Improved X", "Reverted because Y"
```

---

## Entries

*(Add new entries here, in reverse chronological order — newest first)*

### 2026-04-04 — Fix style auto-tag over-inclusive event type matching
- **Prompt(s)**: Auto-Tag Prompt (`api/v2/prompt-test.js`, line 651)
- **Change**: Changed eventTypes guideline from "Include ALL types this style could work for" to "Be STRICT — only include 1-2 types based on THEME and SUBJECT MATTER, not just colors"
- **Rationale**: Jungle/adventure themes with gold accents were being tagged for "graduation" because the AI was matching on color formality rather than visual theme. This caused wrong styles to appear as auto-matched references in the Prompt Lab.
- **Learning**: Color-based matching is too loose — a gold palette doesn't make a jungle theme appropriate for graduation. Theme/subject matter is the primary signal for event type matching.
- **Result**: Pending — existing styles should be re-tagged with "Re-tag All" button after deploy

### 2026-04-04 — AI Auto-Scoring & Prompt Health Analyst
- **Prompt(s)**: Auto-Score Prompt (new), Health Analysis Prompt (new)
- **Change**: Added two new AI prompts: (1) Haiku auto-scorer that rates every production generation 1-5, (2) Sonnet prompt health analyst that ingests all quality data and suggests prompt improvements
- **Rationale**: Manual rating doesn't scale — most themes go unrated. The health analyst closes the loop by connecting quality data to actionable prompt changes.
- **Learning**: The platform collects rich quality data (incidents, ratings, GTP, user feedback) but nothing was analyzing it holistically. AI-powered analysis can identify patterns humans miss.
- **Result**: Pending

### 2026-04-03 — Initial Registry (Baseline Snapshot)
- **Prompt(s)**: All prompts
- **Change**: Established prompt registry, changelog, and guardian system
- **Rationale**: Multiple prompt changes were being made without tracking rationale or results, leading to accidental overwrites and lost learnings
- **Learning**: Need structured version control for hardcoded prompts beyond git history alone
- **Result**: Baseline established. All prompts documented in `docs/prompt-registry.md`.
