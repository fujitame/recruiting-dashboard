-- Phase 5-F: automatic reply interest detection
alter table public.recruiting_contacts
  add column if not exists interest_level text not null default 'unknown',
  add column if not exists interest_reason text,
  add column if not exists interest_analyzed_at timestamptz;

do $$
begin
  alter table public.recruiting_contacts
    drop constraint if exists recruiting_contacts_interest_level_check;
  alter table public.recruiting_contacts
    add constraint recruiting_contacts_interest_level_check
    check (interest_level in ('unknown','low','medium','high'));
exception when duplicate_object then null;
end $$;

create index if not exists recruiting_contacts_interest_level_idx
  on public.recruiting_contacts(owner_user_id, interest_level);
