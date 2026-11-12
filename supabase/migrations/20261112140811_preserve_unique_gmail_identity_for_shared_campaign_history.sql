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
  insert into public.recruiting_contact_history(contact_id,owner_user_id,event_type,event_at,note,gmail_message_id,gmail_message_at) values(c.id,d.owner_user_id,case d.stage when 'initial' then 'contact_logged' else 'follow_up_sent' end,p_sent_at,'Campaign '||d.campaign_id||' / '||d.stage||' / delivery '||d.id||' / gmail '||p_gmail_message_id,case when c.id=d.contact_ids[1] then p_gmail_message_id else null end,p_sent_at);
 end loop;
 insert into public.recruiting_campaign_label_tasks(delivery_id,owner_user_id) values(d.id,d.owner_user_id) on conflict(delivery_id) do update set status='pending',next_attempt_at=now(),updated_at=now();
 update public.recruiting_campaign_issues set status='resolved',updated_at=now() where owner_user_id=d.owner_user_id and issue_key='delivery:'||d.id;
 return true;
end $$;
