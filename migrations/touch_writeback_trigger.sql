-- Maintain contacts.last_contact_at / next_touch_due_at from touches.
-- Applied to production via Supabase MCP on 2026-06-11.
-- Cadence rules mirror cadenceDays() in app/api/cron/daily-accountability:
--   client: A=30 B=60 else 90 | sphere: A=60 B=90 else 120
--   agent:  A=30 else 60      | developer/vendor: 60 | default: 60

create or replace function public.touch_cadence_days(p_category text, p_tier text)
returns integer
language sql
immutable
as $$
  select case
    when lower(coalesce(p_category, '')) = 'client' then
      case upper(coalesce(p_tier, '')) when 'A' then 30 when 'B' then 60 else 90 end
    when lower(coalesce(p_category, '')) = 'sphere' then
      case upper(coalesce(p_tier, '')) when 'A' then 60 when 'B' then 90 else 120 end
    when lower(coalesce(p_category, '')) = 'agent' then
      case upper(coalesce(p_tier, '')) when 'A' then 30 else 60 end
    when lower(coalesce(p_category, '')) in ('developer', 'vendor') then 60
    else 60
  end
$$;

create or replace function public.touches_update_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contacts c
     set last_contact_at   = greatest(coalesce(c.last_contact_at, new.occurred_at), new.occurred_at),
         next_touch_due_at = greatest(coalesce(c.last_contact_at, new.occurred_at), new.occurred_at)
                             + make_interval(days => public.touch_cadence_days(c.category, c.tier)),
         updated_at = now()
   where c.id = new.contact_id;
  return new;
end
$$;

drop trigger if exists trg_touches_update_contact on public.touches;
create trigger trg_touches_update_contact
after insert on public.touches
for each row execute function public.touches_update_contact();

-- Backfill from existing touches
with last_t as (
  select contact_id, max(occurred_at) as last_at
  from public.touches
  group by contact_id
)
update public.contacts c
   set last_contact_at   = lt.last_at,
       next_touch_due_at = lt.last_at + make_interval(days => public.touch_cadence_days(c.category, c.tier))
  from last_t lt
 where lt.contact_id = c.id;
