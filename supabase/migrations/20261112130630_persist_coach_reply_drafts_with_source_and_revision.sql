create table public.recruiting_reply_drafts (
 owner_user_id uuid not null references auth.users(id),
 contact_id uuid not null references public.recruiting_contacts(id),
 source_key text not null check(source_key ~ '^[0-9a-f]{64}$'),
 draft jsonb not null check(jsonb_typeof(draft)='object' and octet_length(draft::text)<=500000),
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 primary key(owner_user_id,contact_id,source_key)
);
alter table public.recruiting_reply_drafts enable row level security;
create policy reply_draft_owner on public.recruiting_reply_drafts for all to authenticated
 using(owner_user_id=(select auth.uid()))
 with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.recruiting_contacts c where c.id=recruiting_reply_drafts.contact_id and c.owner_user_id=(select auth.uid())));
grant select,insert,update on public.recruiting_reply_drafts to authenticated;

create function public.save_recruiting_reply_draft(p_contact_id uuid,p_source_key text,p_draft jsonb,p_expected_revision bigint default 0)
returns table(revision bigint,updated_at timestamptz)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_owner uuid:=(select auth.uid());
begin
 if v_owner is null or not exists(select 1 from public.recruiting_contacts c where c.id=p_contact_id and c.owner_user_id=v_owner) then
  raise exception 'Reply draft contact unavailable' using errcode='42501';
 end if;
 return query
 insert into public.recruiting_reply_drafts as d(owner_user_id,contact_id,source_key,draft)
 values(v_owner,p_contact_id,p_source_key,p_draft)
 on conflict(owner_user_id,contact_id,source_key) do update
 set draft=excluded.draft,revision=d.revision+1,updated_at=now()
 where d.revision=p_expected_revision
 returning d.revision,d.updated_at;
 if not found then
  raise exception 'Draft changed in another session; restore the saved draft before saving again' using errcode='40001';
 end if;
end $$;
revoke all on function public.save_recruiting_reply_draft(uuid,text,jsonb,bigint) from public,anon;
grant execute on function public.save_recruiting_reply_draft(uuid,text,jsonb,bigint) to authenticated;
