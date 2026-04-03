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

### 2026-04-03 — Initial Registry (Baseline Snapshot)
- **Prompt(s)**: All prompts
- **Change**: Established prompt registry, changelog, and guardian system
- **Rationale**: Multiple prompt changes were being made without tracking rationale or results, leading to accidental overwrites and lost learnings
- **Learning**: Need structured version control for hardcoded prompts beyond git history alone
- **Result**: Baseline established. All prompts documented in `docs/prompt-registry.md`.
