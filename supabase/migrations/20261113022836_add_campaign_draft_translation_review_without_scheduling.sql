-- Draft review only: no queue, Gmail, history, schedule or execution changes.
create table public.recruiting_campaign_draft_reviews (
 message_id uuid primary key references public.recruiting_campaign_messages(id),
 owner_user_id uuid not null references auth.users(id),
 source_subject text not null default '', source_body text not null default '',
 subject_ja text not null default '', body_ja text not null default '',
 reviewed boolean not null default false,
 sources jsonb not null default '[]' check(jsonb_typeof(sources)='array'),
 note text not null default '', revision bigint not null default 1,
 updated_at timestamptz not null default now()
);
alter table public.recruiting_campaign_draft_reviews enable row level security;
revoke all on public.recruiting_campaign_draft_reviews from public,anon,authenticated;
grant select,insert,update on public.recruiting_campaign_draft_reviews to authenticated;
grant all on public.recruiting_campaign_draft_reviews to service_role;
create policy draft_review_owner_read on public.recruiting_campaign_draft_reviews for select to authenticated using(owner_user_id=(select auth.uid()));
create policy draft_review_owner_insert on public.recruiting_campaign_draft_reviews for insert to authenticated with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_campaign_messages m where m.id=message_id and m.owner_user_id=(select auth.uid())));
create policy draft_review_owner_update on public.recruiting_campaign_draft_reviews for update to authenticated using(owner_user_id=(select auth.uid())) with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_campaign_messages m where m.id=message_id and m.owner_user_id=(select auth.uid())));
create index campaign_review_owner on public.recruiting_campaign_draft_reviews(owner_user_id);

create function public.save_recruiting_campaign_draft_with_review(
 p_campaign_id uuid,p_contact_id uuid,p_stage text,p_subject text,p_body text,
 p_planned_at timestamptz,p_source_key text,p_apply_shared boolean default false,
 p_review jsonb default '{}'::jsonb,p_review_revisions jsonb default '{}'::jsonb
) returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare g jsonb; ids uuid[]; m public.recruiting_campaign_messages; old_review public.recruiting_campaign_draft_reviews;
 n integer; expected bigint; source_subject text; source_body text; checked boolean;
begin
 if auth.uid() is null then raise exception 'Login required' using errcode='42501';end if;
 perform 1 from public.recruiting_campaigns where id=p_campaign_id and owner_user_id=auth.uid() for update;
 if not found then raise exception 'Campaign unavailable' using errcode='42501';end if;
 select x into g from jsonb_array_elements(public.recruiting_campaign_preflight(p_campaign_id,p_stage)->'groups') x where (x->'contact_ids') ? p_contact_id::text;
 if g is null then raise exception 'Contact unavailable' using errcode='42501';end if;
 if p_apply_shared then select array_agg(value::uuid) into ids from jsonb_array_elements_text(g->'contact_ids');else ids:=array[p_contact_id];end if;
 if jsonb_typeof(p_review)<>'object' or jsonb_typeof(p_review_revisions)<>'object' or length(coalesce(p_review->>'body_ja',''))>100000 or length(coalesce(p_review->>'subject_ja',''))>1000 or jsonb_typeof(coalesce(p_review->'sources','[]'))<>'array' then raise exception 'Invalid review';end if;
 -- Keep the existing recipient/source/reserved-mail checks. Both saves share one transaction.
 n:=public.save_recruiting_campaign_draft(p_campaign_id,p_contact_id,p_stage,p_subject,p_body,p_planned_at,p_source_key,p_apply_shared);
 source_subject:=coalesce(p_review->>'source_subject',p_subject,'');source_body:=coalesce(p_review->>'source_body',p_body,'');
 checked:=coalesce((p_review->>'reviewed')::boolean,false) and source_subject=coalesce(p_subject,'') and source_body=coalesce(p_body,'') and length(btrim(coalesce(p_review->>'subject_ja','')))>0 and length(btrim(coalesce(p_review->>'body_ja','')))>0;
 for m in select * from public.recruiting_campaign_messages where campaign_id=p_campaign_id and owner_user_id=auth.uid() and stage=p_stage and contact_id=any(ids) order by contact_id for update loop
  select * into old_review from public.recruiting_campaign_draft_reviews where message_id=m.id for update;
  expected:=coalesce((p_review_revisions->>m.contact_id::text)::bigint,0);
  if coalesce(old_review.revision,0)<>expected then raise exception 'Translation or review changed; reopen before saving' using errcode='40001';end if;
  insert into public.recruiting_campaign_draft_reviews(message_id,owner_user_id,source_subject,source_body,subject_ja,body_ja,reviewed,sources,note,revision)
  values(m.id,auth.uid(),source_subject,source_body,coalesce(p_review->>'subject_ja',''),coalesce(p_review->>'body_ja',''),checked,coalesce(p_review->'sources','[]'),coalesce(p_review->>'note',''),expected+1)
  on conflict(message_id) do update set source_subject=excluded.source_subject,source_body=excluded.source_body,subject_ja=excluded.subject_ja,body_ja=excluded.body_ja,reviewed=excluded.reviewed,sources=excluded.sources,note=excluded.note,revision=excluded.revision,updated_at=now();
 end loop;
 return n;
end $$;
revoke all on function public.save_recruiting_campaign_draft_with_review(uuid,uuid,text,text,text,timestamptz,text,boolean,jsonb,jsonb) from public,anon;
grant execute on function public.save_recruiting_campaign_draft_with_review(uuid,uuid,text,text,text,timestamptz,text,boolean,jsonb,jsonb) to authenticated,service_role;
