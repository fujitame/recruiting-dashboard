-- One-time, human-reviewed Follow-up batches.
create table if not exists public.recruiting_followup_batches (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'approved'
    check (status in ('approved', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  approved_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.recruiting_followup_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recruiting_followup_batches(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.recruiting_contacts(id) on delete cascade,
  university_id integer not null references public.recruiting_universities(id) on delete cascade,
  follow_up_number smallint not null check (follow_up_number = 1),
  scheduled_at timestamptz not null,
  timezone text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  research_ids integer[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  outcome_note text,
  constraint recruiting_followup_batch_unique_contact unique (batch_id, contact_id)
);

create index if not exists recruiting_followup_batch_due_idx
  on public.recruiting_followup_batch_items(status, scheduled_at)
  where status = 'pending';

create index if not exists recruiting_followup_batch_owner_idx
  on public.recruiting_followup_batch_items(owner_user_id, created_at desc);

alter table public.recruiting_followup_batches enable row level security;
alter table public.recruiting_followup_batch_items enable row level security;

drop policy if exists recruiting_followup_batches_select_own
  on public.recruiting_followup_batches;
create policy recruiting_followup_batches_select_own
  on public.recruiting_followup_batches for select
  to authenticated using (owner_user_id = auth.uid());

drop policy if exists recruiting_followup_batches_insert_own
  on public.recruiting_followup_batches;
create policy recruiting_followup_batches_insert_own
  on public.recruiting_followup_batches for insert
  to authenticated with check (owner_user_id = auth.uid() and status = 'approved');

drop policy if exists recruiting_followup_items_select_own
  on public.recruiting_followup_batch_items;
create policy recruiting_followup_items_select_own
  on public.recruiting_followup_batch_items for select
  to authenticated using (owner_user_id = auth.uid());

drop policy if exists recruiting_followup_items_insert_own
  on public.recruiting_followup_batch_items;
create policy recruiting_followup_items_insert_own
  on public.recruiting_followup_batch_items for insert
  to authenticated with check (
    owner_user_id = auth.uid()
    and status = 'pending'
    and follow_up_number = 1
    and exists (
      select 1 from public.recruiting_followup_batches b
      where b.id = batch_id and b.owner_user_id = auth.uid()
    )
  );

create or replace function public.cancel_recruiting_followup_batch(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner
  from public.recruiting_followup_batches
  where id = p_batch_id
  for update;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Batch not found';
  end if;

  update public.recruiting_followup_batches
  set status = 'cancelled'
  where id = p_batch_id and status = 'approved';

  if not found then
    return false;
  end if;

  update public.recruiting_followup_batch_items
  set status = 'cancelled', completed_at = now(), outcome_note = 'Cancelled by owner'
  where batch_id = p_batch_id and status = 'pending';

  return true;
end;
$$;

revoke all on function public.cancel_recruiting_followup_batch(uuid) from public;
grant execute on function public.cancel_recruiting_followup_batch(uuid) to authenticated;

create or replace function public.claim_due_recruiting_followup_batch_items(p_limit integer default 10)
returns setof public.recruiting_followup_batch_items
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select i.id
    from public.recruiting_followup_batch_items i
    join public.recruiting_followup_batches b on b.id = i.batch_id
    where i.status = 'pending'
      and i.scheduled_at <= now()
      and b.status = 'approved'
    order by i.scheduled_at, i.created_at
    for update of i skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.recruiting_followup_batch_items i
  set status = 'sending', attempted_at = now()
  from picked
  where i.id = picked.id
  returning i.*;
end;
$$;

revoke all on function public.claim_due_recruiting_followup_batch_items(integer) from public, anon, authenticated;
grant execute on function public.claim_due_recruiting_followup_batch_items(integer) to service_role;


create or replace function public.guard_recruiting_followup_batch_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.recruiting_contacts c
    join public.recruiting_followup_batches b on b.id = new.batch_id
    join public.recruiting_universities u on u.id = c.university_id
    where c.id = new.contact_id
      and c.university_id = new.university_id
      and c.owner_user_id = new.owner_user_id
      and b.owner_user_id = new.owner_user_id
      and lower(trim(c.coach_email)) = lower(trim(new.to_email))
      and c.gmail_thread_id is not null
      and c.follow_up_count = 0
      and c.contact_status in ('contacted', 'follow_up_due')
      and nullif(trim(coalesce(c.coach_response, '')), '') is null
      and coalesce(u.is_test, false) = false
      and u.id not between 900 and 999
  ) then
    raise exception 'Contact is not eligible for a reviewed Follow-up #1 batch';
  end if;
  return new;
end;
$$;

drop trigger if exists recruiting_followup_batch_item_guard
  on public.recruiting_followup_batch_items;
create trigger recruiting_followup_batch_item_guard
  before insert on public.recruiting_followup_batch_items
  for each row execute function public.guard_recruiting_followup_batch_item();

revoke all on function public.guard_recruiting_followup_batch_item() from public, anon, authenticated;
