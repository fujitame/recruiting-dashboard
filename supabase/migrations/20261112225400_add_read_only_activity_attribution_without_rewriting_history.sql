-- Additive attribution only. No UPDATE/DELETE of history, no history triggers,
-- and no changes to existing history permissions or sender behavior.
create table public.recruiting_activity_records (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id),
 university_id integer not null references public.recruiting_universities(id),
 contact_id uuid not null references public.recruiting_contacts(id),
 history_id uuid unique references public.recruiting_contact_history(id),
 gmail_message_id text,
 gmail_thread_id text,
 parent_gmail_message_id text,
 activity_scope text not null check(activity_scope in ('legacy','campaign','unassigned')),
 campaign_id uuid references public.recruiting_campaigns(id),
 source text not null,
 created_at timestamptz not null default now(),
 check(history_id is not null or gmail_message_id is not null),
 check((activity_scope='campaign' and campaign_id is not null) or (activity_scope<>'campaign' and campaign_id is null)),
 unique(owner_user_id,gmail_message_id)
);
alter table public.recruiting_activity_records enable row level security;
create policy activity_record_owner on public.recruiting_activity_records for select to authenticated using(owner_user_id=(select auth.uid()));
grant select on public.recruiting_activity_records to authenticated;
grant all on public.recruiting_activity_records to service_role;
create index activity_record_owner_campaign on public.recruiting_activity_records(owner_user_id,campaign_id);
create index activity_record_owner_thread on public.recruiting_activity_records(owner_user_id,gmail_thread_id);

-- The upcoming approach is disabled and has never sent: label the existing IDs,
-- without changing a byte of their original history or treating future notes as legacy.
do $$begin if exists(select 1 from public.recruiting_campaign_deliveries) then raise exception 'Campaign deliveries already exist; review baseline first';end if;end $$;
insert into public.recruiting_activity_records(owner_user_id,university_id,contact_id,history_id,gmail_message_id,activity_scope,source)
 select h.owner_user_id,c.university_id,c.id,h.id,h.gmail_message_id,'legacy','legacy_baseline_20261113'
 from public.recruiting_contact_history h join public.recruiting_contacts c on c.id=h.contact_id and c.owner_user_id=h.owner_user_id;

create function public.record_recruiting_message_activity(p_owner_id uuid,p_contact_id uuid,p_message_id text,p_thread_id text,p_parent_id text default null)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_school integer; v_scope text:='unassigned'; v_campaign uuid; v_ids uuid[]; v_old boolean; v_parent public.recruiting_activity_records%rowtype;
begin
 select university_id into v_school from public.recruiting_contacts where id=p_contact_id and owner_user_id=p_owner_id;
 if v_school is null or length(coalesce(p_message_id,''))=0 then raise exception 'Message contact unavailable';end if;
 -- Exact outbound record or a verified actual parent takes precedence over a thread.
 select array_agg(distinct campaign_id) into v_ids from public.recruiting_campaign_deliveries
  where owner_user_id=p_owner_id and university_id=v_school and status='sent' and gmail_message_id=p_message_id;
 if cardinality(v_ids)=1 then v_scope:='campaign';v_campaign:=v_ids[1];
 elsif p_parent_id is not null then
  select * into v_parent from public.recruiting_activity_records where owner_user_id=p_owner_id and university_id=v_school and gmail_message_id=p_parent_id;
  if v_parent.id is not null and v_parent.activity_scope<>'unassigned' then v_scope:=v_parent.activity_scope;v_campaign:=v_parent.campaign_id;
  else
   select array_agg(distinct campaign_id) into v_ids from public.recruiting_campaign_deliveries where owner_user_id=p_owner_id and university_id=v_school and status='sent' and gmail_message_id=p_parent_id;
   if cardinality(v_ids)=1 then v_scope:='campaign';v_campaign:=v_ids[1];end if;
  end if;
 end if;
 if v_scope='unassigned' and p_thread_id is not null then
  select array_agg(distinct proof.campaign_id) into v_ids from (
   select campaign_id from public.recruiting_campaign_deliveries where owner_user_id=p_owner_id and university_id=v_school and status='sent' and gmail_thread_id=p_thread_id
   union select campaign_id from public.recruiting_activity_records where owner_user_id=p_owner_id and university_id=v_school and activity_scope='campaign' and gmail_thread_id=p_thread_id
  ) proof;
  select exists(select 1 from public.recruiting_activity_records where owner_user_id=p_owner_id and university_id=v_school and activity_scope='legacy' and gmail_thread_id=p_thread_id)
   or exists(select 1 from public.recruiting_initial_email_jobs j where j.owner_user_id=p_owner_id and j.university_id=v_school and j.status='sent' and j.gmail_thread_id=p_thread_id and not exists(select 1 from public.recruiting_campaigns p where p.owner_user_id=p_owner_id and p.campaign_key=j.campaign_key))
   or exists(select 1 from public.recruiting_followup_batch_items f where f.owner_user_id=p_owner_id and f.university_id=v_school and f.status='sent' and f.mode='production' and f.gmail_thread_id=p_thread_id and not exists(select 1 from public.recruiting_campaign_messages m where m.owner_user_id=p_owner_id and m.reservation_item_id=f.id)) into v_old;
  if cardinality(v_ids)=1 and not v_old then v_scope:='campaign';v_campaign:=v_ids[1];
  elsif coalesce(cardinality(v_ids),0)=0 and (v_old or not exists(select 1 from public.recruiting_campaign_deliveries where owner_user_id=p_owner_id and university_id=v_school and status='sent')) then v_scope:='legacy';end if;
 end if;
 insert into public.recruiting_activity_records(owner_user_id,university_id,contact_id,gmail_message_id,gmail_thread_id,parent_gmail_message_id,activity_scope,campaign_id,source)
 values(p_owner_id,v_school,p_contact_id,p_message_id,p_thread_id,p_parent_id,v_scope,v_campaign,'verified_gmail_context')
 on conflict(owner_user_id,gmail_message_id) do update set gmail_thread_id=coalesce(excluded.gmail_thread_id,recruiting_activity_records.gmail_thread_id),parent_gmail_message_id=coalesce(excluded.parent_gmail_message_id,recruiting_activity_records.parent_gmail_message_id),activity_scope=case when recruiting_activity_records.activity_scope='unassigned' then excluded.activity_scope else recruiting_activity_records.activity_scope end,campaign_id=case when recruiting_activity_records.activity_scope='unassigned' then excluded.campaign_id else recruiting_activity_records.campaign_id end;
 return v_scope;
end $$;
revoke all on function public.record_recruiting_message_activity(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_recruiting_message_activity(uuid,uuid,text,text,text) to service_role;

