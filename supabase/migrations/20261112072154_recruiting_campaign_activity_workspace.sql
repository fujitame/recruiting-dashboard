create table public.recruiting_campaigns (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references auth.users(id),
 campaign_key text not null, name text not null, created_at timestamptz not null default now(),
 unique(owner_user_id,campaign_key)
);
create table public.recruiting_campaign_contacts (
 campaign_id uuid not null references public.recruiting_campaigns(id), owner_user_id uuid not null references auth.users(id),
 contact_id uuid not null references public.recruiting_contacts(id), created_at timestamptz not null default now(),
 primary key(campaign_id,contact_id)
);
create table public.recruiting_campaign_schools (
 campaign_id uuid not null references public.recruiting_campaigns(id), owner_user_id uuid not null references auth.users(id),
 university_id integer not null references public.recruiting_universities(id),
 progress text not null default 'unknown' check(progress in ('unknown','conversation','camp','meeting','terms','offer','not_interested','declined')),
 reply_status text not null default 'none' check(reply_status in ('none','received','review')),
 reply_reference text not null default '', note text not null default '', updated_at timestamptz not null default now(),
 primary key(campaign_id,university_id)
);
create table public.recruiting_campaign_messages (
 id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.recruiting_campaigns(id),
 owner_user_id uuid not null references auth.users(id),contact_id uuid not null references public.recruiting_contacts(id),
 stage text not null check(stage in ('initial','follow_up_1','follow_up_2')),
 subject text not null default '', body text not null default '', planned_at timestamptz,
 tracking_id uuid references public.recruiting_email_tracking(id), created_at timestamptz not null default now(),
 unique(campaign_id,contact_id,stage)
);
alter table public.recruiting_campaigns enable row level security;
alter table public.recruiting_campaign_contacts enable row level security;
alter table public.recruiting_campaign_schools enable row level security;
alter table public.recruiting_campaign_messages enable row level security;
create policy campaign_owner on public.recruiting_campaigns for all to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()));
create policy campaign_contact_owner on public.recruiting_campaign_contacts for all to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_campaigns c where c.id=campaign_id and c.owner_user_id=(select auth.uid())) and exists(select 1 from public.recruiting_contacts c where c.id=contact_id and c.owner_user_id=(select auth.uid())));
create policy campaign_school_owner on public.recruiting_campaign_schools for all to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_campaigns c where c.id=campaign_id and c.owner_user_id=(select auth.uid())));
create policy campaign_message_owner on public.recruiting_campaign_messages for all to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_campaign_contacts c where c.campaign_id=recruiting_campaign_messages.campaign_id and c.contact_id=recruiting_campaign_messages.contact_id and c.owner_user_id=(select auth.uid())) and (tracking_id is null or exists(select 1 from public.recruiting_email_tracking t where t.id=tracking_id and t.contact_id=recruiting_campaign_messages.contact_id and t.owner_user_id=(select auth.uid()))));
grant select,insert,update,delete on public.recruiting_campaigns,public.recruiting_campaign_contacts,public.recruiting_campaign_schools,public.recruiting_campaign_messages to authenticated;
create index on public.recruiting_campaign_contacts(owner_user_id);
create index on public.recruiting_campaign_schools(owner_user_id);
create index on public.recruiting_campaign_messages(owner_user_id);
