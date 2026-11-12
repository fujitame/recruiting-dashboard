create or replace function public.recruiting_campaign_preflight(p_campaign_id uuid,p_stage text,p_owner_id uuid default auth.uid(),p_ignore_delivery uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare p public.recruiting_campaigns; g record; v jsonb; groups jsonb:='[]';
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

