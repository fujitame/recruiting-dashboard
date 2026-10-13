-- Signals are not proof of reading. No IP address, user agent or email body is stored.
create table public.recruiting_email_tracking (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 contact_id uuid not null references public.recruiting_contacts(id) on delete cascade,
 reservation_item_id uuid unique references public.recruiting_followup_batch_items(id) on delete set null,
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 stage text not null check(stage in('follow_up_1','follow_up_2','conversation_follow_up')),
 is_test boolean not null default false,
 status text not null default 'prepared' check(status in('prepared','sent','send_unknown')),
 gmail_message_id text,
 sent_at timestamptz,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '120 days',
 first_open_at timestamptz, last_open_at timestamptz, open_signals integer not null default 0,
 first_profile_at timestamptz, last_profile_at timestamptz, profile_signals integer not null default 0,
 first_automated_profile_at timestamptz, last_automated_profile_at timestamptz, automated_profile_signals integer not null default 0
);
create index recruiting_email_tracking_owner_contact_idx on public.recruiting_email_tracking(owner_user_id,contact_id,created_at desc);
create index recruiting_email_tracking_contact_idx on public.recruiting_email_tracking(contact_id);
create unique index recruiting_email_tracking_pending_contact_idx on public.recruiting_email_tracking(contact_id) where status in('prepared','send_unknown');
alter table public.recruiting_email_tracking enable row level security;
create policy recruiting_email_tracking_owner_read on public.recruiting_email_tracking for select to authenticated using(owner_user_id=(select auth.uid()));
revoke all on public.recruiting_email_tracking from public,anon,authenticated;
grant select on public.recruiting_email_tracking to authenticated;
grant all on public.recruiting_email_tracking to service_role;

-- Only the server endpoint can record signals. Ten-minute coalescing bounds repeated writes.
create function public.record_recruiting_email_signal(p_token_hash text,p_event text,p_automated boolean default false)
returns boolean language plpgsql security invoker set search_path=public,pg_catalog as $$
declare n integer;
begin
 if p_token_hash is null or p_event is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_event not in('open','profile') then return false; end if;
 if p_event='open' then
  update public.recruiting_email_tracking set first_open_at=coalesce(first_open_at,now()),last_open_at=now(),open_signals=least(open_signals+1,1000)
   where token_hash=p_token_hash and expires_at>now() and (last_open_at is null or last_open_at<now()-interval '10 minutes');
 elsif p_automated then
  update public.recruiting_email_tracking set first_automated_profile_at=coalesce(first_automated_profile_at,now()),last_automated_profile_at=now(),automated_profile_signals=least(automated_profile_signals+1,1000)
   where token_hash=p_token_hash and expires_at>now() and (last_automated_profile_at is null or last_automated_profile_at<now()-interval '10 minutes');
 else
  update public.recruiting_email_tracking set first_profile_at=coalesce(first_profile_at,now()),last_profile_at=now(),profile_signals=least(profile_signals+1,1000)
   where token_hash=p_token_hash and expires_at>now() and (last_profile_at is null or last_profile_at<now()-interval '10 minutes');
 end if;
 get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.record_recruiting_email_signal(text,text,boolean) from public,anon,authenticated;
grant execute on function public.record_recruiting_email_signal(text,text,boolean) to service_role;
