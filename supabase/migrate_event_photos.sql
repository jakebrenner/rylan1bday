-- ============================================================
-- Event Photos — lightweight photo sharing for party attendees
-- ============================================================

-- 1. Add photos_enabled toggle to events
alter table public.events add column if not exists photos_enabled boolean not null default false;

comment on column public.events.photos_enabled is 'Whether guests can upload photos to this event';

-- 2. Event photos table
create table if not exists public.event_photos (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  uploader_name text not null,
  photo_url     text not null,
  storage_path  text not null,
  caption       text,
  width         integer,
  height        integer,
  created_at    timestamptz not null default now()
);

create index if not exists idx_event_photos_event_id on public.event_photos(event_id);
create index if not exists idx_event_photos_created_at on public.event_photos(event_id, created_at desc);

comment on table public.event_photos is 'Guest-uploaded photos for event photo sharing';

-- 3. RLS policies
alter table public.event_photos enable row level security;

-- Anyone can view photos for events with photos_enabled
create policy "Public can view event photos"
  on public.event_photos for select
  using (
    exists (
      select 1 from public.events
      where events.id = event_photos.event_id
        and events.photos_enabled = true
        and events.status = 'published'
    )
  );

-- Anyone can insert photos for events with photos_enabled
create policy "Public can upload event photos"
  on public.event_photos for insert
  with check (
    exists (
      select 1 from public.events
      where events.id = event_photos.event_id
        and events.photos_enabled = true
        and events.status = 'published'
    )
  );

-- Event owner and editors can delete photos
create policy "Owner can delete event photos"
  on public.event_photos for delete
  using (
    exists (
      select 1 from public.events
      where events.id = event_photos.event_id
        and events.user_id = auth.uid()
    )
    or exists (
      select 1 from public.event_collaborators
      where event_collaborators.event_id = event_photos.event_id
        and event_collaborators.user_id = auth.uid()
        and event_collaborators.role in ('owner', 'editor')
    )
  );
