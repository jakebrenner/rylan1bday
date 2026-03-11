-- ============================================================
-- Ryvite V2 — Contacts & Invite Management Migration
-- Run this in your Supabase SQL Editor AFTER the base migration.sql
--
-- Adds: contacts, contact_tags, households, cohost_invitations
-- Modifies: guests (adds contact_id), event_collaborators (adds accepted_at)
-- ============================================================

-- ============================================================
-- 1. CONTACTS — persistent address book per user
-- ============================================================

create table public.contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  email           text,
  phone           text,
  notes           text,
  metadata        jsonb not null default '{}'::jsonb,
  -- metadata examples: { dietary: "vegetarian", birthday: "2020-03-15", relationship: "sister", age: 4 }
  source          text not null default 'manual',
  -- source: 'manual', 'rsvp', 'import', 'cohost'
  source_event_id uuid references public.events(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_contacts_user_id on public.contacts(user_id);
create index idx_contacts_email on public.contacts(user_id, email) where email is not null;
create index idx_contacts_phone on public.contacts(user_id, phone) where phone is not null;
create unique index idx_contacts_unique_email on public.contacts(user_id, lower(email)) where email is not null;

comment on table public.contacts is 'Persistent address book — contacts owned by each user, auto-captured from RSVPs';

-- ============================================================
-- 2. CONTACT_TAGS — user-defined labels with colors
-- ============================================================

create table public.contact_tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  color      text,  -- hex color for UI badge, e.g. '#A78BFA'
  created_at timestamptz not null default now(),

  unique(user_id, lower(name))
);

create index idx_contact_tags_user_id on public.contact_tags(user_id);

comment on table public.contact_tags is 'User-defined tag labels for organizing contacts';

-- ============================================================
-- 3. CONTACT_TAG_ASSIGNMENTS — many-to-many join
-- ============================================================

create table public.contact_tag_assignments (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id     uuid not null references public.contact_tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);

create index idx_tag_assignments_tag on public.contact_tag_assignments(tag_id);

comment on table public.contact_tag_assignments is 'Links contacts to tags (many-to-many)';

-- ============================================================
-- 4. HOUSEHOLDS — family/group units
-- ============================================================

create table public.households (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,  -- e.g. "The Smiths", "Johnson Family"
  notes      text,
  metadata   jsonb not null default '{}'::jsonb,
  -- metadata: { address: "123 Main St", dietary_notes: "nut-free household" }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_households_user_id on public.households(user_id);

comment on table public.households is 'Family/group units for organizing contacts into households';

-- ============================================================
-- 5. HOUSEHOLD_MEMBERS — links contacts to households
-- ============================================================

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  contact_id   uuid not null references public.contacts(id) on delete cascade,
  role         text not null default 'adult',  -- 'adult', 'child', 'primary'
  primary key (household_id, contact_id)
);

create index idx_household_members_contact on public.household_members(contact_id);

comment on table public.household_members is 'Links contacts to households with a role (adult, child, primary)';

-- ============================================================
-- 6. COHOST_INVITATIONS — pending co-host invitations
-- ============================================================

create table public.cohost_invitations (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  email      text not null,
  role       public.collaborator_role not null default 'editor',
  invited_by uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),

  unique(event_id, email)
);

create index idx_cohost_invitations_token on public.cohost_invitations(token);
create index idx_cohost_invitations_email on public.cohost_invitations(email);

comment on table public.cohost_invitations is 'Pending co-host invitations with token-based acceptance flow';

-- ============================================================
-- 7. MODIFICATIONS TO EXISTING TABLES
-- ============================================================

-- Link guests back to canonical contacts
alter table public.guests
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

create index if not exists idx_guests_contact_id on public.guests(contact_id) where contact_id is not null;

-- Track when co-hosts accepted
alter table public.event_collaborators
  add column if not exists accepted_at timestamptz;

-- ============================================================
-- 8. UPDATED_AT TRIGGERS for new tables
-- ============================================================

create trigger contacts_updated_at
  before update on public.contacts
  for each row execute function public.update_updated_at();

create trigger households_updated_at
  before update on public.households
  for each row execute function public.update_updated_at();

-- ============================================================
-- 9. ROW LEVEL SECURITY (RLS)
-- ============================================================

-- contacts
alter table public.contacts enable row level security;

create policy "Users manage own contacts"
  on public.contacts for all
  using (auth.uid() = user_id);

-- contact_tags
alter table public.contact_tags enable row level security;

create policy "Users manage own tags"
  on public.contact_tags for all
  using (auth.uid() = user_id);

-- contact_tag_assignments
alter table public.contact_tag_assignments enable row level security;

create policy "Users manage own tag assignments"
  on public.contact_tag_assignments for all
  using (
    contact_id in (select id from public.contacts where user_id = auth.uid())
  );

-- households
alter table public.households enable row level security;

create policy "Users manage own households"
  on public.households for all
  using (auth.uid() = user_id);

-- household_members
alter table public.household_members enable row level security;

create policy "Users manage own household members"
  on public.household_members for all
  using (
    household_id in (select id from public.households where user_id = auth.uid())
  );

-- cohost_invitations
alter table public.cohost_invitations enable row level security;

create policy "Event owners manage cohost invitations"
  on public.cohost_invitations for all
  using (
    event_id in (select id from public.events where user_id = auth.uid())
  );

create policy "Invitees can view own invitations"
  on public.cohost_invitations for select
  using (
    lower(email) = lower((select email from auth.users where id = auth.uid()))
  );

-- ============================================================
-- DONE! Contacts & invite management schema is ready.
-- ============================================================
