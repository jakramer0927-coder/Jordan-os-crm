-- Track the Google Calendar event created for each follow-up (to-do) so we can
-- keep it in sync (update on edit, remove on complete/delete).
-- Applied to production via Supabase MCP on 2026-06-15.
alter table public.follow_ups add column if not exists gcal_event_id text;
