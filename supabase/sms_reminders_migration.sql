-- ============================================================
-- Ryvite V2 — SMS Reminders & Host Notification Preferences
-- Run this in your Supabase SQL Editor AFTER sms_billing_migration.sql
--
-- Adds: sms_reminders table for scheduled event reminders
-- Adds: event_notification_prefs table for host RSVP notification settings
-- ============================================================

-- ============================================================
-- 1. SMS_REMINDERS — scheduled reminders per event
-- ============================================================

create table if not exists public.sms_reminders (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  offset_minutes  integer not null,           -- minutes before event (10080=1wk, 1440=1day, 60=1hr)
  message         text not null,              -- SMS body to send
  scheduled_for   timestamptz not null,       -- computed: event_date - offset_minutes
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'cancelled', 'failed')),
  sent_at         timestamptz,
  recipients_count integer default 0,         -- how many guests received this reminder
  created_at      timestamptz not null default now()
);

-- Efficient lookup for cron: find all pending reminders that are due
create index idx_sms_reminders_due on public.sms_reminders(scheduled_for)
  where status = 'pending';
create index idx_sms_reminders_event on public.sms_reminders(event_id);
create index idx_sms_reminders_user on public.sms_reminders(user_id);

comment on table public.sms_reminders is 'Scheduled SMS reminders sent to guests before an event';

-- ============================================================
-- 2. EVENT_NOTIFICATION_PREFS — host notification settings
-- ============================================================

create table if not exists public.event_notification_prefs (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  notify_on_rsvp  boolean not null default false,
  notify_mode     text not null default 'instant'
                  check (notify_mode in ('instant', 'digest')),
  notify_phone    text not null,              -- host phone to receive notifications
  last_digest_at  timestamptz default now(),  -- tracks when last digest was sent
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(event_id)
);

create index idx_notification_prefs_user on public.event_notification_prefs(user_id);

comment on table public.event_notification_prefs is 'Host notification preferences per event (RSVP alerts)';

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.sms_reminders enable row level security;
alter table public.event_notification_prefs enable row level security;

-- Users can manage their own reminders
create policy "Users can view own reminders"
  on public.sms_reminders for select
  using (auth.uid() = user_id);

create policy "Users can create own reminders"
  on public.sms_reminders for insert
  with check (auth.uid() = user_id);

create policy "Users can update own reminders"
  on public.sms_reminders for update
  using (auth.uid() = user_id);

-- Service role manages all reminders (cron job sends them)
create policy "Service can manage all reminders"
  on public.sms_reminders for all
  using (true);

-- Users can manage their own notification prefs
create policy "Users can view own notification prefs"
  on public.event_notification_prefs for select
  using (auth.uid() = user_id);

create policy "Users can create own notification prefs"
  on public.event_notification_prefs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own notification prefs"
  on public.event_notification_prefs for update
  using (auth.uid() = user_id);

-- Service role manages all prefs (for cron digest lookups)
create policy "Service can manage all notification prefs"
  on public.event_notification_prefs for all
  using (true);

-- ============================================================
-- DONE! Run this in your Supabase SQL editor.
-- ============================================================
