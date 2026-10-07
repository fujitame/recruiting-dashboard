-- Test-only bulk Follow-up #1 and #2; replies remain individual CRM work.
alter table public.recruiting_followup_batch_items drop constraint recruiting_followup_batch_items_expected_follow_up_count_check;
alter table public.recruiting_followup_batch_items add constraint recruiting_followup_batch_items_expected_follow_up_count_check check (expected_follow_up_count in (0,1));
create or replace function public.schedule_recruiting_followup_batch(p_local_date date,p_local_time time,p_items jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_owner uuid:=auth.uid(); v_batch uuid; v_item jsonb; v_contact public.recruiting_contacts%rowtype;
  v_contact_id uuid; v_at timestamptz; v_zone text; v_sentence text; v_ids integer[]; v_inserted integer:=0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_local_date is null or p_local_time is null then raise exception 'Local date and time required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>6 then
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
    values(v_owner,'test',p_local_date,p_local_time,jsonb_array_length(p_items)) returning id into v_batch;
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
    if left(coalesce(v_item->>'body',''),60)<>'TEST MODE — This message is sent only to fujitame@gmail.com.'
      or not ((v_sentence='' and cardinality(v_ids)=0) or (v_sentence<>'' and cardinality(v_ids)=1))
      or position(v_sentence in coalesce(v_item->>'body',''))=0 then
      raise exception 'Test emails must retain the TEST banner and any verified Research sentence';
    end if;
    if length(trim(v_item->>'subject'))>180 or length(trim(v_item->>'body'))>10000 then raise exception 'Subject or body too long'; end if;

    select * into v_contact from public.recruiting_contacts
      where id=v_contact_id and owner_user_id=v_owner for update;
    if not found then raise exception 'Test CRM contact unavailable'; end if;
    if v_contact.university_id not between 900 and 902 or not exists(
      select 1 from public.recruiting_universities u where u.id=v_contact.university_id and u.is_test=true
    ) then raise exception 'Only TEST schools 900, 901, and 902 are enabled in this stage'; end if;
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
    if not starts_with(coalesce(v_item->>'subject',''),'[TEST] Follow-up #'||(v_contact.follow_up_count+1)::text||' — ') then raise exception 'Follow-up subject does not match contact state'; end if;
    insert into public.recruiting_followup_batch_items(
      batch_id,owner_user_id,contact_id,university_id,expected_follow_up_count,recipient_email,
      subject,body,personalization_sentence,research_ids,school_timezone,scheduled_at
    ) values(
      v_batch,v_owner,v_contact.id,v_contact.university_id,v_contact.follow_up_count,'fujitame@gmail.com',
      trim(v_item->>'subject'),v_item->>'body',v_sentence,v_ids,v_zone,v_at
    );
    update public.recruiting_contacts set auto_follow_up_enabled=false,
      next_action='TEST MODE: Follow-up #'||(v_contact.follow_up_count+1)::text||'一括予約済み — '||p_local_date::text||' '||to_char(p_local_time,'HH24:MI')||' ('||v_zone||')'
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
