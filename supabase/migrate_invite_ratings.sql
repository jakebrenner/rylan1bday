-- ============================================================
-- Invite Ratings — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Stores user-facing ratings on generated invite designs.
-- Separate from prompt_test_runs (admin lab data) — this table
-- is for end users rating their actual invite themes.
--
-- Supports:
--   - Guest ratings (from RSVP page after responding)
--   - Host ratings (event owner rating their own invite)
--   - Anonymous ratings (no auth required, tracked by fingerprint)
--   - Optional text feedback
-- ============================================================

-- ============================================================
-- 1. INVITE_RATINGS — user-facing ratings on event themes
-- ============================================================

create table if not exists public.invite_ratings (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  event_theme_id  uuid not null references public.event_themes(id) on delete cascade,
  guest_id        uuid references public.guests(id) on delete set null,  -- null if host or anonymous
  rating          integer not null check (rating >= 1 and rating <= 5),
  feedback        text,                          -- optional text feedback
  rater_type      text not null default 'guest'  -- 'host', 'guest', or 'anonymous'
                  check (rater_type in ('host', 'guest', 'anonymous')),
  fingerprint     text,                          -- browser fingerprint for dedup (anonymous/guest)
  created_at      timestamptz not null default now()
);

-- Prevent duplicate ratings: one rating per guest per theme
create unique index if not exists idx_invite_ratings_guest_unique
  on public.invite_ratings (event_theme_id, guest_id) where guest_id is not null;

-- Prevent duplicate anonymous ratings: one per fingerprint per theme
create unique index if not exists idx_invite_ratings_anon_unique
  on public.invite_ratings (event_theme_id, fingerprint) where fingerprint is not null and guest_id is null;

-- Fast lookups by event and theme
create index if not exists idx_invite_ratings_event
  on public.invite_ratings (event_id);

create index if not exists idx_invite_ratings_theme
  on public.invite_ratings (event_theme_id);

comment on table public.invite_ratings is 'User-facing ratings on invite designs. Guests and hosts can rate 1-5 stars with optional feedback.';

-- ============================================================
-- 2. RLS POLICIES
-- ============================================================

alter table public.invite_ratings enable row level security;

-- Event owners can read all ratings for their events
create policy "Owners can view ratings for their events"
  on public.invite_ratings for select
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

-- Anyone can insert a rating (guests don't have auth accounts)
-- Rate-limiting and dedup handled by unique indexes above
create policy "Anyone can submit a rating"
  on public.invite_ratings for insert
  with check (true);

-- Service role has full access (for admin API and reporting)
create policy "Service role full access to invite_ratings"
  on public.invite_ratings for all
  using (true)
  with check (true);

-- ============================================================
-- 3. AGGREGATE VIEW — avg rating per theme (for quick lookups)
-- ============================================================

create or replace view public.theme_rating_summary as
select
  event_theme_id,
  event_id,
  count(*)::integer as total_ratings,
  round(avg(rating)::numeric, 2) as avg_rating,
  count(*) filter (where rating >= 4)::integer as positive_count,
  count(*) filter (where rating <= 2)::integer as negative_count
from public.invite_ratings
group by event_theme_id, event_id;

comment on view public.theme_rating_summary is 'Aggregated rating stats per theme — avg, total, positive/negative counts.';

-- ============================================================
-- DONE! Run this in Supabase SQL editor, then deploy.
-- ============================================================
