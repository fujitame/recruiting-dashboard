-- Phase 7-A: Reserve university ID range for production and test data
--
-- Production universities: 1-899
-- Test-only universities: 900-999
--
-- This migration only expands the allowed university_id range.
-- Existing recruiting_contacts rows are not modified.

alter table public.recruiting_contacts
drop constraint if exists recruiting_contacts_university_id_check;

alter table public.recruiting_contacts
add constraint recruiting_contacts_university_id_check
check (university_id between 1 and 999);
