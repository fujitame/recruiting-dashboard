-- Phase 5-D: Gmail reply detection support
do $$
declare
  existing_constraint text;
begin
  if to_regclass('public.recruiting_contact_history') is null then
    raise exception 'Phase 5-D requires public.recruiting_contact_history from Phase 5-A';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='recruiting_contact_history' and column_name='gmail_message_id'
  ) then
    alter table public.recruiting_contact_history add column gmail_message_id text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='recruiting_contact_history' and column_name='gmail_message_at'
  ) then
    alter table public.recruiting_contact_history add column gmail_message_at timestamptz;
  end if;

  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname='public'
    and rel.relname='recruiting_contact_history'
    and con.contype='c'
    and pg_get_constraintdef(con.oid) like '%event_type%';

  if existing_constraint is not null then
    execute format('alter table public.recruiting_contact_history drop constraint %I', existing_constraint);
  end if;

  alter table public.recruiting_contact_history
    add constraint recruiting_contact_history_event_type_check
    check (event_type in (
      'contact_created','note','contact_logged','status_changed',
      'follow_up_set','visit_camp_updated','reply_received'
    ));

  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='recruiting_contact_history_owner_gmail_message_unique'
  ) then
    create unique index recruiting_contact_history_owner_gmail_message_unique
      on public.recruiting_contact_history(owner_user_id, gmail_message_id)
      where gmail_message_id is not null;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='recruiting_contacts_owner_thread_idx'
  ) then
    create index recruiting_contacts_owner_thread_idx
      on public.recruiting_contacts(owner_user_id, gmail_thread_id)
      where gmail_thread_id is not null;
  end if;
end $$;
