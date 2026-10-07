-- Separate Test and production reservations. Existing test data retains fixed routing.
alter table public.recruiting_followup_batches drop constraint recruiting_followup_batches_mode_check;
alter table public.recruiting_followup_batches add constraint recruiting_followup_batches_mode_check check (mode in ('test','production'));
alter table public.recruiting_followup_batches drop constraint recruiting_followup_batches_item_count_check;
alter table public.recruiting_followup_batches add constraint recruiting_followup_batches_item_count_check check (item_count between 1 and 250 and (mode<>'test' or item_count<=6));
alter table public.recruiting_followup_batch_items add column mode text not null default 'test';
alter table public.recruiting_followup_batch_items add column gmail_thread_id text;
alter table public.recruiting_followup_batch_items add column previous_next_action text;
alter table public.recruiting_followup_batch_items add column previous_auto_follow_up_enabled boolean;
alter table public.recruiting_followup_batch_items drop constraint recruiting_followup_batch_items_university_id_check;
alter table public.recruiting_followup_batch_items drop constraint recruiting_followup_batch_items_recipient_email_check;
alter table public.recruiting_followup_batch_items drop constraint recruiting_followup_batch_items_body_check1;
alter table public.recruiting_followup_batch_items add constraint recruiting_followup_items_mode_routing_check check (
 (mode='test' and university_id between 900 and 902 and recipient_email='fujitame@gmail.com' and left(body,60)='TEST MODE — This message is sent only to fujitame@gmail.com.') or
 (mode='production' and university_id between 1 and 900 and nullif(trim(gmail_thread_id),'') is not null and recipient_email ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' and body not like 'TEST MODE%' and subject not like '[TEST]%')
);
drop function public.schedule_recruiting_followup_batch(date,time,jsonb);
create or replace function public.schedule_recruiting_followup_batch(p_local_date date,p_local_time time,p_items jsonb,p_mode text default 'test')
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_owner uuid:=auth.uid(); v_batch uuid; v_item jsonb; v_contact public.recruiting_contacts%rowtype;
  v_contact_id uuid; v_at timestamptz; v_zone text; v_sentence text; v_ids integer[]; v_inserted integer:=0; v_recipient text; v_thread text; v_prefix text;
begin
  if p_mode not in ('test','production') or p_mode is null then raise exception 'Invalid reservation mode'; end if;
  v_prefix:=case when p_mode='test' then 'TEST MODE: ' else '' end;
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_local_date is null or p_local_time is null then raise exception 'Local date and time required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>(case when p_mode='test' then 6 else 250 end) then
    raise exception 'Choose 1 to 6 test contacts';
  end if;
  -- Lock all sibling contacts in a stable order while checking school-wide replies.
  perform c.id from public.recruiting_contacts c
    where c.owner_user_id=v_owner and c.university_id in (
      select selected.university_id from public.recruiting_contacts selected
      where selected.owner_user_id=v_owner and selected.id in (
        select (value->>'contact_id')::uuid from jsonb_array_elements(p_items)
      )
    ) order by c.university_id,c.id for update;
  insert into public.recruiting_followup_batches(owner_user_id,mode,local_date,local_time,item_count)
    values(v_owner,p_mode,p_local_date,p_local_time,jsonb_array_length(p_items)) returning id into v_batch;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_contact_id:=(v_item->>'contact_id')::uuid;
    v_at:=(v_item->>'scheduled_at')::timestamptz;
    v_zone:=trim(v_item->>'school_timezone');
    v_sentence:=trim(coalesce(v_item->>'personalization_sentence',''));
    select array_agg(x::integer) into v_ids
      from jsonb_array_elements_text(coalesce(v_item->'research_ids','[]'::jsonb)) x
      where x ~ '^[0-9]+$';
    v_ids:=coalesce(v_ids,'{}'::integer[]);
    if v_at is null or v_at<=now()+interval '2 minutes' then raise exception 'Choose a test send time at least 2 minutes ahead'; end if;
    if v_zone is null or not exists(select 1 from pg_timezone_names where name=v_zone) then raise exception 'Invalid test-school time zone'; end if;
    if (v_at at time zone v_zone)::date<>p_local_date or to_char(v_at at time zone v_zone,'HH24:MI')<>to_char(p_local_time,'HH24:MI') then
      raise exception 'Scheduled instant does not match test-school local time';
    end if;
    if (p_mode='test' and left(coalesce(v_item->>'body',''),60)<>'TEST MODE — This message is sent only to fujitame@gmail.com.')
      or (p_mode='production' and (v_item->>'body' like 'TEST MODE%' or v_item->>'subject' like '[TEST]%'))
      or not ((v_sentence='' and cardinality(v_ids)=0) or (v_sentence<>'' and cardinality(v_ids)=1))
      or position(v_sentence in coalesce(v_item->>'body',''))=0 then
      raise exception 'Test emails must retain the TEST banner and any verified Research sentence';
    end if;
    if length(trim(v_item->>'subject'))>180 or length(trim(v_item->>'body'))>10000 then raise exception 'Subject or body too long'; end if;

    select * into v_contact from public.recruiting_contacts
      where id=v_contact_id and owner_user_id=v_owner for update;
    if not found then raise exception 'Test CRM contact unavailable'; end if;
    if not exists(select 1 from public.recruiting_universities u where u.id=v_contact.university_id and
      ((p_mode='test' and u.is_test=true and u.id between 900 and 902) or
       (p_mode='production' and u.is_test=false and u.id between 1 and 900))) then raise exception 'School does not match reservation mode'; end if;
    v_recipient:=case when p_mode='test' then 'fujitame@gmail.com' else lower(trim(v_contact.coach_email)) end;
    v_thread:=case when p_mode='test' then null else nullif(trim(v_contact.gmail_thread_id),'') end;
    if p_mode='production' and (v_recipient is null or v_recipient !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' or v_thread is null) then raise exception 'Coach email and original thread required'; end if;
    if p_mode='production' and (v_item->>'recipient_email' is distinct from v_recipient or v_item->>'gmail_thread_id' is distinct from v_thread) then raise exception 'Recipient or thread changed; regenerate preview'; end if;
    if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=v_owner and c.university_id=v_contact.university_id
      and (c.contact_status='responded' or nullif(trim(coalesce(c.coach_response,'')),'') is not null)) then
      raise exception 'A coach at this school has replied; school-wide Follow-up is blocked';
    end if;
    if v_contact.coach_role not in ('head_coach','assistant_coach') or v_contact.contact_status not in ('contacted','follow_up_due') or nullif(trim(coalesce(v_contact.coach_response,'')),'') is not null
      or v_contact.follow_up_count not in (0,1) then raise exception 'Test contact is not eligible for Follow-up'; end if;

    if (v_item->>'expected_follow_up_count')::integer is distinct from v_contact.follow_up_count then
      raise exception 'Follow-up state changed; generate the preview again';
    end if;
    if v_contact.follow_up_count=1 and (v_sentence<>'' or cardinality(v_ids)<>0) then raise exception 'Follow-up #2 must not add Research personalization'; end if;
    if p_mode='test' and not starts_with(coalesce(v_item->>'subject',''),'[TEST] Follow-up #'||(v_contact.follow_up_count+1)::text||' — ') then raise exception 'Follow-up subject does not match contact state'; end if;
    if cardinality(v_ids)=1 and not exists(select 1 from public.get_personalization_context_excluding(v_contact.university_id,case when v_contact.coach_role='head_coach' then 'HC' else 'AC' end,coalesce(v_contact.coach_name,''),
      coalesce((select array_agg(distinct x) from public.recruiting_contact_history h cross join unnest(h.research_ids) x where h.contact_id=v_contact.id),'{}'::bigint[]),2) ctx where ctx.research_id=v_ids[1]) then raise exception 'Verified Research changed; regenerate preview'; end if;
    insert into public.recruiting_followup_batch_items(
      batch_id,owner_user_id,contact_id,university_id,expected_follow_up_count,recipient_email,
      subject,body,personalization_sentence,research_ids,school_timezone,scheduled_at,mode,gmail_thread_id,previous_next_action,previous_auto_follow_up_enabled
    ) values(
      v_batch,v_owner,v_contact.id,v_contact.university_id,v_contact.follow_up_count,v_recipient,
      trim(v_item->>'subject'),v_item->>'body',v_sentence,v_ids,v_zone,v_at,p_mode,v_thread,v_contact.next_action,v_contact.auto_follow_up_enabled
    );
    update public.recruiting_contacts set auto_follow_up_enabled=false,
      next_action=v_prefix||'Follow-up #'||(v_contact.follow_up_count+1)::text||'送信予約済み — '||p_local_date::text||' '||to_char(p_local_time,'HH24:MI')||' ('||v_zone||')'
      where id=v_contact.id and owner_user_id=v_owner;
    insert into public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,note)
      values(v_owner,v_contact.id,'follow_up_set',now(),v_prefix||'Follow-up #'||(v_contact.follow_up_count+1)::text||'送信予約（宛先: '||v_recipient||'）');
    v_inserted:=v_inserted+1;
  end loop;
  if v_inserted<>jsonb_array_length(p_items) then raise exception 'Not all test contacts were scheduled'; end if;
  return v_batch;
end $$;
revoke all on function public.schedule_recruiting_followup_batch(date,time,jsonb,text) from public,anon;
grant execute on function public.schedule_recruiting_followup_batch(date,time,jsonb,text) to authenticated;

create or replace function public.claim_due_recruiting_followup_batch_items(p_limit integer default 10)
returns setof public.recruiting_followup_batch_items language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  update public.recruiting_followup_batch_items set status='send_unknown',error_message='Worker timed out; verify Gmail manually'
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
    where i.status='scheduled' and i.scheduled_at<=now() and b.status='scheduled' and b.mode in ('test','production') and i.mode=b.mode
    order by i.scheduled_at,i.created_at for update of i skip locked limit greatest(1,least(coalesce(p_limit,10),10))
  )
  update public.recruiting_followup_batch_items i set status='processing',processing_started_at=now(),attempt_count=attempt_count+1
    from due where i.id=due.id returning i.*;
end $$;
revoke all on function public.claim_due_recruiting_followup_batch_items(integer) from public,anon,authenticated;
grant execute on function public.claim_due_recruiting_followup_batch_items(integer) to service_role;


-- Cancellation only restores contacts whose reservation is still waiting, never processing/sent rows.
create or replace function public.cancel_recruiting_followup_batch(p_batch_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_owner uuid:=auth.uid(); v_count integer; v_item record; v_batch public.recruiting_followup_batches%rowtype;
begin
 if v_owner is null then raise exception 'Authentication required'; end if;
 select * into v_batch from public.recruiting_followup_batches where id=p_batch_id and owner_user_id=v_owner for update;
 if not found or v_batch.status<>'scheduled' then raise exception 'Batch is not cancellable'; end if;
 for v_item in select i.* from public.recruiting_followup_batch_items i where i.batch_id=p_batch_id and i.owner_user_id=v_owner and i.status='scheduled' order by i.contact_id for update loop
  update public.recruiting_contacts set next_action=v_item.previous_next_action,auto_follow_up_enabled=coalesce(v_item.previous_auto_follow_up_enabled,false)
    where id=v_item.contact_id and owner_user_id=v_owner and next_action like '%送信予約済み%' and follow_up_count=v_item.expected_follow_up_count;
  insert into public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,note) values(v_owner,v_item.contact_id,'follow_up_set',now(),case when v_batch.mode='test' then 'TEST MODE: ' else '' end||'Follow-up送信予約を取消');
  update public.recruiting_followup_batch_items set status='cancelled' where id=v_item.id;
 end loop;
 select count(*) into v_count from public.recruiting_followup_batch_items where batch_id=p_batch_id and status='cancelled';
 if not exists(select 1 from public.recruiting_followup_batch_items where batch_id=p_batch_id and status='processing') then
  update public.recruiting_followup_batches set status=case when exists(select 1 from public.recruiting_followup_batch_items where batch_id=p_batch_id and status not in ('cancelled')) then 'partial' else 'cancelled' end where id=p_batch_id;
 end if;
 return v_count;
end $$;
revoke all on function public.cancel_recruiting_followup_batch(uuid) from public,anon;
grant execute on function public.cancel_recruiting_followup_batch(uuid) to authenticated;
