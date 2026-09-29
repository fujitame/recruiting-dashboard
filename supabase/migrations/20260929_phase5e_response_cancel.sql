-- Phase 5-E: cancel scheduled follow-up when a coach reply changes CRM status to responded
create or replace function public.cancel_follow_up_on_response()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.contact_status = 'responded' then
    new.follow_up_date = null;
    new.next_action = coalesce(nullif(new.next_action, ''), '返信内容を確認');
  end if;
  return new;
end;
$$;

drop trigger if exists phase5e_cancel_follow_up_on_response on public.recruiting_contacts;
create trigger phase5e_cancel_follow_up_on_response
before update on public.recruiting_contacts
for each row
execute function public.cancel_follow_up_on_response();
