-- Multi-mailbox voice harvesting. Applied to production via Supabase MCP on 2026-06-15.
-- The primary Google connection stays in google_tokens (untouched, used by
-- calendar/gmail/cron/etc.). Additional mailboxes a user connects purely to
-- harvest sent-mail voice live in extra_google_mailboxes.

alter table public.google_tokens add column if not exists email text;

alter table public.google_oauth_states add column if not exists purpose text default 'primary';

create table if not exists public.extra_google_mailboxes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  access_token text,
  refresh_token text,
  scope text,
  token_type text,
  expiry_date bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, email)
);

alter table public.extra_google_mailboxes enable row level security;

drop policy if exists "owner_extra_mailboxes" on public.extra_google_mailboxes;
create policy "owner_extra_mailboxes" on public.extra_google_mailboxes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
