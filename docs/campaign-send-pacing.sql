create table public.recruiting_campaign_send_control (
 owner_user_id uuid primary key references auth.users(id) on delete cascade,
 lease_token uuid, lease_until timestamptz,
 next_transport_at timestamptz not null default '-infinity',
 paused boolean not null default false,
 pause_reason text, paused_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.recruiting_campaign_send_control enable row level security;
revoke all on public.recruiting_campaign_send_control from public,anon,authenticated;
grant select,insert,update on public.recruiting_campaign_send_control to service_role;

create function public.acquire_recruiting_campaign_worker(p_owner_id uuid) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare control public.recruiting_campaign_send_control; token uuid;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501'; end if;
 insert into public.recruiting_campaign_send_control(owner_user_id) values(p_owner_id) on conflict do nothing;
 select * into control from public.recruiting_campaign_send_control where owner_user_id=p_owner_id for update;
 if control.paused or control.lease_until>clock_timestamp() then return null; end if;
 token:=gen_random_uuid();
 update public.recruiting_campaign_send_control set lease_token=token,lease_until=clock_timestamp()+interval '10 minutes',updated_at=now() where owner_user_id=p_owner_id;
 return token;
end $fn$;

create function public.release_recruiting_campaign_worker(p_owner_id uuid,p_token uuid) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare n integer;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501'; end if;
 update public.recruiting_campaign_send_control set lease_token=null,lease_until=null,updated_at=now() where owner_user_id=p_owner_id and lease_token=p_token;
 get diagnostics n=row_count; return n=1;
end $fn$;

create function public.recruiting_campaign_worker_status(p_owner_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare control public.recruiting_campaign_send_control;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501'; end if;
 select * into control from public.recruiting_campaign_send_control where owner_user_id=p_owner_id;
 if control.owner_user_id is null or control.lease_token is distinct from p_token or control.lease_until<=clock_timestamp() then return jsonb_build_object('allowed',false,'reason','worker_lease_lost');end if;
 if control.paused then return jsonb_build_object('allowed',false,'reason','account_paused','details',control.pause_reason);end if;
 return jsonb_build_object('allowed',true,'wait_ms',greatest(0,ceil(extract(epoch from(control.next_transport_at-clock_timestamp()))*1000)));
end $fn$;

create function public.claim_paced_recruiting_campaign_delivery(p_owner_id uuid,p_token uuid)
returns setof public.recruiting_campaign_deliveries language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare gate jsonb; selected_delivery public.recruiting_campaign_deliveries;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501';end if;
 perform 1 from public.recruiting_campaign_send_control where owner_user_id=p_owner_id for update;
 gate:=public.recruiting_campaign_worker_status(p_owner_id,p_token);
 if (gate->>'allowed')::boolean is distinct from true or (gate->>'wait_ms')::numeric>0 then return; end if;
 update public.recruiting_campaign_deliveries set status=case when cancel_requested and transport_started_at is null then 'cancelled' when transport_started_at is null then 'held' else 'send_unknown' end,error_message='Worker interrupted; reconcile before resuming',updated_at=now()
 where owner_user_id=p_owner_id and status='processing' and processing_started_at<now()-interval '10 minutes';
 if exists(select 1 from public.recruiting_campaign_deliveries where owner_user_id=p_owner_id and status='processing') then return;end if;
 select q.* into selected_delivery from public.recruiting_campaign_deliveries q join public.recruiting_campaign_execution e using(campaign_id,owner_user_id)
 where q.owner_user_id=p_owner_id and q.status='scheduled' and not q.cancel_requested and q.scheduled_at<=clock_timestamp() and e.enabled and e.schedule_confirmed_at is not null and e.content_confirmed_at is not null
 order by q.scheduled_at,q.id for update of q skip locked limit 1;
 if selected_delivery.id is null then return;end if;
 return query update public.recruiting_campaign_deliveries set status='processing',processing_started_at=clock_timestamp(),updated_at=now() where id=selected_delivery.id returning *;
end $fn$;

create function public.permit_paced_recruiting_campaign_transport(p_delivery_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare delivery_owner uuid; gate jsonb; permitted boolean;
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501';end if;
 select owner_user_id into delivery_owner from public.recruiting_campaign_deliveries where id=p_delivery_id;
 if delivery_owner is null then return jsonb_build_object('permitted',false,'reason','delivery_unavailable');end if;
 perform 1 from public.recruiting_campaign_send_control where owner_user_id=delivery_owner for update;
 gate:=public.recruiting_campaign_worker_status(delivery_owner,p_token);
 if (gate->>'allowed')::boolean is distinct from true then return gate||jsonb_build_object('permitted',false);end if;
 if (gate->>'wait_ms')::numeric>0 then return gate||jsonb_build_object('permitted',false,'reason','send_interval');end if;
 permitted:=public.permit_recruiting_campaign_transport(p_delivery_id);
 if not permitted then return jsonb_build_object('permitted',false,'reason','delivery_changed');end if;
 update public.recruiting_campaign_send_control set next_transport_at=clock_timestamp()+interval '30 seconds',updated_at=now() where owner_user_id=delivery_owner;
 return jsonb_build_object('permitted',true);
end $fn$;

create function public.pause_recruiting_campaign_sends(p_owner_id uuid,p_reason text) returns void
language plpgsql security invoker set search_path=public,pg_temp as $fn$
begin
 if (select auth.role()) is distinct from 'service_role' then raise exception 'Service authorization required' using errcode='42501';end if;
 insert into public.recruiting_campaign_send_control(owner_user_id,paused,pause_reason,paused_at)
 values(p_owner_id,true,left(p_reason,1500),now())
 on conflict(owner_user_id) do update set paused=true,pause_reason=excluded.pause_reason,paused_at=now(),updated_at=now();
end $fn$;
revoke execute on function public.acquire_recruiting_campaign_worker(uuid),public.release_recruiting_campaign_worker(uuid,uuid),public.recruiting_campaign_worker_status(uuid,uuid),public.claim_paced_recruiting_campaign_delivery(uuid,uuid),public.permit_paced_recruiting_campaign_transport(uuid,uuid),public.pause_recruiting_campaign_sends(uuid,text) from public,anon,authenticated;
grant execute on function public.acquire_recruiting_campaign_worker(uuid),public.release_recruiting_campaign_worker(uuid,uuid),public.recruiting_campaign_worker_status(uuid,uuid),public.claim_paced_recruiting_campaign_delivery(uuid,uuid),public.permit_paced_recruiting_campaign_transport(uuid,uuid),public.pause_recruiting_campaign_sends(uuid,text) to service_role;