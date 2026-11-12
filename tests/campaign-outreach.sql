-- Run in one transaction; no persisted test contacts, messages, queue, or flags.
begin;
create temporary table campaign_fixture(campaign uuid,school integer,ids uuid[],delivery uuid);
do $$
declare owner uuid:='47e7c1a9-a806-4f65-b5ed-2b9b124ef337';p uuid:=gen_random_uuid(); school integer; ids uuid[]; v jsonb; g jsonb; old_key text; d uuid; n integer;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
 select (x->>'university_id')::integer into school from jsonb_array_elements(public.recruiting_campaign_preflight('eed38a8c-5bf5-43dc-9d58-0fce35922804','initial',owner)->'groups') x where jsonb_array_length(x->'audience_reasons')=0 group by x->>'university_id' having count(*)=2 limit 1;
 if school is null then raise exception 'No safe fixture school'; end if;
 select array_agg(id order by id) into ids from public.recruiting_contacts where university_id=school and owner_user_id=owner;
 if cardinality(ids)<>2 then raise exception 'Fixture requires two school contacts'; end if;
 update public.recruiting_contacts set coach_email='campaign-fixture@example.invalid',next_action='',contact_status='not_contacted',coach_response=null,follow_up_count=2 where id=any(ids);
 insert into public.recruiting_campaigns(id,owner_user_id,campaign_key,name) values(p,owner,'fixture_'||p,'Rollback fixture');
 insert into public.recruiting_campaign_contacts(campaign_id,owner_user_id,contact_id) select p,owner,unnest(ids);
 v:=public.recruiting_campaign_preflight(p,'initial',owner);if jsonb_array_length(v->'groups')<>1 then raise exception 'Shared destination was not grouped'; end if;
 g:=v#>'{groups,0}';if jsonb_array_length(g->'audience_reasons')<>0 then raise exception 'Old FU counter polluted new campaign: %',g; end if;
 old_key:=g->>'source_key';
 n:=public.save_recruiting_campaign_draft(p,ids[1],'initial','Fixture subject','Approved fixture body',now()+interval '10 days',old_key,false);if n<>1 then raise exception 'Single draft save failed'; end if;
 v:=public.recruiting_campaign_preflight(p,'initial',owner);g:=v#>'{groups,0}';
 if not(g->'send_reasons' ? 'shared_draft_mismatch') then raise exception 'Shared mismatch not held'; end if;
 begin perform public.save_recruiting_campaign_draft(p,ids[1],'initial','stale','stale',null,old_key,true);raise exception 'Stale write accepted';exception when serialization_failure then null;end;
 n:=public.save_recruiting_campaign_draft(p,ids[1],'initial','Fixture subject','Approved fixture body',now()+interval '10 days',g->>'source_key',true);if n<>2 then raise exception 'Shared atomic draft save failed';end if;
 g:=public.recruiting_campaign_preflight(p,'initial',owner)#>'{groups,0}';if not(g->>'ready')::boolean then raise exception 'Complete draft not ready: %',g;end if;
 begin perform public.schedule_recruiting_campaign(owner,p,'initial',jsonb_build_array(jsonb_build_object('source_key',g->>'source_key','school_timezone','America/New_York')));raise exception 'Inactive campaign scheduled';exception when raise_exception then if sqlerrm='Inactive campaign scheduled' then raise;end if;end;
 insert into public.recruiting_campaign_execution(campaign_id,owner_user_id,enabled,schedule_confirmed_at,content_confirmed_at) values(p,owner,true,now(),now());
 select id into d from public.schedule_recruiting_campaign(owner,p,'initial',jsonb_build_array(jsonb_build_object('source_key',g->>'source_key','school_timezone','America/New_York')));
 if d is null then raise exception 'Fixture schedule failed';end if;
 begin update public.recruiting_campaign_messages set body='Overwrite reserved mail' where campaign_id=p;raise exception 'Reserved draft overwritten';exception when raise_exception then if sqlerrm='Reserved draft overwritten' then raise;end if;end;
 update public.recruiting_contacts set coach_response='Fixture coach reply',contact_status='responded' where id=ids[2];
 if (select status from public.recruiting_campaign_deliveries where id=d)<>'cancelled' then raise exception 'Other coach reply did not stop reservation';end if;
 if not(public.recruiting_campaign_preflight(p,'initial',owner)#>'{groups,0,audience_reasons}' ? 'school_reply') then raise exception 'School reply not shared';end if;
 update public.recruiting_contacts set coach_response=null,contact_status='not_contacted' where id=ids[2];
 if not(public.recruiting_campaign_preflight(p,'follow_up_1',owner)#>'{groups,0,send_reasons}' ? 'previous_stage_unsent') then raise exception 'FU accepted lifetime counter as predecessor';end if;
 insert into campaign_fixture values(p,school,ids,d);
end $$;
do $$
declare f record;owner uuid:='47e7c1a9-a806-4f65-b5ed-2b9b124ef337';g jsonb;d uuid;t uuid;before_counts integer[];after_counts integer[];n integer;
begin
 select * into f from campaign_fixture;
 g:=public.recruiting_campaign_preflight(f.campaign,'initial',owner)#>'{groups,0}';
 perform public.save_recruiting_campaign_draft(f.campaign,f.ids[1],'initial','Fixture subject','Approved fixture body',now()-interval '1 day',g->>'source_key',true);
 g:=public.recruiting_campaign_preflight(f.campaign,'initial',owner)#>'{groups,0}';
 insert into public.recruiting_campaign_deliveries(campaign_id,owner_user_id,university_id,stage,recipient_email,contact_ids,subject,body,scheduled_at,school_timezone,source_key,status,processing_started_at)
 values(f.campaign,owner,f.school,'initial','campaign-fixture@example.invalid',f.ids,'Fixture subject','Approved fixture body',now()-interval '1 day','America/New_York',g->>'source_key','processing',now()) returning id into d;
 update public.recruiting_contacts set next_action='Staff要確認' where id=f.ids[1];
 if public.permit_recruiting_campaign_transport(d) then raise exception 'Changed staff/source allowed transport';end if;
 update public.recruiting_contacts set next_action='' where id=f.ids[1];
 update public.recruiting_campaign_deliveries set cancel_requested=true where id=d;
 if public.permit_recruiting_campaign_transport(d) then raise exception 'Cancelled transport permitted';end if;
 update public.recruiting_campaign_deliveries set cancel_requested=false where id=d;
 if not public.permit_recruiting_campaign_transport(d) then raise exception 'Valid due gate refused';end if;
 if public.permit_recruiting_campaign_transport(d) then raise exception 'Transport allowed twice';end if;
 insert into public.recruiting_email_tracking(owner_user_id,contact_id,university_id,recipient_email,token_hash,stage,campaign_delivery_id)
 values(owner,f.ids[1],f.school,'campaign-fixture@example.invalid',repeat(md5(d::text),2),'initial',d) returning id into t;
 update public.recruiting_campaign_deliveries set tracking_id=t,transport_body='Approved fixture body' where id=d;
 select array_agg(contact_count order by id) into before_counts from public.recruiting_contacts where id=any(f.ids);
 if not public.finalize_recruiting_campaign_delivery(d,'fixture_gmail_'||d,'fixture_thread_'||d,now()) then raise exception 'Finalize refused';end if;
 if not public.finalize_recruiting_campaign_delivery(d,'fixture_gmail_'||d,'fixture_thread_'||d,now()) then raise exception 'Idempotent finalize refused';end if;
 select array_agg(contact_count order by id) into after_counts from public.recruiting_contacts where id=any(f.ids);
 for n in 1..2 loop if after_counts[n]<>before_counts[n]+1 then raise exception 'Shared coach credited zero/twice';end if;end loop;
 if exists(select 1 from public.recruiting_contacts where id=any(f.ids) and follow_up_count<>2) then raise exception 'Lifetime counter reset';end if;
 if (select count(*) from public.recruiting_campaign_messages where campaign_id=f.campaign and tracking_id=t)<>2 then raise exception 'Shared campaign tracking was not linked to both coaches';end if;
 if (select count(*) from public.recruiting_campaign_label_tasks where delivery_id=d)<>1 then raise exception 'Idempotent label task missing';end if;
 if (public.recruiting_campaign_preflight(f.campaign,'follow_up_1',owner)#>'{groups,0,send_reasons}') ? 'previous_stage_unsent' then raise exception 'Verified campaign predecessor missing';end if;
end $$;
do $$
declare f record;owner uuid:='47e7c1a9-a806-4f65-b5ed-2b9b124ef337';g jsonb;d uuid;l uuid;n integer;
begin
 select * into f from campaign_fixture;
 g:=public.recruiting_campaign_preflight(f.campaign,'follow_up_1',owner)#>'{groups,0}';
 perform public.save_recruiting_campaign_draft(f.campaign,f.ids[1],'follow_up_1','Fixture follow-up','Approved follow-up',now()+interval '20 days',g->>'source_key',true);
 g:=public.recruiting_campaign_preflight(f.campaign,'follow_up_1',owner)#>'{groups,0}';
 select id into d from public.schedule_recruiting_campaign(owner,f.campaign,'follow_up_1',jsonb_build_array(jsonb_build_object('source_key',g->>'source_key','school_timezone','America/New_York')));
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
 insert into public.recruiting_inbound_leads(owner_user_id,request_id,coach_name,coach_email,inquiry_type,message_body,source_url,lead_status)
 values(owner,gen_random_uuid()::text,'Fixture Coach','campaign-fixture@example.invalid','recruiting','Rollback inquiry fixture','https://fujitame.github.io/profile/','new') returning id into l;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
 if (select status from public.recruiting_campaign_deliveries where id=d)<>'cancelled' then raise exception 'Unlinked email inquiry did not stop school reservation';end if;
 update public.recruiting_inbound_leads set lead_status='dismissed' where id=l;
 if (select status from public.recruiting_campaign_deliveries where id=d)<>'cancelled' then raise exception 'A dismissed inquiry restarted cancelled mail';end if;
 update public.recruiting_campaign_deliveries set status='processing',cancel_requested=false,processing_started_at=now()-interval '20 minutes',transport_started_at=now()-interval '19 minutes' where id=d;
 select count(*) into n from public.claim_recruiting_campaign_delivery();if n<>0 then raise exception 'Interrupted transport was claimed for retry';end if;
 if (select status from public.recruiting_campaign_deliveries where id=d)<>'send_unknown' then raise exception 'Interrupted transport was not held as unknown';end if;
 if not exists(select 1 from public.recruiting_campaign_issues where delivery_id=d and kind='send_unknown' and status='open') then raise exception 'Interrupted transport issue was not persisted';end if;
end $$;
grant select on campaign_fixture to authenticated;
set local role authenticated;
do $$ declare p uuid; begin
 select campaign into p from campaign_fixture;
 if (select count(*) from public.recruiting_campaign_deliveries where campaign_id=p)<>3 then raise exception 'Owner read failed';end if;
 begin perform public.schedule_recruiting_campaign(auth.uid(),p,'initial','[]'::jsonb);raise exception 'Authenticated schedule accepted';exception when insufficient_privilege then null;end;
 begin perform public.schedule_recruiting_followup_batch(current_date+20,'10:00','[]'::jsonb,'production');raise exception 'Legacy production RPC accepted';exception when raise_exception then if position('活動状況・送信準備' in sqlerrm)=0 then raise;end if;end;
 begin insert into public.recruiting_followup_batch_items(owner_user_id) values(auth.uid());raise exception 'Direct legacy production write accepted';exception when insufficient_privilege then null;end;
 begin perform public.claim_recruiting_campaign_delivery();raise exception 'Authenticated worker call accepted';exception when insufficient_privilege then null;end;
 begin insert into public.recruiting_campaign_execution(campaign_id,owner_user_id) values(gen_random_uuid(),auth.uid());raise exception 'Authenticated activation accepted';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
 if exists(select 1 from public.recruiting_campaign_deliveries where campaign_id=p) then raise exception 'Foreign delivery visible';end if;
 begin perform public.recruiting_campaign_preflight(p,'initial','47e7c1a9-a806-4f65-b5ed-2b9b124ef337');raise exception 'Foreign owner preflight accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role anon;
do $$begin begin perform public.recruiting_campaign_preflight(gen_random_uuid(),'initial');raise exception 'Anonymous preflight accepted';exception when insufficient_privilege then null;end;end $$;
reset role;
select 'PASS: shared grouping; lifetime counter isolation; atomic shared save; stale conflict; approval gate; reserved draft freeze; school-wide reply cancellation; campaign FU predecessor; unlinked inquiry stop; interrupted transport not retried; idempotent shared finalize; preserved counters; owner/foreign/anonymous RLS; legacy and service-only scheduling/worker' as result;
rollback;
