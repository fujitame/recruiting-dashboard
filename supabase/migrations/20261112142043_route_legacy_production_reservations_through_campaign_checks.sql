CREATE OR REPLACE FUNCTION public.schedule_recruiting_followup_batch(p_local_date date, p_local_time time without time zone, p_items jsonb, p_mode text DEFAULT 'test'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid:=auth.uid(); v_batch uuid; v_item jsonb; v_contact public.recruiting_contacts%rowtype;
  v_contact_id uuid; v_at timestamptz; v_zone text; v_sentence text; v_ids integer[]; v_inserted integer:=0; v_recipient text; v_thread text; v_prefix text;
begin
  if p_mode='production' then raise exception '今回の送信予約は活動状況・送信準備から行ってください。';end if;
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
end $function$

;
revoke insert,update,delete on public.recruiting_followup_batch_items from authenticated;
create or replace function public.stop_campaign_outreach_on_reply()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid; v_school integer; v_email text; v_match record;
begin
 v_owner:=new.owner_user_id;
 if tg_table_name<>'recruiting_inbound_leads' and auth.uid() is not null and auth.uid()<>v_owner then raise exception 'Owner mismatch' using errcode='42501'; end if;
 if tg_table_name='recruiting_contacts' then
  if new.contact_status='responded' or length(btrim(coalesce(new.coach_response,'')))>0 then v_school:=new.university_id;
  elsif new.contact_status in ('closed','not_a_fit') then v_school:=new.university_id;v_email:=lower(btrim(coalesce(new.coach_email,'')));
  else return new; end if;
 elsif tg_table_name='recruiting_contact_history' then
  if new.event_type<>'reply_received' then return new; end if;
  select university_id into v_school from public.recruiting_contacts where id=new.contact_id and owner_user_id=v_owner;
 elsif tg_table_name='recruiting_campaign_schools' then
  if new.reply_status not in ('received','review') and new.progress='unknown' then return new; end if;v_school:=new.university_id;
 elsif tg_table_name='recruiting_inbound_leads' then
  for v_match in select distinct university_id from public.recruiting_contacts where owner_user_id=v_owner and (id=new.linked_contact_id or (new.lead_status<>'dismissed' and btrim(coalesce(coach_email,''))<>'' and lower(btrim(coach_email))=lower(btrim(new.coach_email)))) loop
   update public.recruiting_campaign_deliveries set status=case status when 'scheduled' then 'cancelled' else status end,cancel_requested=true,error_message='School inquiry received; bulk outreach stopped',updated_at=now() where owner_user_id=v_owner and university_id=v_match.university_id and status in ('scheduled','processing');
  end loop;return new;
 end if;
 if v_school is not null then
  if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=v_owner and c.university_id=v_school and (c.contact_status='responded' or length(btrim(coalesce(c.coach_response,'')))>0 or exists(select 1 from public.recruiting_contact_history h where h.owner_user_id=v_owner and h.contact_id=c.id and h.event_type='reply_received')))
    or exists(select 1 from public.recruiting_campaign_schools s where s.owner_user_id=v_owner and s.university_id=v_school and s.reply_status='received') then
   update public.recruiting_campaign_issues set status='resolved',updated_at=now() where owner_user_id=v_owner and university_id=v_school and kind='reply_attribution' and status='open';
  end if;
  update public.recruiting_campaign_deliveries set status=case status when 'scheduled' then 'cancelled' else status end,cancel_requested=true,error_message='School reply or exclusion recorded; bulk outreach stopped',updated_at=now() where owner_user_id=v_owner and university_id=v_school and (v_email is null or recipient_email=v_email) and status in ('scheduled','processing');
 end if;
 return new;
end $$;
