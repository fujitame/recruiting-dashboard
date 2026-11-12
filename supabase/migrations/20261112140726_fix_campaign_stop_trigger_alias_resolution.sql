create or replace function public.stop_campaign_outreach_on_reply()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid; v_school integer; v_email text; v_match record;
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
