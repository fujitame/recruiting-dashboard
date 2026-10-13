-- Normalize at the DB boundary as well as in sender code.
drop index public.recruiting_email_tracking_recipient_stage_idx;
create unique index recruiting_email_tracking_recipient_stage_idx
on public.recruiting_email_tracking(owner_user_id,university_id,lower(trim(recipient_email)),stage)
where not is_test and stage in ('follow_up_1','follow_up_2');
