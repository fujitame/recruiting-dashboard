-- Phase 5-E: Follow-up Management
-- Follow-up is coach/contact-level. Dashboard STATUS remains school-level.
alter table public.recruiting_contacts
  add column if not exists follow_up_count integer not null default 0 check (follow_up_count >= 0),
  add column if not exists last_follow_up_at timestamptz,
  add column if not exists auto_follow_up_enabled boolean not null default true;

alter table public.recruiting_contact_history
  add column if not exists gmail_message_id text,
  add column if not exists gmail_message_at timestamptz;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid='public.recruiting_contact_history'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) like '%event_type%'
  ) then
    execute format('alter table public.recruiting_contact_history drop constraint %I',
      (select conname from pg_constraint where conrelid='public.recruiting_contact_history'::regclass and contype='c' and pg_get_constraintdef(oid) like '%event_type%' limit 1));
  end if;
  alter table public.recruiting_contact_history
    add constraint recruiting_contact_history_event_type_check
    check (event_type in (
      'contact_created','note','contact_logged','status_changed',
      'follow_up_set','follow_up_sent','visit_camp_updated','reply_received'
    ));
end $$;

create index if not exists recruiting_contacts_owner_follow_up_due_idx
  on public.recruiting_contacts(owner_user_id, follow_up_date)
  where follow_up_date is not null and contact_status not in ('closed','not_a_fit');

create unique index if not exists recruiting_contact_history_owner_gmail_message_unique
  on public.recruiting_contact_history(owner_user_id, gmail_message_id)
  where gmail_message_id is not null;
