-- Stage 1: test-only Follow-up batch scheduling.
-- Only schools 900-902 marked is_test=true are accepted. Every scheduled email
-- is sent to the fixed self-test inbox; production schools are not eligible.
create table if not exists public.recruiting_followup_batches (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'test' check (mode = 'test'),
  status text not null default 'scheduled' check (status in ('scheduled','complete','partial','cancelled')),
  local_date date not null,
  local_time time not null,
  item_count integer not null check (item_count between 1 and 3),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null default now()
);
create table if not exists public.recruiting_followup_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recruiting_followup_batches(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.recruiting_contacts(id) on delete cascade,
  university_id integer not null check (university_id between 900 and 902),
  expected_follow_up_count integer not null check (expected_follow_up_count = 0),
  recipient_email text not null default 'fujitame@gmail.com' check (lower(trim(recipient_email)) = 'fujitame@gmail.com'),
  subject text not null check (char_length(trim(subject)) between 1 and 180),
  body text not null check (char_length(trim(body)) between 1 and 10000),
  personalization_sentence text not null check (char_length(trim(personalization_sentence)) between 1 and 1000),
  research_ids integer[] not null check (cardinality(research_ids) > 0),
  school_timezone text not null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','processing','sent','skipped_changed','send_unknown','cancelled')),
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  sent_at timestamptz,
  gmail_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists recruiting_followup_batch_items_due_idx
  on public.recruiting_followup_batch_items(scheduled_at) where status='scheduled';
create index if not exists recruiting_followup_batch_items_batch_idx
  on public.recruiting_followup_batch_items(batch_id,status);
create unique index if not exists recruiting_followup_batch_contact_pending_unique
  on public.recruiting_followup_batch_items(contact_id)
  where status in ('scheduled','processing','send_unknown');

alter table public.recruiting_followup_batches enable row level security;
alter table public.recruiting_followup_batch_items enable row level security;
drop policy if exists recruiting_followup_batches_select_own on public.recruiting_followup_batches;
create policy recruiting_followup_batches_select_own on public.recruiting_followup_batches
  for select to authenticated using (owner_user_id=auth.uid());
drop policy if exists recruiting_followup_items_select_own on public.recruiting_followup_batch_items;
create policy recruiting_followup_items_select_own on public.recruiting_followup_batch_items
  for select to authenticated using (owner_user_id=auth.uid());

create or replace function public.schedule_recruiting_followup_batch(p_local_date date,p_local_time time,p_items jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_owner uuid:=auth.uid(); v_batch uuid; v_item jsonb; v_contact public.recruiting_contacts%rowtype;
  v_contact_id uuid; v_at timestamptz; v_zone text; v_sentence text; v_ids integer[]; v_inserted integer:=0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_local_date is null or p_local_time is null then raise exception 'Local date and time required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>3 then
    raise exception 'Choose 1 to 3 test contacts';
  end if;
  insert into public.recruiting_followup_batches(owner_user_id,mode,local_date,local_time,item_count)
    values(v_owner,'test',p_local_date,p_local_time,jsonb_array_length(p_items)) returning id into v_batch;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_contact_id:=(v_item->>'contact_id')::uuid;
    v_at:=(v_item->>'scheduled_at')::timestamptz;
    v_zone:=trim(v_item->>'school_timezone');
    v_sentence:=trim(v_item->>'personalization_sentence');
    select array_agg(x::integer) into v_ids
      from jsonb_array_elements_text(coalesce(v_item->'research_ids','[]'::jsonb)) x
      where x ~ '^[0-9]+$';
    if v_at is null or v_at<=now()+interval '2 minutes' then raise exception 'Choose a test send time at least 2 minutes ahead'; end if;
    if v_zone is null or not exists(select 1 from pg_timezone_names where name=v_zone) then raise exception 'Invalid test-school time zone'; end if;
    if (v_at at time zone v_zone)::date<>p_local_date or to_char(v_at at time zone v_zone,'HH24:MI')<>to_char(p_local_time,'HH24:MI') then
      raise exception 'Scheduled instant does not match test-school local time';
    end if;
    if v_sentence is null or v_sentence='' or coalesce(cardinality(v_ids),0)=0 or position(v_sentence in coalesce(v_item->>'body',''))=0 then
      raise exception 'Each test email must retain its verified school-specific Research sentence';
    end if;
    if length(trim(v_item->>'subject'))>180 or length(trim(v_item->>'body'))>10000 then raise exception 'Subject or body too long'; end if;

    select * into v_contact from public.recruiting_contacts
      where id=v_contact_id and owner_user_id=v_owner for update;
    if not found then raise exception 'Test CRM contact unavailable'; end if;
    if v_contact.university_id not between 900 and 902 or not exists(
      select 1 from public.recruiting_universities u where u.id=v_contact.university_id and u.is_test=true
    ) then raise exception 'Only TEST schools 900, 901, and 902 are enabled in this stage'; end if;
    if v_contact.contact_status='responded' or nullif(trim(coalesce(v_contact.coach_response,'')),'') is not null
      or v_contact.follow_up_count <> 0 then raise exception 'Test contact is not eligible for Follow-up'; end if;

    insert into public.recruiting_followup_batch_items(
      batch_id,owner_user_id,contact_id,university_id,expected_follow_up_count,recipient_email,
      subject,body,personalization_sentence,research_ids,school_timezone,scheduled_at
    ) values(
      v_batch,v_owner,v_contact.id,v_contact.university_id,v_contact.follow_up_count,'fujitame@gmail.com',
      trim(v_item->>'subject'),v_item->>'body',v_sentence,v_ids,v_zone,v_at
    );
    update public.recruiting_contacts set auto_follow_up_enabled=false,
      next_action='TEST MODE: Follow-up一括予約済み — '||p_local_date::text||' '||to_char(p_local_time,'HH24:MI')||' ('||v_zone||')'
      where id=v_contact.id and owner_user_id=v_owner;
    insert into public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,note)
      values(v_owner,v_contact.id,'follow_up_set',now(),'TEST MODE: self-test inboxへのFollow-up予約');
    v_inserted:=v_inserted+1;
  end loop;
  if v_inserted<>jsonb_array_length(p_items) then raise exception 'Not all test contacts were scheduled'; end if;
  return v_batch;
end $$;
revoke all on function public.schedule_recruiting_followup_batch(date,time,jsonb) from public,anon;
grant execute on function public.schedule_recruiting_followup_batch(date,time,jsonb) to authenticated;

create or replace function public.claim_due_recruiting_followup_batch_items(p_limit integer default 10)
returns setof public.recruiting_followup_batch_items language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  update public.recruiting_followup_batch_items set status='send_unknown',error_message='Worker timed out; verify test inbox manually'
    where status='processing' and processing_started_at<now()-interval '15 minutes';
  update public.recruiting_followup_batches b
    set status=case when not exists(select 1 from public.recruiting_followup_batch_items i
      where i.batch_id=b.id and i.status not in ('sent','cancelled')) then 'complete' else 'partial' end
    where b.status='scheduled'
      and not exists(select 1 from public.recruiting_followup_batch_items i
        where i.batch_id=b.id and i.status in ('scheduled','processing'));
  return query
  with due as (
    select i.id from public.recruiting_followup_batch_items i
    join public.recruiting_followup_batches b on b.id=i.batch_id
    where i.status='scheduled' and i.scheduled_at<=now() and b.status='scheduled' and b.mode='test'
    order by i.scheduled_at,i.created_at for update of i skip locked limit greatest(1,least(coalesce(p_limit,10),10))
  )
  update public.recruiting_followup_batch_items i set status='processing',processing_started_at=now(),attempt_count=attempt_count+1
    from due where i.id=due.id returning i.*;
end $$;
revoke all on function public.claim_due_recruiting_followup_batch_items(integer) from public,anon,authenticated;
grant execute on function public.claim_due_recruiting_followup_batch_items(integer) to service_role;

create or replace function public.cancel_recruiting_followup_batch(p_batch_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_owner uuid:=auth.uid(); v_count integer; v_contact record;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.recruiting_followup_batches where id=p_batch_id and owner_user_id=v_owner and status='scheduled') then
    raise exception 'Batch is not cancellable';
  end if;
  for v_contact in select c.id from public.recruiting_followup_batch_items i join public.recruiting_contacts c on c.id=i.contact_id
    where i.batch_id=p_batch_id and i.owner_user_id=v_owner and i.status='scheduled' for update of c
  loop
    update public.recruiting_contacts set next_action='TEST MODE: Follow-up予約を取消 — 内容を再確認' where id=v_contact.id and owner_user_id=v_owner;
    insert into public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,note)
      values(v_owner,v_contact.id,'follow_up_set',now(),'TEST MODE: Follow-up予約を取消');
  end loop;
  update public.recruiting_followup_batch_items set status='cancelled' where batch_id=p_batch_id and owner_user_id=v_owner and status='scheduled';
  get diagnostics v_count=row_count;
  update public.recruiting_followup_batches set status='cancelled' where id=p_batch_id and owner_user_id=v_owner;
  return v_count;
end $$;
revoke all on function public.cancel_recruiting_followup_batch(uuid) from public,anon;
grant execute on function public.cancel_recruiting_followup_batch(uuid) to authenticated;
grant select on public.recruiting_followup_batches,public.recruiting_followup_batch_items to authenticated;
grant all on public.recruiting_followup_batches,public.recruiting_followup_batch_items to service_role;
