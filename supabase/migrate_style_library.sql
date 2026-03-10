-- Migration: Move style_library from app_config JSON blob to dedicated table
-- Run this in your Supabase SQL editor

-- 1. Create the new table
create table if not exists public.style_library (
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

-- 2. Indexes for efficient querying by event type and tags
create index if not exists style_library_event_types_idx on public.style_library using gin (event_types);
create index if not exists style_library_tags_idx on public.style_library using gin (tags);

-- 3. Auto-update updated_at on changes
create trigger style_library_updated_at
  before update on public.style_library
  for each row execute function public.update_updated_at();

-- 4. Enable RLS (service-role key bypasses RLS, so admin endpoints still work)
alter table public.style_library enable row level security;

-- 5. Migrate existing data from app_config JSON blob
do $$
declare
  raw_json text;
  item jsonb;
begin
  select value into raw_json from public.app_config where key = 'style_library';
  if raw_json is not null and raw_json != '' then
    for item in select jsonb_array_elements(raw_json::jsonb)
    loop
      insert into public.style_library (id, name, description, html, tags, event_types, design_notes, added_by, created_at, updated_at)
      values (
        item->>'id',
        coalesce(item->>'name', 'Untitled'),
        coalesce(item->>'description', ''),
        coalesce(item->>'html', ''),
        coalesce((select array_agg(t) from jsonb_array_elements_text(item->'tags') as t), '{}'),
        coalesce((select array_agg(t) from jsonb_array_elements_text(item->'eventTypes') as t), '{}'),
        coalesce(item->>'designNotes', ''),
        coalesce(item->>'addedBy', ''),
        coalesce((item->>'createdAt')::timestamptz, now()),
        coalesce((item->>'updatedAt')::timestamptz, now())
      )
      on conflict (id) do nothing;
    end loop;
  end if;
end $$;

-- 6. (Optional) Clean up the old JSON blob from app_config
-- Uncomment this line after verifying the migration worked:
-- delete from public.app_config where key = 'style_library';
