-- ============================================================
-- Ryvite V2 — Production-Grade Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
--
-- IMPORTANT: If you already ran the old migration, you'll need to
-- drop existing tables first. Uncomment the DROP block below.
-- ============================================================

-- Uncomment if replacing existing schema:
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop trigger if exists events_updated_at on public.events;
-- drop table if exists public.notification_log cascade;
-- drop table if exists public.generation_log cascade;
-- drop table if exists public.guest_responses cascade;
-- drop table if exists public.guests cascade;
-- drop table if exists public.event_custom_fields cascade;
-- drop table if exists public.event_themes cascade;
-- drop table if exists public.event_collaborators cascade;
-- drop table if exists public.events cascade;
-- drop table if exists public.profiles cascade;
-- drop function if exists public.handle_new_user();
-- drop function if exists public.update_updated_at();
-- drop type if exists public.event_status;
-- drop type if exists public.rsvp_status;
-- drop type if exists public.collaborator_role;
-- drop type if exists public.custom_field_type;
-- drop type if exists public.notification_channel;

-- ============================================================
-- ENUM TYPES
-- ============================================================

create type public.event_status as enum ('draft', 'published', 'archived');
create type public.rsvp_status as enum ('invited', 'viewed', 'attending', 'declined', 'maybe');
create type public.collaborator_role as enum ('owner', 'editor', 'viewer');
create type public.custom_field_type as enum ('text', 'number', 'select', 'checkbox', 'email', 'phone', 'textarea');
create type public.notification_channel as enum ('email', 'sms');

-- ============================================================
-- 1. PROFILES — extends auth.users
-- ============================================================

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  display_name text not null default '',
  phone       text,
  avatar_url  text,
  tier        text not null default 'free' check (tier in ('free', 'pro', 'business')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'User profiles extending Supabase auth.users';

-- ============================================================
-- 2. EVENTS — core event data (themes live separately)
-- ============================================================

create table public.events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  title            text not null,
  description      text,
  event_type       text,              -- birthday, wedding, corporate, etc.
  event_date       timestamptz,
  end_date         timestamptz,
  timezone         text default 'America/New_York',
  location_name    text,
  location_address text,
  location_url     text,              -- Google Maps / virtual meeting link
  dress_code       text,
  max_guests       integer,           -- null = unlimited
  rsvp_deadline    timestamptz,
  slug             text not null unique,
  status           public.event_status not null default 'draft',
  settings         jsonb not null default '{}'::jsonb,  -- catch-all for misc settings
  zapier_webhook   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index idx_events_user_id on public.events(user_id);
create index idx_events_slug on public.events(slug);
create index idx_events_status on public.events(status);
create index idx_events_event_date on public.events(event_date);

comment on table public.events is 'Core event data — one row per event';

-- ============================================================
-- 3. EVENT_THEMES — AI-generated invite designs (versioned)
-- ============================================================

create table public.event_themes (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete cascade,
  version      integer not null default 1,
  is_active    boolean not null default true,
  prompt       text,                  -- user's creative direction
  html         text not null,
  css          text not null,
  config       jsonb not null default '{}'::jsonb,  -- googleFontsImport, palette, etc.
  model        text,                  -- claude model used
  input_tokens integer default 0,
  output_tokens integer default 0,
  latency_ms   integer default 0,
  created_at   timestamptz not null default now()
);

create index idx_event_themes_event_id on public.event_themes(event_id);
create index idx_event_themes_active on public.event_themes(event_id, is_active) where is_active = true;

-- Ensure only one active theme per event
create unique index idx_one_active_theme_per_event
  on public.event_themes(event_id) where is_active = true;

comment on table public.event_themes is 'AI-generated invite themes with versioning — one active per event';

-- ============================================================
-- 4. EVENT_CUSTOM_FIELDS — RSVP form field definitions
-- ============================================================

create table public.event_custom_fields (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  field_key   text not null,           -- machine-readable key (e.g. "adults")
  label       text not null,           -- display label (e.g. "Number of Adults")
  field_type  public.custom_field_type not null default 'text',
  is_required boolean not null default false,
  options     jsonb,                   -- for 'select' type: ["Option A", "Option B"]
  placeholder text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),

  unique(event_id, field_key)
);

create index idx_custom_fields_event_id on public.event_custom_fields(event_id);

comment on table public.event_custom_fields is 'Custom RSVP form fields per event';

-- ============================================================
-- 5. GUESTS — invitees and their RSVP responses
-- ============================================================

create table public.guests (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  name            text not null,
  email           text,
  phone           text,
  status          public.rsvp_status not null default 'invited',
  response_data   jsonb not null default '{}'::jsonb,  -- custom field answers
  plus_ones       integer not null default 0,
  notes           text,                -- guest's additional notes
  invited_at      timestamptz default now(),
  responded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_guests_event_id on public.guests(event_id);
create index idx_guests_status on public.guests(event_id, status);
create index idx_guests_email on public.guests(email) where email is not null;

comment on table public.guests is 'Event guests — tracks invite status, RSVP, and custom field responses';

-- ============================================================
-- 6. EVENT_COLLABORATORS — multi-admin access
-- ============================================================

create table public.event_collaborators (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       public.collaborator_role not null default 'viewer',
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  unique(event_id, user_id)
);

create index idx_collaborators_event_id on public.event_collaborators(event_id);
create index idx_collaborators_user_id on public.event_collaborators(user_id);

comment on table public.event_collaborators is 'Shared event access — replaces V1 Admins sheet';

-- ============================================================
-- 7. GENERATION_LOG — AI usage tracking & rate limiting
-- ============================================================

create table public.generation_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles(id) on delete set null,
  event_id     uuid references public.events(id) on delete set null,
  prompt       text,
  model        text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  latency_ms   integer default 0,
  status       text not null,          -- 'success' or 'error'
  error        text,
  created_at   timestamptz not null default now()
);

create index idx_gen_log_user_id on public.generation_log(user_id);
create index idx_gen_log_rate_limit on public.generation_log(user_id, created_at)
  where status = 'success';

comment on table public.generation_log is 'AI generation audit trail and rate-limit source';

-- ============================================================
-- 8. NOTIFICATION_LOG — email/SMS delivery tracking
-- ============================================================

create table public.notification_log (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid references public.events(id) on delete set null,
  guest_id     uuid references public.guests(id) on delete set null,
  channel      public.notification_channel not null,
  recipient    text not null,          -- email or phone
  subject      text,
  status       text not null default 'pending',  -- pending, sent, failed, bounced
  provider_id  text,                   -- Resend message ID, Twilio SID, etc.
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index idx_notif_log_event_id on public.notification_log(event_id);
create index idx_notif_log_guest_id on public.notification_log(guest_id);

comment on table public.notification_log is 'Email and SMS delivery tracking';

-- ============================================================
-- 9. APP_CONFIG — platform-wide settings (model selection, etc.)
-- ============================================================

create table public.app_config (
  key         text primary key,
  value       text not null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

comment on table public.app_config is 'Platform-wide configuration (model selection, feature flags, etc.)';

-- Seed defaults
insert into public.app_config (key, value) values
  ('chat_model', 'claude-haiku-4-5-20251001'),
  ('theme_model', 'claude-sonnet-4-6')
on conflict (key) do nothing;

-- ============================================================
-- 10. STYLE_LIBRARY — HTML invite templates for AI reference
-- ============================================================

create table public.style_library (
  id            text primary key,
  name          text not null,
  description   text not null default '',
  html          text not null,
  tags          text[] not null default '{}',
  event_types   text[] not null default '{}',
  design_notes  text not null default '',
  added_by      text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.style_library is 'HTML invite style samples used as AI design references during generation.';

create index style_library_event_types_idx on public.style_library using gin (event_types);
create index style_library_tags_idx on public.style_library using gin (tags);

-- ============================================================
-- SHARED FUNCTIONS & TRIGGERS
-- ============================================================

-- Generic updated_at trigger function
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply updated_at to all tables that have the column
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at();

create trigger events_updated_at
  before update on public.events
  for each row execute function public.update_updated_at();

create trigger guests_updated_at
  before update on public.guests
  for each row execute function public.update_updated_at();

create trigger style_library_updated_at
  before update on public.style_library
  for each row execute function public.update_updated_at();

-- Auto-create profile on auth.users insert
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name, phone)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    new.raw_user_meta_data->>'phone'
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_themes enable row level security;
alter table public.event_custom_fields enable row level security;
alter table public.guests enable row level security;
alter table public.event_collaborators enable row level security;
alter table public.generation_log enable row level security;
alter table public.notification_log enable row level security;
alter table public.style_library enable row level security;

-- ---- PROFILES ----

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ---- EVENTS ----

-- Owners can do everything with their events
create policy "Owners can manage own events"
  on public.events for all
  using (auth.uid() = user_id);

-- Collaborators can view events they're added to
create policy "Collaborators can view shared events"
  on public.events for select
  using (
    id in (select event_id from public.event_collaborators where user_id = auth.uid())
  );

-- Anyone can view published events (public invite pages)
create policy "Anyone can view published events"
  on public.events for select
  using (status = 'published');

-- ---- EVENT_THEMES ----

create policy "Event owners can manage themes"
  on public.event_themes for all
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

-- Anyone can view themes for published events (needed for public invite page)
create policy "Anyone can view published event themes"
  on public.event_themes for select
  using (
    event_id in (select id from public.events where status = 'published')
  );

-- ---- EVENT_CUSTOM_FIELDS ----

create policy "Event owners can manage custom fields"
  on public.event_custom_fields for all
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

-- Anyone can view fields for published events (needed for RSVP form)
create policy "Anyone can view published event fields"
  on public.event_custom_fields for select
  using (
    event_id in (select id from public.events where status = 'published')
  );

-- ---- GUESTS ----

-- Event owners can view/manage all guests
create policy "Event owners can manage guests"
  on public.guests for all
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

-- Anyone can submit an RSVP (insert a guest row)
create policy "Anyone can RSVP"
  on public.guests for insert
  with check (true);

-- Guests can update their own RSVP (matched by email)
create policy "Guests can update own RSVP"
  on public.guests for update
  using (
    email is not null and email = (select email from auth.users where id = auth.uid())
  );

-- ---- EVENT_COLLABORATORS ----

create policy "Event owners can manage collaborators"
  on public.event_collaborators for all
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

create policy "Collaborators can view own access"
  on public.event_collaborators for select
  using (user_id = auth.uid());

-- ---- GENERATION_LOG ----

create policy "Users can view own generation logs"
  on public.generation_log for select
  using (auth.uid() = user_id);

-- Service role inserts (API endpoints use service role key)
create policy "Service can insert generation logs"
  on public.generation_log for insert
  with check (true);

-- ---- NOTIFICATION_LOG ----

create policy "Event owners can view notification logs"
  on public.notification_log for select
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

create policy "Service can insert notification logs"
  on public.notification_log for insert
  with check (true);

-- ============================================================
-- DONE! Your Ryvite V2 schema is ready.
-- ============================================================
