-- Expand daily_stats for KPI tracking and backfill from touch history.
-- Applied to production via Supabase MCP on 2026-06-11.
alter table public.daily_stats
  add column if not exists distinct_contacts integer,
  add column if not exists referral_asks integer,
  add column if not exists dormant_touches integer,
  add column if not exists new_contact_touches integer,
  add column if not exists notes_logged integer;

create unique index if not exists daily_stats_user_day on public.daily_stats (user_id, day);

-- Backfill last 180 days from touches (outbound only, LA time bucketing)
insert into public.daily_stats (user_id, day, touches_outbound, touches_outbound_agents, distinct_contacts, referral_asks, dormant_touches, new_contact_touches, notes_logged)
select
  t.user_id,
  (t.occurred_at at time zone 'America/Los_Angeles')::date as day,
  count(*) as touches_outbound,
  count(*) filter (where lower(coalesce(c.category,'')) = 'agent') as touches_outbound_agents,
  count(distinct t.contact_id) as distinct_contacts,
  count(*) filter (where t.intent = 'referral_ask') as referral_asks,
  count(distinct t.contact_id) filter (where prev.last_prior is not null and t.occurred_at - prev.last_prior > interval '60 days') as dormant_touches,
  count(distinct t.contact_id) filter (where prev.last_prior is null) as new_contact_touches,
  0 as notes_logged
from public.touches t
join public.contacts c on c.id = t.contact_id
left join lateral (
  select max(p.occurred_at) as last_prior
  from public.touches p
  where p.contact_id = t.contact_id
    and p.direction = 'outbound'
    and p.occurred_at < t.occurred_at
) prev on true
where t.direction = 'outbound'
  and t.user_id is not null
  and t.occurred_at > now() - interval '180 days'
group by t.user_id, (t.occurred_at at time zone 'America/Los_Angeles')::date
on conflict (user_id, day) do update set
  touches_outbound = excluded.touches_outbound,
  touches_outbound_agents = excluded.touches_outbound_agents,
  distinct_contacts = excluded.distinct_contacts,
  referral_asks = excluded.referral_asks,
  dormant_touches = excluded.dormant_touches,
  new_contact_touches = excluded.new_contact_touches;
