-- Phase 6-D1: Profile -> CRM inbound recruiting lead intake
-- Safe design: public Profile can submit only through a validation RPC.
-- Direct table access remains protected by RLS.

do $$
begin
  if to_regclass('public.recruiting_inbound_leads') is not null then
    raise exception 'Phase 6-D1 collision: recruiting_inbound_leads already exists';
  end if;
  if exists (
    select 1 from pg_proc
    where pronamespace='public'::regnamespace
      and proname='submit_recruiting_inquiry'
  ) then
    raise exception 'Phase 6-D1 collision: submit_recruiting_inquiry already exists';
  end if;
end $$;

create table public.recruiting_inbound_leads (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  coach_name text not null,
  coach_email text not null,
  inquiry_type text not null,
  message_body text not null,
  source_url text,
  lead_status text not null default 'new'
    check (lead_status in ('new','linked','dismissed')),
  linked_contact_id uuid references public.recruiting_contacts(id) on delete set null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint recruiting_inbound_leads_owner_request_unique
    unique (owner_user_id, request_id)
);

create index recruiting_inbound_leads_owner_status_created_idx
  on public.recruiting_inbound_leads(owner_user_id, lead_status, created_at desc);

alter table public.recruiting_inbound_leads enable row level security;

create policy "phase6d_inbound_select_own"
  on public.recruiting_inbound_leads
  for select to authenticated
  using (owner_user_id = auth.uid());

create policy "phase6d_inbound_update_own"
  on public.recruiting_inbound_leads
  for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create function public.submit_recruiting_inquiry(
  p_request_id text,
  p_coach_name text,
  p_coach_email text,
  p_inquiry_type text,
  p_message text,
  p_source_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_owner constant uuid := '47e7c1a9-a806-4f65-b5ed-2b9b124ef337'::uuid;
begin
  if char_length(trim(coalesce(p_request_id,''))) < 8
     or char_length(trim(coalesce(p_request_id,''))) > 80 then
    raise exception 'invalid request id';
  end if;

  if char_length(trim(coalesce(p_coach_name,''))) < 2
     or char_length(trim(coalesce(p_coach_name,''))) > 120 then
    raise exception 'invalid coach name';
  end if;

  if char_length(trim(coalesce(p_coach_email,''))) < 5
     or char_length(trim(coalesce(p_coach_email,''))) > 254
     or position('@' in p_coach_email) < 2 then
    raise exception 'invalid coach email';
  end if;

  if char_length(trim(coalesce(p_inquiry_type,''))) < 2
     or char_length(trim(coalesce(p_inquiry_type,''))) > 100 then
    raise exception 'invalid inquiry type';
  end if;

  if char_length(trim(coalesce(p_message,''))) < 5
     or char_length(trim(coalesce(p_message,''))) > 5000 then
    raise exception 'invalid message';
  end if;

  insert into public.recruiting_inbound_leads (
    owner_user_id,
    request_id,
    coach_name,
    coach_email,
    inquiry_type,
    message_body,
    source_url
  )
  values (
    v_owner,
    trim(p_request_id),
    trim(p_coach_name),
    lower(trim(p_coach_email)),
    trim(p_inquiry_type),
    trim(p_message),
    nullif(trim(coalesce(p_source_url,'')), '')
  )
  on conflict (owner_user_id, request_id)
  do update set
    coach_name = excluded.coach_name,
    coach_email = excluded.coach_email,
    inquiry_type = excluded.inquiry_type,
    message_body = excluded.message_body,
    source_url = excluded.source_url
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_recruiting_inquiry(text,text,text,text,text,text) from public;
grant execute on function public.submit_recruiting_inquiry(text,text,text,text,text,text) to anon, authenticated;
