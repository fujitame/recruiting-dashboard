-- One regular Follow-up per school/shared recipient/stage. Different coach addresses stay independent.
alter table public.recruiting_email_tracking add column university_id integer;
alter table public.recruiting_email_tracking add column recipient_email text;
update public.recruiting_email_tracking t set university_id=c.university_id,recipient_email=lower(trim(c.coach_email))
from public.recruiting_contacts c where c.id=t.contact_id;
create unique index recruiting_email_tracking_recipient_stage_idx
on public.recruiting_email_tracking(owner_user_id,university_id,recipient_email,stage)
where not is_test and stage in ('follow_up_1','follow_up_2');
create unique index recruiting_followup_pending_recipient_idx
on public.recruiting_followup_batch_items(owner_user_id,university_id,lower(trim(recipient_email)))
where mode='production' and status in ('scheduled','processing','send_unknown');

-- Commit the verified send, all eligible contacts sharing its address, and history together.
create function public.finalize_tracked_recruiting_followup(p_tracking_id uuid,p_contact jsonb,p_history jsonb)
returns setof public.recruiting_contacts language plpgsql security invoker set search_path=public,pg_catalog as $$
declare t public.recruiting_email_tracking%rowtype; c public.recruiting_contacts%rowtype;
 sibling public.recruiting_contacts%rowtype; expected integer; next_count integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into t from public.recruiting_email_tracking where id=p_tracking_id for update;
 if not found or t.status<>'sent' or t.gmail_message_id is null or t.stage not in ('follow_up_1','follow_up_2') then raise exception 'Verified regular send required'; end if;
 expected:=case when t.stage='follow_up_1' then 0 else 1 end; next_count:=expected+1;
 perform id from public.recruiting_contacts where owner_user_id=t.owner_user_id and university_id=t.university_id order by id for update;
 select * into c from public.recruiting_contacts where id=t.contact_id and owner_user_id=t.owner_user_id;
 if not found or c.follow_up_count<>expected or c.contact_status not in ('contacted','follow_up_due')
  or nullif(trim(coalesce(c.coach_response,'')),'') is not null then raise exception 'CRM changed after verified send; inspect Gmail without resending'; end if;
 if exists(select 1 from public.recruiting_contacts where owner_user_id=t.owner_user_id and university_id=c.university_id
  and (contact_status='responded' or nullif(trim(coalesce(coach_response,'')),'') is not null)) then
  raise exception 'A school reply arrived after send; inspect Gmail without resending';
 end if;
 if not t.is_test and (t.recipient_email is distinct from lower(trim(c.coach_email)) or t.university_id<>c.university_id) then raise exception 'Shared recipient changed'; end if;
 for sibling in select * from public.recruiting_contacts where owner_user_id=t.owner_user_id
  and (id=c.id or (not t.is_test and university_id=c.university_id and lower(trim(coach_email))=t.recipient_email))
  and follow_up_count=expected and contact_status in ('contacted','follow_up_due')
  and coach_role in ('head_coach','assistant_coach') and nullif(trim(coalesce(coach_response,'')),'') is null loop
  update public.recruiting_contacts set contact_status=case when next_count=2 then 'no_response' else 'contacted' end,
   follow_up_count=next_count,contact_count=coalesce(sibling.contact_count,0)+1,last_contact_at=t.sent_at,last_follow_up_at=t.sent_at,
   follow_up_date=case when next_count=2 then null else nullif(p_contact->>'follow_up_date','')::date end,
   auto_follow_up_enabled=case when next_count=2 then false else coalesce((p_contact->>'auto_follow_up_enabled')::boolean,false) end,
   next_action=p_contact->>'next_action',
   gmail_thread_id=case when id=c.id then coalesce(nullif(p_contact->>'gmail_thread_id',''),gmail_thread_id) else gmail_thread_id end
   where id=sibling.id returning * into sibling;
  insert into public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,to_status,note,gmail_message_id,gmail_message_at,research_ids)
   values(t.owner_user_id,sibling.id,'follow_up_sent',t.sent_at,sibling.contact_status,
    case when sibling.id=c.id then p_history->>'note' else '同校の共有メールアドレスへFollow-up #'||next_count::text||'を1通送信（代表Contact: '||c.id::text||'）。追加送信なし。' end,
    case when sibling.id=c.id then t.gmail_message_id else null end,t.sent_at,
    array(select jsonb_array_elements_text(coalesce(p_history->'research_ids','[]'::jsonb))::bigint));
  return next sibling;
 end loop;
end $$;
revoke all on function public.finalize_tracked_recruiting_followup(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_tracked_recruiting_followup(uuid,jsonb,jsonb) to service_role;
