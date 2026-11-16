alter table public.recruiting_campaign_execution add column if not exists reservation_not_before timestamptz;
comment on column public.recruiting_campaign_execution.reservation_not_before is 'Earliest explicit user reservation confirmation; does not activate sending automatically.';
update public.recruiting_campaign_execution e set reservation_not_before='2026-11-16T18:00:00Z'
from public.recruiting_campaigns c where e.campaign_id=c.id and c.campaign_key='fall2027_reapproach_202611'
and e.reservation_not_before is null and not e.enabled;
create or replace function public.confirm_and_schedule_recruiting_campaign(p_owner_id uuid,p_campaign_id uuid,p_stage text,p_groups jsonb)
returns setof public.recruiting_campaign_deliveries language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare e public.recruiting_campaign_execution; snapshot jsonb; selected jsonb; g jsonb; ids uuid[];
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501';end if;
 perform 1 from public.recruiting_campaigns where id=p_campaign_id and owner_user_id=p_owner_id for update;
 if not found then raise exception 'Campaign unavailable';end if;
 select * into e from public.recruiting_campaign_execution where campaign_id=p_campaign_id and owner_user_id=p_owner_id for update;
 if not found or e.content_confirmed_at is null then raise exception 'Content approval is required';end if;
 if e.reservation_not_before is not null and now()<e.reservation_not_before then raise exception 'Reservation confirmation is not available yet';end if;
 if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)=0 then raise exception 'No recipients selected';end if;
 if (select count(*) from jsonb_array_elements(p_groups))<>(select count(distinct x->>'source_key') from jsonb_array_elements(p_groups)x) then raise exception 'Duplicate recipient groups';end if;
 snapshot:=public.recruiting_campaign_preflight(p_campaign_id,p_stage,p_owner_id);
 for selected in select value from jsonb_array_elements(p_groups) loop
  select x into g from jsonb_array_elements(snapshot->'groups')x where x->>'source_key'=selected->>'source_key';
  if g is null or not(g->>'ready')::boolean then raise exception 'Recipient, draft or dates changed';end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(g->'contact_ids');
  if exists(select 1 from unnest(ids)id left join public.recruiting_campaign_messages m on m.contact_id=id and m.campaign_id=p_campaign_id and m.owner_user_id=p_owner_id and m.stage=p_stage
    left join public.recruiting_campaign_draft_reviews r on r.message_id=m.id and r.owner_user_id=p_owner_id
    where r.reviewed is distinct from true or r.source_subject is distinct from m.subject or r.source_body is distinct from m.body)
  then raise exception 'Current English and Japanese drafts must be reviewed';end if;
 end loop;
 update public.recruiting_campaign_execution set enabled=true,schedule_confirmed_at=coalesce(schedule_confirmed_at,now()),updated_at=now() where campaign_id=p_campaign_id and owner_user_id=p_owner_id;
 return query select * from public.schedule_recruiting_campaign(p_owner_id,p_campaign_id,p_stage,p_groups);
end $fn$;
revoke all on function public.confirm_and_schedule_recruiting_campaign(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.confirm_and_schedule_recruiting_campaign(uuid,uuid,text,jsonb) to service_role;
