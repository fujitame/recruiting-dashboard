-- Explicit reservation references keep old Follow-ups out of the new activity.
alter table public.recruiting_campaign_messages
 add column reservation_item_id uuid references public.recruiting_followup_batch_items(id);
create index recruiting_campaign_messages_reservation_idx on public.recruiting_campaign_messages(reservation_item_id) where reservation_item_id is not null;

drop policy campaign_message_owner on public.recruiting_campaign_messages;
create policy campaign_message_owner on public.recruiting_campaign_messages for all to authenticated
using(owner_user_id=(select auth.uid()))
with check (
 owner_user_id=(select auth.uid()) and
 exists(select 1 from public.recruiting_campaign_contacts m where m.campaign_id=recruiting_campaign_messages.campaign_id and m.contact_id=recruiting_campaign_messages.contact_id and m.owner_user_id=(select auth.uid())) and
 (tracking_id is null or exists(
  select 1 from public.recruiting_email_tracking t
  join public.recruiting_contacts c on c.id=recruiting_campaign_messages.contact_id
  where t.id=tracking_id and t.owner_user_id=(select auth.uid()) and t.stage=recruiting_campaign_messages.stage and
  (t.contact_id=c.id or (t.university_id=c.university_id and length(trim(c.coach_email))>0 and lower(trim(t.recipient_email))=lower(trim(c.coach_email))))
 )) and
 (reservation_item_id is null or exists(
  select 1 from public.recruiting_followup_batch_items f
  join public.recruiting_contacts c on c.id=recruiting_campaign_messages.contact_id
  where f.id=reservation_item_id and f.owner_user_id=(select auth.uid()) and f.mode='production' and
   case when f.expected_follow_up_count=0 then 'follow_up_1' else 'follow_up_2' end=recruiting_campaign_messages.stage and
   (f.contact_id=c.id or (f.university_id=c.university_id and length(trim(c.coach_email))>0 and lower(trim(f.recipient_email))=lower(trim(c.coach_email))))
 ))
);

create function public.link_recruiting_campaign_reservation_tracking() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.reservation_item_id is not null and not new.is_test then
  update public.recruiting_campaign_messages m set tracking_id=new.id
   where m.reservation_item_id=new.reservation_item_id and m.owner_user_id=new.owner_user_id and m.stage=new.stage;
 end if;
 return new;
end $$;
create trigger link_campaign_reservation_tracking
 after insert or update of reservation_item_id on public.recruiting_email_tracking
 for each row execute function public.link_recruiting_campaign_reservation_tracking();

-- Also link when a reservation is attached after its tracking row was prepared.
create function public.link_recruiting_campaign_message_tracking() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if new.reservation_item_id is not null then
  select t.id into new.tracking_id from public.recruiting_email_tracking t
   where t.reservation_item_id=new.reservation_item_id and t.owner_user_id=new.owner_user_id and t.stage=new.stage and not t.is_test
   order by t.created_at desc,t.id limit 1;
 end if;
 return new;
end $$;
create trigger link_campaign_message_tracking before insert or update of reservation_item_id
 on public.recruiting_campaign_messages for each row execute function public.link_recruiting_campaign_message_tracking();

-- Include the primary contact even if an older job has an empty contact_ids array.
create or replace function public.link_recruiting_campaign_job() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare p public.recruiting_campaigns%rowtype;
begin
 select * into p from public.recruiting_campaigns where owner_user_id=new.owner_user_id and campaign_key=new.campaign_key;
 if p.id is null then return new; end if;
 insert into public.recruiting_campaign_messages(campaign_id,owner_user_id,contact_id,stage,subject,body,tracking_id)
 select p.id,p.owner_user_id,m.contact_id,'initial',new.subject,new.body,new.tracking_id
 from public.recruiting_campaign_contacts m where m.campaign_id=p.id and (m.contact_id=new.contact_id or m.contact_id=any(new.contact_ids))
 on conflict(campaign_id,contact_id,stage) do update set tracking_id=excluded.tracking_id,subject=excluded.subject,body=excluded.body;
 return new;
end $$;
