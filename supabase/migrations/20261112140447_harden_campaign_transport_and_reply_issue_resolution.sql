create or replace function public.schedule_recruiting_campaign(p_owner_id uuid,p_campaign_id uuid,p_stage text,p_groups jsonb)
returns setof public.recruiting_campaign_deliveries language plpgsql security invoker set search_path=public,pg_temp as $$
declare input jsonb; g jsonb; snapshot jsonb; ids uuid[];
begin
 perform 1 from public.recruiting_campaigns where id=p_campaign_id and owner_user_id=p_owner_id for update;
 if not found then raise exception 'Campaign unavailable'; end if;
 if not exists(select 1 from public.recruiting_campaign_execution where campaign_id=p_campaign_id and owner_user_id=p_owner_id and enabled and schedule_confirmed_at is not null and content_confirmed_at is not null) then raise exception 'Dates and content must be approved before activation'; end if;
 if jsonb_typeof(p_groups)<>'array' or jsonb_array_length(p_groups)=0 then raise exception 'No recipients selected'; end if;
 snapshot:=public.recruiting_campaign_preflight(p_campaign_id,p_stage,p_owner_id);
 for input in select * from jsonb_array_elements(p_groups) loop
  select x into g from jsonb_array_elements(snapshot->'groups') x where x->>'source_key'=input->>'source_key';
  if g is null or not(g->>'ready')::boolean then raise exception 'Recipient, draft, or eligibility changed; preview again'; end if;
  if not exists(select 1 from pg_timezone_names where name=input->>'school_timezone') then raise exception 'School timezone unavailable'; end if;
  if (g#>>'{drafts,0,planned_at}')::timestamptz<=now()+interval '2 minutes' then raise exception 'Choose a date at least two minutes in the future';end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(g->'contact_ids');
  return query insert into public.recruiting_campaign_deliveries(campaign_id,owner_user_id,university_id,stage,recipient_email,contact_ids,subject,body,scheduled_at,school_timezone,predecessor_id,source_key)
  values(p_campaign_id,p_owner_id,(g->>'university_id')::integer,p_stage,g->>'recipient_email',ids,g#>>'{drafts,0,subject}',g#>>'{drafts,0,body}',(g#>>'{drafts,0,planned_at}')::timestamptz,input->>'school_timezone',(g->>'predecessor_id')::uuid,g->>'source_key') returning *;
 end loop;
end $$;

create or replace function public.claim_recruiting_campaign_delivery()
returns setof public.recruiting_campaign_deliveries language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.recruiting_campaign_deliveries;
begin
 -- A transport attempt is never automatically retried, including a crashed request.
 update public.recruiting_campaign_deliveries set status=case when cancel_requested and transport_started_at is null then 'cancelled' when transport_started_at is null then 'held' else 'send_unknown' end,error_message='Worker interrupted; reconcile before resuming',updated_at=now() where status='processing' and processing_started_at<now()-interval '10 minutes';
 insert into public.recruiting_campaign_issues(owner_user_id,campaign_id,university_id,contact_ids,issue_key,kind,delivery_id,details)
 select owner_user_id,campaign_id,university_id,contact_ids,'delivery:'||id,case status when 'send_unknown' then 'send_unknown' else 'delivery_held' end,id,error_message from public.recruiting_campaign_deliveries where status in ('held','send_unknown')
 on conflict(owner_user_id,issue_key) do nothing;
 select q.* into d from public.recruiting_campaign_deliveries q join public.recruiting_campaign_execution e using(campaign_id,owner_user_id) where q.status='scheduled' and not q.cancel_requested and q.scheduled_at<=now() and e.enabled and e.schedule_confirmed_at is not null and e.content_confirmed_at is not null order by q.scheduled_at for update of q skip locked limit 1;
 if d.id is null then return; end if;
 return query update public.recruiting_campaign_deliveries set status='processing',processing_started_at=now(),updated_at=now() where id=d.id returning *;
end $$;

create or replace function public.permit_recruiting_campaign_transport(p_delivery_id uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.recruiting_campaign_deliveries; v jsonb; g jsonb;
begin
 select * into d from public.recruiting_campaign_deliveries where id=p_delivery_id for update;
 if d.id is null or d.status<>'processing' or d.cancel_requested or d.transport_started_at is not null or d.scheduled_at>now() then return false; end if;
 if not exists(select 1 from public.recruiting_campaign_execution where campaign_id=d.campaign_id and owner_user_id=d.owner_user_id and enabled and schedule_confirmed_at is not null and content_confirmed_at is not null) then return false; end if;
 v:=public.recruiting_campaign_preflight(d.campaign_id,d.stage,d.owner_user_id,d.id);
 select x into g from jsonb_array_elements(v->'groups') x where x->>'source_key'=d.source_key;
 -- Scheduled dates are necessarily due now, so date_past alone is expected here.
 if g is null or jsonb_array_length(g->'audience_reasons')>0 or exists(select 1 from jsonb_array_elements_text(g->'send_reasons') r where r<>'date_past') then return false; end if;
 update public.recruiting_campaign_deliveries set transport_started_at=now(),updated_at=now() where id=d.id;
 return true;
end $$;

create or replace function public.finalize_recruiting_campaign_delivery(p_delivery_id uuid,p_gmail_message_id text,p_gmail_thread_id text,p_sent_at timestamptz)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.recruiting_campaign_deliveries; c public.recruiting_contacts;
begin
 select * into d from public.recruiting_campaign_deliveries where id=p_delivery_id for update;
 if d.status='sent' then return d.gmail_message_id=p_gmail_message_id; end if;
 if d.id is null or d.status not in ('processing','send_unknown') or d.transport_started_at is null or d.tracking_id is null or length(coalesce(p_gmail_message_id,''))=0 or length(coalesce(p_gmail_thread_id,''))=0 then raise exception 'Unverified campaign delivery'; end if;
 update public.recruiting_campaign_deliveries set status='sent',gmail_message_id=p_gmail_message_id,gmail_thread_id=p_gmail_thread_id,sent_at=p_sent_at,error_message=null,updated_at=now() where id=d.id;
 update public.recruiting_email_tracking set status='sent',gmail_message_id=p_gmail_message_id,sent_at=p_sent_at where id=d.tracking_id and campaign_delivery_id=d.id and owner_user_id=d.owner_user_id;
 if not found then raise exception 'Tracking delivery mismatch'; end if;
 for c in select * from public.recruiting_contacts where id=any(d.contact_ids) and owner_user_id=d.owner_user_id for update loop
  update public.recruiting_campaign_messages set tracking_id=d.tracking_id where campaign_id=d.campaign_id and owner_user_id=d.owner_user_id and contact_id=c.id and stage=d.stage;
  update public.recruiting_contacts set contact_count=coalesce(contact_count,0)+1,
   contact_status=case when contact_status in ('responded','closed','not_a_fit') or last_contact_at>p_sent_at or length(btrim(coalesce(coach_response,'')))>0 then contact_status else case d.stage when 'follow_up_2' then 'no_response' else 'contacted' end end,
   gmail_thread_id=case when last_contact_at>p_sent_at then gmail_thread_id else p_gmail_thread_id end,
   last_contact_at=greatest(last_contact_at,p_sent_at),updated_at=now() where id=c.id;
  insert into public.recruiting_contact_history(contact_id,owner_user_id,event_type,event_at,note,gmail_message_id,gmail_message_at) values(c.id,d.owner_user_id,case d.stage when 'initial' then 'contact_logged' else 'follow_up_sent' end,p_sent_at,'Campaign '||d.campaign_id||' / '||d.stage||' / delivery '||d.id,p_gmail_message_id,p_sent_at);
 end loop;
 insert into public.recruiting_campaign_label_tasks(delivery_id,owner_user_id) values(d.id,d.owner_user_id) on conflict(delivery_id) do update set status='pending',next_attempt_at=now(),updated_at=now();
 update public.recruiting_campaign_issues set status='resolved',updated_at=now() where owner_user_id=d.owner_user_id and issue_key='delivery:'||d.id;
 return true;
end $$;

create or replace function public.stop_campaign_outreach_on_reply()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid; v_school integer; v_email text; c record;
begin
 v_owner:=new.owner_user_id;
 if auth.uid() is not null and auth.uid()<>v_owner then raise exception 'Owner mismatch' using errcode='42501'; end if;
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
  for c in select distinct university_id from public.recruiting_contacts where owner_user_id=v_owner and (id=new.linked_contact_id or (new.lead_status<>'dismissed' and btrim(coalesce(coach_email,''))<>'' and lower(btrim(coach_email))=lower(btrim(new.coach_email)))) loop
   update public.recruiting_campaign_deliveries set status=case status when 'scheduled' then 'cancelled' else status end,cancel_requested=true,error_message='School inquiry received; bulk outreach stopped',updated_at=now() where owner_user_id=v_owner and university_id=c.university_id and status in ('scheduled','processing');
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

create or replace function public.protect_campaign_tracking_pointer()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.campaign_delivery_id is not null then
  if coalesce(auth.role(),'')<>'service_role' and current_user<>'postgres' then raise exception 'Campaign tracking is server managed'; end if;
  if not exists(select 1 from public.recruiting_campaign_deliveries d where d.id=new.campaign_delivery_id and d.owner_user_id=new.owner_user_id and d.university_id=new.university_id and d.stage=new.stage and new.contact_id=any(d.contact_ids) and d.recipient_email=lower(btrim(new.recipient_email))) then raise exception 'Campaign tracking mismatch'; end if;
 end if;
 if tg_op='UPDATE' and old.campaign_delivery_id is not null and new.campaign_delivery_id is distinct from old.campaign_delivery_id then raise exception 'Campaign tracking pointer is immutable'; end if;
 return new;
end $$;

insert into public.recruiting_campaign_execution(campaign_id,owner_user_id) select id,owner_user_id from public.recruiting_campaigns where campaign_key='fall2027_reapproach_202611' on conflict(campaign_id) do nothing;

