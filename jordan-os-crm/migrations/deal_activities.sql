-- Deal activity log
-- Run this in your Supabase SQL editor

create table if not exists deal_activities (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references deals(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  note         text not null,
  activity_type text not null default 'note',
  -- activity_type values: note, price_change, showing_feedback, offer, status_change, other
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists deal_activities_deal_id_idx on deal_activities(deal_id);
create index if not exists deal_activities_user_id_idx on deal_activities(user_id);

alter table deal_activities enable row level security;

create policy "Users manage their own deal activities"
  on deal_activities for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
