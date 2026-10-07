-- Production batch Follow-up scheduling. Test universities (900+) are excluded.
create table if not exists public.recruiting_followup_batches (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'scheduled'
    check (status in ('scheduled','complete','partial','cancelled')),
  local_date date not null,
  local_time time not null,
  item_count integer not null check (item_count between 1 and 67),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null default now()
);

create table if not exists public.recruiting_followup_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recruiting_followup_batches(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.recruiting_contacts(id) on delete cascade,
  university_id integer not null,
  expected_follow_up_count integer not null check (expected_follow_up_count between 0 and 1),
  recipient_email text not null,
  expected_last_message_id text not null,
  subject text not null check (char_length(trim(subject)) between 1 and 180),
  body text not null check (char_length(trim(body)) between 1 and 10000),
  personalization_sentence text not null check (char_length(trim(personalization_sentence)) between 1 and 1000),
  research_ids integer[] not null check (cardinality(research_ids) > 0),
  school_timezone text not null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','processing','sent','skipped_reply','skipped_changed','send_unknown','cancelled')),
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  sent_at timestamptz,
  gmail_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists recruiting_followup_batch_items_due_idx
  on public.recruiting_followup_batch_items(scheduled_at)
  where status = 'scheduled';
create index if not exists recruiting_followup_batch_items_batch_idx
  on public.recruiting_followup_batch_items(batch_id, status);
create unique index if not exists recruiting_followup_batch_contact_pending_unique
  on public.recruiting_followup_batch_items(contact_id)
  where status in ('scheduled','processing','send_unknown');

alter table public.recruiting_followup_batches enable row level security;
alter table public.recruiting_followup_batch_items enable row level security;

drop policy if exists recruiting_followup_batches_select_own on public.recruiting_followup_batches;
create policy recruiting_followup_batches_select_own
  on public.recruiting_followup_batches for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists recruiting_followup_items_select_own on public.recruiting_followup_batch_items;
create policy recruiting_followup_items_select_own
  on public.recruiting_followup_batch_items for select to authenticated
  using (owner_user_id = auth.uid());

-- The authenticated owner can only schedule their own eligible, production contacts.
create or replace function public.schedule_recruiting_followup_batch(
  p_local_date date,
  p_local_time time,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_batch_id uuid;
  v_item jsonb;
  v_contact public.recruiting_contacts%rowtype;
  v_contact_id uuid;
  v_scheduled_at timestamptz;
  v_timezone text;
  v_sentence text;
  v_ids integer[];
  v_inserted integer := 0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_local_date is null or p_local_time is null then raise exception 'A local date and time are required'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 67 then
    raise exception 'Choose between 1 and 67 contacts';
  end if;

  insert into public.recruiting_followup_batches(owner_user_id, local_date, local_time, item_count)
  values (v_owner, p_local_date, p_local_time, jsonb_array_length(p_items))
  returning id into v_batch_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_contact_id := (v_item->>'contact_id')::uuid;
    v_scheduled_at := (v_item->>'scheduled_at')::timestamptz;
    v_timezone := trim(v_item->>'school_timezone');
    v_sentence := trim(v_item->>'personalization_sentence');
    select array_agg(x::integer) into v_ids
    from jsonb_array_elements_text(coalesce(v_item->'research_ids','[]'::jsonb)) x
    where x ~ '^[0-9]+$';

    if v_scheduled_at is null or v_scheduled_at <= now() + interval '2 minutes' then
      raise exception 'Selected school time must be at least 2 minutes in the future';
    end if;
    if v_timezone is null or not exists (select 1 from pg_timezone_names where name = v_timezone) then
      raise exception 'Invalid school time zone';
    end if;
    if (v_scheduled_at at time zone v_timezone)::date <> p_local_date
      or to_char(v_scheduled_at at time zone v_timezone, 'HH24:MI') <> to_char(p_local_time, 'HH24:MI') then
      raise exception 'Scheduled instant does not match the selected school-local date and time';
    end if;
    if v_sentence is null or v_sentence = '' or coalesce(cardinality(v_ids),0) = 0 then
      raise exception 'Every scheduled item needs a school-specific verified Research fact';
    end if;
    if length(trim(v_item->>'subject')) > 180 or length(trim(v_item->>'body')) > 10000 then
      raise exception 'Subject or body is too long';
    end if;
    if position(v_sentence in coalesce(v_item->>'body','')) = 0 then
      raise exception 'The approved personalization sentence must remain in the email body';
    end if;

    select * into v_contact
    from public.recruiting_contacts
    where id = v_contact_id and owner_user_id = v_owner
    for update;

    if not found then raise exception 'A selected CRM contact is unavailable'; end if;
    if v_contact.university_id >= 900 or not exists (
      select 1 from public.recruiting_universities u
      where u.id = v_contact.university_id and u.is_test = false
    ) then
      raise exception 'Test or unverified schools cannot be scheduled for production sending';
    end if;
    if v_contact.contact_status not in ('contacted','follow_up_due')
      or v_contact.follow_up_count not between 0 and 1
      or nullif(trim(coalesce(v_contact.coach_email,'')),'') is null
      or nullif(trim(coalesce(v_contact.gmail_thread_id,'')),'') is null
      or nullif(trim(coalesce(v_contact.coach_response,'')),'') is not null
      or (v_contact.follow_up_date is null)
      or v_contact.follow_up_date > p_local_date then
      raise exception 'A selected contact is not eligible for a no-reply Follow-up at the chosen local date';
    end if;

    insert into public.recruiting_followup_batch_items(
      batch_id, owner_user_id, contact_id, university_id, expected_follow_up_count,
      recipient_email, expected_last_message_id, subject, body, personalization_sentence, research_ids, school_timezone, scheduled_at
    ) values (
      v_batch_id, v_owner, v_contact.id, v_contact.university_id, v_contact.follow_up_count,
      lower(trim(v_contact.coach_email)), trim(v_item->>'expected_last_message_id'), trim(v_item->>'subject'), v_item->>'body', v_sentence, v_ids, v_timezone, v_scheduled_at
    );

    update public.recruiting_contacts
      set auto_follow_up_enabled = false,
          next_action = 'Follow-up一括予約済み — ' || p_local_date::text || ' ' || to_char(p_local_time, 'HH24:MI') || ' (' || v_timezone || ')'
      where id = v_contact.id and owner_user_id = v_owner;

    insert into public.recruiting_contact_history(owner_user_id, contact_id, event_type, event_at, note)
      values (v_owner, v_contact.id, 'follow_up_set', now(),
        '確認済みFollow-up一括予約: ' || p_local_date::text || ' ' || to_char(p_local_time, 'HH24:MI') || ' (' || v_timezone || ')');

    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted <> jsonb_array_length(p_items) then raise exception 'Not all contacts were scheduled'; end if;
  return v_batch_id;
end;
$$;

revoke all on function public.schedule_recruiting_followup_batch(date,time,jsonb) from public, anon;
grant execute on function public.schedule_recruiting_followup_batch(date,time,jsonb) to authenticated;

-- The worker claims due items atomically so concurrent invocations cannot double-send.
create or replace function public.claim_due_recruiting_followup_batch_items(p_limit integer default 10)
returns setof public.recruiting_followup_batch_items
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;

  -- A terminated worker is never retried automatically because Gmail may have accepted the send.
  update public.recruiting_followup_batch_items
    set status = 'send_unknown',
        error_message = 'Worker timed out; verify Gmail manually before taking action'
    where status = 'processing'
      and processing_started_at < now() - interval '15 minutes';

  update public.recruiting_followup_batches b
    set status = 'partial'
    where b.status = 'scheduled'
      and exists (select 1 from public.recruiting_followup_batch_items i where i.batch_id = b.id and i.status = 'send_unknown');

  return query
  with due as (
    select i.id
    from public.recruiting_followup_batch_items i
    join public.recruiting_followup_batches b on b.id = i.batch_id
    where i.status = 'scheduled'
      and i.scheduled_at <= now()
      and b.status = 'scheduled'
    order by i.scheduled_at, i.created_at
    for update of i skip locked
    limit greatest(1, least(coalesce(p_limit,10), 20))
  )
  update public.recruiting_followup_batch_items i
    set status = 'processing',
        processing_started_at = now(),
        attempt_count = attempt_count + 1
  from due
  where i.id = due.id
  returning i.*;
end;
$$;

revoke all on function public.claim_due_recruiting_followup_batch_items(integer) from public, anon, authenticated;
grant execute on function public.claim_due_recruiting_followup_batch_items(integer) to service_role;

create or replace function public.cancel_recruiting_followup_batch(p_batch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer;
  v_contact record;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.recruiting_followup_batches
    where id = p_batch_id and owner_user_id = v_owner and status = 'scheduled'
  ) then raise exception 'Batch is not cancellable'; end if;

  for v_contact in
    select c.id, c.owner_user_id
    from public.recruiting_followup_batch_items i
    join public.recruiting_contacts c on c.id = i.contact_id
    where i.batch_id = p_batch_id and i.owner_user_id = v_owner and i.status = 'scheduled'
    for update of c
  loop
    update public.recruiting_contacts
      set next_action = 'Follow-up一括予約を取消 — 内容を再確認'
      where id = v_contact.id and owner_user_id = v_owner;
    insert into public.recruiting_contact_history(owner_user_id, contact_id, event_type, event_at, note)
      values (v_owner, v_contact.id, 'follow_up_set', now(), 'Follow-up一括予約をユーザーが取消');
  end loop;

  update public.recruiting_followup_batch_items
    set status = 'cancelled'
    where batch_id = p_batch_id and owner_user_id = v_owner and status = 'scheduled';
  get diagnostics v_count = row_count;

  update public.recruiting_followup_batches
    set status = 'cancelled'
    where id = p_batch_id and owner_user_id = v_owner;
  return v_count;
end;
$$;

revoke all on function public.cancel_recruiting_followup_batch(uuid) from public, anon;
grant execute on function public.cancel_recruiting_followup_batch(uuid) to authenticated;

grant select on public.recruiting_followup_batches, public.recruiting_followup_batch_items to authenticated;
grant all on public.recruiting_followup_batches, public.recruiting_followup_batch_items to service_role;
