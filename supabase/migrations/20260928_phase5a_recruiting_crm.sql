-- Phase 5-A: Recruiting CRM data structure
do $$
begin
  if to_regclass('public.recruiting_contacts') is not null then raise exception 'Phase 5-A collision: recruiting_contacts already exists'; end if;
  if to_regclass('public.recruiting_contact_history') is not null then raise exception 'Phase 5-A collision: recruiting_contact_history already exists'; end if;
  if exists (select 1 from pg_policies where schemaname='public' and policyname in ('phase5a_contacts_select_own','phase5a_contacts_insert_own','phase5a_contacts_update_own','phase5a_contacts_delete_own','phase5a_contact_history_select_own','phase5a_contact_history_insert_own')) then raise exception 'Phase 5-A collision: policy name already exists'; end if;
  if exists (select 1 from pg_proc where pronamespace='public'::regnamespace and proname='set_recruiting_contacts_updated_at') then raise exception 'Phase 5-A collision: trigger function already exists'; end if;
  if exists (select 1 from pg_class where relname in ('recruiting_contacts_owner_university_idx','recruiting_contacts_owner_status_follow_up_idx','recruiting_contact_history_contact_event_idx')) then raise exception 'Phase 5-A collision: index name already exists'; end if;
end $$;

create table public.recruiting_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  university_id integer not null check (university_id between 1 and 67),
  coach_role text not null check (coach_role in ('head_coach','assistant_coach','other')),
  coach_key text not null,
  coach_name text not null check (char_length(trim(coach_name)) > 0),
  coach_email text,
  contact_status text not null default 'not_contacted' check (contact_status in ('not_contacted','draft_ready','contacted','follow_up_due','responded','no_response','not_a_fit','closed')),
  last_contact_at timestamptz,
  next_action text,
  follow_up_date date,
  contact_count integer not null default 0 check (contact_count >= 0),
  coach_response text,
  visit_camp text,
  gmail_thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruiting_contacts_owner_university_coach_key_unique unique (owner_user_id, university_id, coach_key)
);

create table public.recruiting_contact_history (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.recruiting_contacts(id) on delete cascade,
  event_type text not null check (event_type in ('contact_created','note','contact_logged','status_changed','follow_up_set','visit_camp_updated')),
  event_at timestamptz not null default now(),
  note text,
  from_status text,
  to_status text,
  created_at timestamptz not null default now()
);

create index recruiting_contacts_owner_university_idx on public.recruiting_contacts(owner_user_id, university_id);
create index recruiting_contacts_owner_status_follow_up_idx on public.recruiting_contacts(owner_user_id, contact_status, follow_up_date) where follow_up_date is not null;
create index recruiting_contact_history_contact_event_idx on public.recruiting_contact_history(contact_id, event_at desc);

create function public.set_recruiting_contacts_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger phase5a_recruiting_contacts_set_updated_at before update on public.recruiting_contacts for each row execute function public.set_recruiting_contacts_updated_at();

alter table public.recruiting_contacts enable row level security;
alter table public.recruiting_contact_history enable row level security;
create policy "phase5a_contacts_select_own" on public.recruiting_contacts for select to authenticated using (owner_user_id = auth.uid());
create policy "phase5a_contacts_insert_own" on public.recruiting_contacts for insert to authenticated with check (owner_user_id = auth.uid());
create policy "phase5a_contacts_update_own" on public.recruiting_contacts for update to authenticated using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "phase5a_contacts_delete_own" on public.recruiting_contacts for delete to authenticated using (owner_user_id = auth.uid());
create policy "phase5a_contact_history_select_own" on public.recruiting_contact_history for select to authenticated using (owner_user_id = auth.uid());
create policy "phase5a_contact_history_insert_own" on public.recruiting_contact_history for insert to authenticated with check (owner_user_id = auth.uid() and exists (select 1 from public.recruiting_contacts c where c.id = contact_id and c.owner_user_id = auth.uid()));
