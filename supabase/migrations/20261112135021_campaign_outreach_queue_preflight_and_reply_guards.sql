-- Additive campaign queue. Existing lifetime counters and legacy workers are preserved.
create table public.recruiting_campaign_execution (
 campaign_id uuid primary key references public.recruiting_campaigns(id),
 owner_user_id uuid not null references auth.users(id),
 enabled boolean not null default false,
 schedule_confirmed_at timestamptz,
 content_confirmed_at timestamptz,
 updated_at timestamptz not null default now(),
 check(not enabled or (schedule_confirmed_at is not null and content_confirmed_at is not null))
);
create table public.recruiting_campaign_deliveries (
 id uuid primary key default gen_random_uuid(),
 campaign_id uuid not null references public.recruiting_campaigns(id),
 owner_user_id uuid not null references auth.users(id),
 university_id integer not null references public.recruiting_universities(id),
 stage text not null check(stage in ('initial','follow_up_1','follow_up_2')),
 recipient_email text not null check(recipient_email=lower(btrim(recipient_email)) and recipient_email !~ '[\r\n]'),
 contact_ids uuid[] not null check(cardinality(contact_ids)>0),
 subject text not null check(length(btrim(subject)) between 1 and 180 and subject !~ '[\r\n]'),
 body text not null check(length(btrim(body))>0),
 scheduled_at timestamptz not null,
 school_timezone text not null,
 predecessor_id uuid references public.recruiting_campaign_deliveries(id),
 source_key text not null,
 status text not null default 'scheduled' check(status in ('scheduled','processing','sent','held','send_unknown','cancelled')),
 cancel_requested boolean not null default false,
 transport_started_at timestamptz,
 processing_started_at timestamptz,
 tracking_id uuid references public.recruiting_email_tracking(id),
 transport_body text,
 gmail_message_id text,
 gmail_thread_id text,
 sent_at timestamptz,
 error_message text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index campaign_delivery_recipient_stage on public.recruiting_campaign_deliveries(campaign_id,university_id,recipient_email,stage) where status<>'cancelled';
create index campaign_delivery_due on public.recruiting_campaign_deliveries(scheduled_at) where status='scheduled';
create index campaign_delivery_thread on public.recruiting_campaign_deliveries(owner_user_id,gmail_thread_id) where gmail_thread_id is not null;
alter table public.recruiting_email_tracking add column campaign_delivery_id uuid references public.recruiting_campaign_deliveries(id);
create unique index tracking_campaign_delivery on public.recruiting_email_tracking(campaign_delivery_id) where campaign_delivery_id is not null;
create table public.recruiting_campaign_issues (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id),
 campaign_id uuid references public.recruiting_campaigns(id),
 university_id integer references public.recruiting_universities(id),
 contact_ids uuid[] not null default '{}',
 issue_key text not null,
 kind text not null check(kind in ('delivery_held','send_unknown','reply_attribution','label_sync')),
 blocking boolean not null default true,
 status text not null default 'open' check(status in ('open','resolved')),
 delivery_id uuid references public.recruiting_campaign_deliveries(id),
 gmail_thread_id text,
 details text not null,
 attempts integer not null default 0,
 updated_at timestamptz not null default now(),
 unique(owner_user_id,issue_key)
);
create table public.recruiting_campaign_label_tasks (
 delivery_id uuid primary key references public.recruiting_campaign_deliveries(id),
 owner_user_id uuid not null references auth.users(id),
 status text not null default 'pending' check(status in ('pending','processing','done','failed')),
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 error_message text,
 updated_at timestamptz not null default now()
);
do $$ declare t text; begin
 foreach t in array array['recruiting_campaign_execution','recruiting_campaign_deliveries','recruiting_campaign_issues','recruiting_campaign_label_tasks'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy campaign_read_owner on public.%I for select to authenticated using(owner_user_id=(select auth.uid()))',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

-- One server-side source of eligibility for preview, scheduling, and the last send gate.
create function public.recruiting_campaign_preflight(p_campaign_id uuid,p_stage text,p_owner_id uuid default auth.uid(),p_ignore_delivery uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare p public.recruiting_campaigns; g record; c record; v jsonb; groups jsonb:='[]';
 audience text[]; reasons text[]; excluded boolean; drafts jsonb; ids uuid[]; predecessor uuid; source_key text;
begin
 if p_owner_id is null or (auth.role()<>'service_role' and p_owner_id is distinct from auth.uid()) then raise exception 'Owner unavailable' using errcode='42501'; end if;
 select * into p from public.recruiting_campaigns where id=p_campaign_id and owner_user_id=p_owner_id;
 if p.id is null then raise exception 'Campaign unavailable' using errcode='42501'; end if;
 if p_stage not in ('initial','follow_up_1','follow_up_2') then raise exception 'Invalid campaign stage'; end if;
 for g in
  select c.university_id,lower(btrim(coalesce(c.coach_email,''))) email,
    case when btrim(coalesce(c.coach_email,''))='' then c.id::text else lower(btrim(c.coach_email)) end recipient_key,
    array_agg(c.id order by c.id) ids
  from public.recruiting_campaign_contacts m join public.recruiting_contacts c on c.id=m.contact_id and c.owner_user_id=p_owner_id
  where m.campaign_id=p.id and m.owner_user_id=p_owner_id
  group by c.university_id,lower(btrim(coalesce(c.coach_email,''))),case when btrim(coalesce(c.coach_email,''))='' then c.id::text else lower(btrim(c.coach_email)) end
  order by c.university_id,recipient_key
 loop
  ids:=g.ids; audience:='{}'; reasons:='{}'; excluded:=false; predecessor:=null;
  if not exists(select 1 from public.recruiting_universities u where u.id=g.university_id and u.is_active and not u.is_test) then audience:=array_append(audience,'school_inactive'); excluded:=true; end if;
  if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=p_owner_id and c.university_id=g.university_id and
    (c.contact_status='responded' or length(btrim(coalesce(c.coach_response,'')))>0 or exists(select 1 from public.recruiting_contact_history h where h.owner_user_id=p_owner_id and h.contact_id=c.id and h.event_type='reply_received')))
   or exists(select 1 from public.recruiting_inbound_leads l where l.owner_user_id=p_owner_id and exists(select 1 from public.recruiting_contacts c where c.owner_user_id=p_owner_id and c.university_id=g.university_id and (c.id=l.linked_contact_id or (l.lead_status<>'dismissed' and length(btrim(coalesce(c.coach_email,'')))>0 and lower(btrim(c.coach_email))=lower(btrim(l.coach_email))))))
   then audience:=array_append(audience,'school_reply'); excluded:=true; end if;
  if exists(select 1 from public.recruiting_campaign_schools s where s.owner_user_id=p_owner_id and s.campaign_id=p.id and s.university_id=g.university_id and (s.reply_status='received' or s.progress<>'unknown')) then audience:=array_append(audience,'school_individual'); excluded:=true; end if;
  if exists(select 1 from public.recruiting_campaign_schools s where s.owner_user_id=p_owner_id and s.campaign_id=p.id and s.university_id=g.university_id and s.reply_status='review') then audience:=array_append(audience,'reply_attribution'); end if;
  if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=p_owner_id and c.university_id=g.university_id and lower(btrim(c.coach_email))=g.email and c.contact_status in ('closed','not_a_fit')) then audience:=array_append(audience,'recipient_closed'); excluded:=true; end if;
  if not excluded then
   if g.email !~ '^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$' then audience:=array_append(audience,'recipient_invalid'); end if;
   if exists(select 1 from public.recruiting_contacts c where c.id=any(ids) and btrim(coalesce(c.next_action,'')) in ('学校接触済み・個人メール非公開','学校接触済み・別スタッフ経由','Staff要確認')) then audience:=array_append(audience,'staff_review'); end if;
   if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=p_owner_id and c.university_id<>g.university_id and g.email<>'' and lower(btrim(c.coach_email))=g.email) then audience:=array_append(audience,'recipient_other_school'); end if;
   if exists(select 1 from public.recruiting_contacts c where c.owner_user_id=p_owner_id and c.university_id=g.university_id and g.email<>'' and lower(btrim(c.coach_email))=g.email and not(c.id=any(ids))) then audience:=array_append(audience,'shared_nonmember'); end if;
  end if;
  -- Conflicting old reservations are detected by both contact and normalized destination.
  if exists(select 1 from public.recruiting_initial_email_jobs j where j.owner_user_id=p_owner_id and j.status in ('scheduled','processing','send_unknown') and (j.contact_id=any(ids) or j.contact_ids&&ids or (g.email<>'' and lower(btrim(j.recipient_email))=g.email)))
   or exists(select 1 from public.recruiting_followup_batch_items j where j.owner_user_id=p_owner_id and j.mode='production' and j.status in ('scheduled','processing','send_unknown') and (j.contact_id=any(ids) or (g.email<>'' and lower(btrim(j.recipient_email))=g.email))) then audience:=array_append(audience,'legacy_reservation'); end if;
  if exists(select 1 from public.recruiting_campaign_issues i where i.owner_user_id=p_owner_id and i.status='open' and i.blocking and (i.university_id=g.university_id or i.contact_ids&&ids)) then audience:=array_append(audience,'blocking_issue'); end if;
  if exists(select 1 from public.recruiting_campaign_messages m join public.recruiting_email_tracking t on t.id=m.tracking_id where m.campaign_id=p.id and m.owner_user_id=p_owner_id and m.contact_id=any(ids) and t.status='send_unknown' and (t.campaign_delivery_id is null or t.campaign_delivery_id is distinct from p_ignore_delivery)) then audience:=array_append(audience,'send_unknown'); end if;
  if exists(select 1 from public.recruiting_campaign_deliveries d where d.owner_user_id=p_owner_id and d.recipient_email=g.email and d.status in ('scheduled','processing','held','send_unknown') and d.id is distinct from p_ignore_delivery) then audience:=array_append(audience,'existing_delivery'); end if;
  select jsonb_agg(jsonb_build_object('contact_id',c.id,'email',c.coach_email,'next_action',c.next_action,'subject',coalesce(m.subject,''),'body',coalesce(m.body,''),'planned_at',m.planned_at,'tracking_id',m.tracking_id,'reservation_item_id',m.reservation_item_id) order by c.id)
   into drafts from public.recruiting_contacts c left join public.recruiting_campaign_messages m on m.campaign_id=p.id and m.owner_user_id=p_owner_id and m.contact_id=c.id and m.stage=p_stage where c.id=any(ids) and c.owner_user_id=p_owner_id;
  if exists(select 1 from jsonb_array_elements(drafts) x where length(btrim(x->>'subject'))=0 or length(btrim(x->>'body'))=0 or x->>'planned_at' is null) then reasons:=array_append(reasons,'draft_incomplete'); end if;
  if (select count(distinct jsonb_build_array(x->>'subject',x->>'body',x->>'planned_at')) from jsonb_array_elements(drafts) x)>1 then reasons:=array_append(reasons,'shared_draft_mismatch'); end if;
  if exists(select 1 from jsonb_array_elements(drafts) x where length(x->>'subject')>180 or x->>'subject' ~ '[\r\n]') then reasons:=array_append(reasons,'subject_invalid'); end if;
  if exists(select 1 from jsonb_array_elements(drafts) x where (x->>'planned_at')::timestamptz<=now()) then reasons:=array_append(reasons,'date_past'); end if;
  if exists(select 1 from public.recruiting_campaign_messages m join public.recruiting_email_tracking t on t.id=m.tracking_id where m.campaign_id=p.id and m.owner_user_id=p_owner_id and m.contact_id=any(ids) and m.stage=p_stage and t.status='sent') then reasons:=array_append(reasons,'stage_sent'); end if;
  if exists(select 1 from public.recruiting_campaign_deliveries d where d.campaign_id=p.id and d.owner_user_id=p_owner_id and d.university_id=g.university_id and d.recipient_email=g.email and d.stage=p_stage and d.status<>'cancelled' and d.id is distinct from p_ignore_delivery) then reasons:=array_append(reasons,'stage_reserved'); end if;
  if p_stage<>'initial' then
   select d.id into predecessor from public.recruiting_campaign_deliveries d where d.campaign_id=p.id and d.owner_user_id=p_owner_id and d.university_id=g.university_id and d.recipient_email=g.email and d.stage=case p_stage when 'follow_up_1' then 'initial' else 'follow_up_1' end and d.status='sent' and d.gmail_thread_id is not null and d.gmail_message_id is not null and d.contact_ids@>ids;
   if predecessor is null then reasons:=array_append(reasons,'previous_stage_unsent'); end if;
  end if;
  source_key:=md5(jsonb_build_object('campaign',p.id,'stage',p_stage,'school',g.university_id,'email',g.email,'drafts',drafts,'audience',audience,'predecessor',predecessor)::text);
  v:=jsonb_build_object('university_id',g.university_id,'recipient_email',g.email,'contact_ids',ids,'drafts',drafts,'excluded',excluded,'audience_reasons',audience,'send_reasons',reasons,'predecessor_id',predecessor,'source_key',source_key,'ready',cardinality(audience)=0 and cardinality(reasons)=0);
  groups:=groups||jsonb_build_array(v);
 end loop;
 return jsonb_build_object('campaign_id',p.id,'stage',p_stage,'groups',groups,'execution_enabled',coalesce((select enabled and schedule_confirmed_at is not null and content_confirmed_at is not null from public.recruiting_campaign_execution where campaign_id=p.id and owner_user_id=p_owner_id),false));
end $$;
revoke all on function public.recruiting_campaign_preflight(uuid,text,uuid,uuid) from public,anon;
grant execute on function public.recruiting_campaign_preflight(uuid,text,uuid,uuid) to authenticated,service_role;

create function public.save_recruiting_campaign_draft(p_campaign_id uuid,p_contact_id uuid,p_stage text,p_subject text,p_body text,p_planned_at timestamptz,p_source_key text,p_apply_shared boolean default false)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare v jsonb; g jsonb; ids uuid[]; n integer;
begin
 if auth.uid() is null then raise exception 'Login required' using errcode='42501'; end if;
 perform 1 from public.recruiting_campaigns where id=p_campaign_id and owner_user_id=auth.uid() for update;
 if not found then raise exception 'Campaign unavailable' using errcode='42501'; end if;
 v:=public.recruiting_campaign_preflight(p_campaign_id,p_stage);
 select x into g from jsonb_array_elements(v->'groups') x where (x->'contact_ids') ? p_contact_id::text;
 if g is null or g->>'source_key' is distinct from p_source_key then raise exception 'Draft or recipients changed; reopen before saving' using errcode='40001'; end if;
 if length(coalesce(p_subject,''))>180 or p_subject ~ '[\r\n]' or length(coalesce(p_body,''))>100000 then raise exception 'Invalid draft'; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(g->'contact_ids');
 if exists(select 1 from public.recruiting_campaign_deliveries d where d.owner_user_id=auth.uid() and d.campaign_id=p_campaign_id and d.stage=p_stage and d.contact_ids&&ids and d.status<>'cancelled')
   or exists(select 1 from public.recruiting_campaign_messages m where m.owner_user_id=auth.uid() and m.campaign_id=p_campaign_id and m.stage=p_stage and m.contact_id=any(ids) and (m.tracking_id is not null or m.reservation_item_id is not null)) then raise exception 'Reserved or recorded mail cannot be overwritten'; end if;
 if not p_apply_shared then ids:=array[p_contact_id]; end if;
 insert into public.recruiting_campaign_messages(campaign_id,owner_user_id,contact_id,stage,subject,body,planned_at)
 select p_campaign_id,auth.uid(),i,p_stage,coalesce(p_subject,''),coalesce(p_body,''),p_planned_at from unnest(ids) i
 on conflict(campaign_id,contact_id,stage) do update set subject=excluded.subject,body=excluded.body,planned_at=excluded.planned_at;
 get diagnostics n=row_count;return n;
end $$;
revoke all on function public.save_recruiting_campaign_draft(uuid,uuid,text,text,text,timestamptz,text,boolean) from public,anon;
grant execute on function public.save_recruiting_campaign_draft(uuid,uuid,text,text,text,timestamptz,text,boolean) to authenticated;

-- Only the authenticated Edge endpoint can request service-role queue mutations.
create function public.schedule_recruiting_campaign(p_owner_id uuid,p_campaign_id uuid,p_stage text,p_groups jsonb)
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
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(g->'contact_ids');
  return query insert into public.recruiting_campaign_deliveries(campaign_id,owner_user_id,university_id,stage,recipient_email,contact_ids,subject,body,scheduled_at,school_timezone,predecessor_id,source_key)
  values(p_campaign_id,p_owner_id,(g->>'university_id')::integer,p_stage,g->>'recipient_email',ids,g#>>'{drafts,0,subject}',g#>>'{drafts,0,body}',(g#>>'{drafts,0,planned_at}')::timestamptz,input->>'school_timezone',(g->>'predecessor_id')::uuid,g->>'source_key') returning *;
 end loop;
end $$;
revoke all on function public.schedule_recruiting_campaign(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.schedule_recruiting_campaign(uuid,uuid,text,jsonb) to service_role;

create function public.claim_recruiting_campaign_delivery()
returns setof public.recruiting_campaign_deliveries language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.recruiting_campaign_deliveries;
begin
 -- A transport attempt is never automatically retried, including a crashed request.
 update public.recruiting_campaign_deliveries set status=case when transport_started_at is null then 'held' else 'send_unknown' end,error_message='Worker interrupted; reconcile before resuming',updated_at=now() where status='processing' and processing_started_at<now()-interval '10 minutes';
 insert into public.recruiting_campaign_issues(owner_user_id,campaign_id,university_id,contact_ids,issue_key,kind,delivery_id,details)
 select owner_user_id,campaign_id,university_id,contact_ids,'delivery:'||id,case status when 'send_unknown' then 'send_unknown' else 'delivery_held' end,id,error_message from public.recruiting_campaign_deliveries where status in ('held','send_unknown')
 on conflict(owner_user_id,issue_key) do nothing;
 select q.* into d from public.recruiting_campaign_deliveries q join public.recruiting_campaign_execution e using(campaign_id,owner_user_id) where q.status='scheduled' and not q.cancel_requested and q.scheduled_at<=now() and e.enabled and e.schedule_confirmed_at is not null and e.content_confirmed_at is not null order by q.scheduled_at for update of q skip locked limit 1;
 if d.id is null then return; end if;
 return query update public.recruiting_campaign_deliveries set status='processing',processing_started_at=now(),updated_at=now() where id=d.id returning *;
end $$;
revoke all on function public.claim_recruiting_campaign_delivery() from public,anon,authenticated;
grant execute on function public.claim_recruiting_campaign_delivery() to service_role;

create function public.permit_recruiting_campaign_transport(p_delivery_id uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.recruiting_campaign_deliveries; v jsonb; g jsonb;
begin
 select * into d from public.recruiting_campaign_deliveries where id=p_delivery_id for update;
 if d.id is null or d.status<>'processing' or d.cancel_requested or d.transport_started_at is not null then return false; end if;
 if not exists(select 1 from public.recruiting_campaign_execution where campaign_id=d.campaign_id and owner_user_id=d.owner_user_id and enabled and schedule_confirmed_at is not null and content_confirmed_at is not null) then return false; end if;
 v:=public.recruiting_campaign_preflight(d.campaign_id,d.stage,d.owner_user_id,d.id);
 select x into g from jsonb_array_elements(v->'groups') x where x->>'source_key'=d.source_key;
 -- Scheduled dates are necessarily due now, so date_past alone is expected here.
 if g is null or jsonb_array_length(g->'audience_reasons')>0 or exists(select 1 from jsonb_array_elements_text(g->'send_reasons') r where r<>'date_past') then return false; end if;
 update public.recruiting_campaign_deliveries set transport_started_at=now(),updated_at=now() where id=d.id;
 return true;
end $$;
revoke all on function public.permit_recruiting_campaign_transport(uuid) from public,anon,authenticated;
grant execute on function public.permit_recruiting_campaign_transport(uuid) to service_role;

create function public.finalize_recruiting_campaign_delivery(p_delivery_id uuid,p_gmail_message_id text,p_gmail_thread_id text,p_sent_at timestamptz)
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
   contact_status=case when contact_status in ('responded','closed','not_a_fit') or last_contact_at>p_sent_at or length(btrim(coalesce(coach_response,'')))>0 then contact_status else 'contacted' end,
   gmail_thread_id=case when last_contact_at>p_sent_at then gmail_thread_id else p_gmail_thread_id end,
   last_contact_at=greatest(last_contact_at,p_sent_at),updated_at=now() where id=c.id;
  insert into public.recruiting_contact_history(contact_id,owner_user_id,event_type,event_at,note,gmail_message_id,gmail_message_at) values(c.id,d.owner_user_id,case d.stage when 'initial' then 'contact_logged' else 'follow_up_sent' end,p_sent_at,'Campaign '||d.campaign_id||' / '||d.stage||' / delivery '||d.id,p_gmail_message_id,p_sent_at);
 end loop;
 insert into public.recruiting_campaign_label_tasks(delivery_id,owner_user_id) values(d.id,d.owner_user_id) on conflict(delivery_id) do update set status='pending',next_attempt_at=now(),updated_at=now();
 update public.recruiting_campaign_issues set status='resolved',updated_at=now() where owner_user_id=d.owner_user_id and issue_key='delivery:'||d.id;
 return true;
end $$;
revoke all on function public.finalize_recruiting_campaign_delivery(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finalize_recruiting_campaign_delivery(uuid,text,text,timestamptz) to service_role;

-- This trigger has no user-controlled parameters. It can only stop mail for NEW's
-- already-authorized owner and school. It cannot create a reservation or send mail.
create function public.stop_campaign_outreach_on_reply()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid; v_school integer; v_email text; c record;
begin
 v_owner:=new.owner_user_id;
 if auth.uid() is not null and auth.uid()<>v_owner then raise exception 'Owner mismatch' using errcode='42501'; end if;
 if tg_table_name='recruiting_contacts' then
  if new.contact_status='responded' or length(btrim(coalesce(new.coach_response,'')))>0 then v_school:=new.university_id;
  elsif new.contact_status in ('closed','not_a_fit') then v_school:=new.university_id;v_email:=lower(btrim(new.coach_email));
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
  update public.recruiting_campaign_deliveries set status=case status when 'scheduled' then 'cancelled' else status end,cancel_requested=true,error_message='School reply or exclusion recorded; bulk outreach stopped',updated_at=now() where owner_user_id=v_owner and university_id=v_school and (v_email is null or recipient_email=v_email) and status in ('scheduled','processing');
 end if;
 return new;
end $$;
revoke all on function public.stop_campaign_outreach_on_reply() from public,anon,authenticated;
create trigger campaign_stop_contact after insert or update of contact_status,coach_response on public.recruiting_contacts for each row execute function public.stop_campaign_outreach_on_reply();
create trigger campaign_stop_history after insert or update of event_type on public.recruiting_contact_history for each row execute function public.stop_campaign_outreach_on_reply();
create trigger campaign_stop_state after insert or update of reply_status,progress on public.recruiting_campaign_schools for each row execute function public.stop_campaign_outreach_on_reply();
create trigger campaign_stop_inquiry after insert or update on public.recruiting_inbound_leads for each row execute function public.stop_campaign_outreach_on_reply();

create function public.protect_campaign_reserved_draft()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' and (old.subject,old.body,old.planned_at,old.contact_id,old.campaign_id,old.stage,old.owner_user_id) is not distinct from (new.subject,new.body,new.planned_at,new.contact_id,new.campaign_id,new.stage,new.owner_user_id) then return new; end if;
 if exists(select 1 from public.recruiting_campaign_deliveries where campaign_id=old.campaign_id and owner_user_id=old.owner_user_id and stage=old.stage and old.contact_id=any(contact_ids) and status<>'cancelled') or old.tracking_id is not null or old.reservation_item_id is not null then raise exception 'Reserved or recorded mail cannot be overwritten'; end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
revoke all on function public.protect_campaign_reserved_draft() from public,anon;
create trigger campaign_protect_draft before update or delete on public.recruiting_campaign_messages for each row execute function public.protect_campaign_reserved_draft();

create function public.protect_campaign_tracking_pointer()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.campaign_delivery_id is not null then
  if auth.role()<>'service_role' and session_user<>'postgres' then raise exception 'Campaign tracking is server managed'; end if;
  if not exists(select 1 from public.recruiting_campaign_deliveries d where d.id=new.campaign_delivery_id and d.owner_user_id=new.owner_user_id and d.university_id=new.university_id and d.stage=new.stage and new.contact_id=any(d.contact_ids) and d.recipient_email=lower(btrim(new.recipient_email))) then raise exception 'Campaign tracking mismatch'; end if;
 end if;
 if tg_op='UPDATE' and old.campaign_delivery_id is not null and new.campaign_delivery_id is distinct from old.campaign_delivery_id then raise exception 'Campaign tracking pointer is immutable'; end if;
 return new;
end $$;
revoke all on function public.protect_campaign_tracking_pointer() from public,anon;
create trigger campaign_protect_tracking before insert or update on public.recruiting_email_tracking for each row execute function public.protect_campaign_tracking_pointer();

