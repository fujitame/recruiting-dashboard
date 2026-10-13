-- A confirmed or uncertain regular stage cannot be sent again if a later CRM write failed.
-- Test fixtures may be exercised repeatedly and are excluded from this production guard.
create unique index recruiting_email_tracking_regular_stage_idx
 on public.recruiting_email_tracking(contact_id,stage)
 where not is_test and stage in('follow_up_1','follow_up_2');
