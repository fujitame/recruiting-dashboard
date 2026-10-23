CREATE OR REPLACE FUNCTION public.finalize_recruiting_initial_job(p_job_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE j public.recruiting_initial_email_jobs; t public.recruiting_email_tracking; n integer; c public.recruiting_contacts; next_date date;
BEGIN
 SELECT * INTO j FROM public.recruiting_initial_email_jobs WHERE id=p_job_id FOR UPDATE;
 IF j.id IS NULL OR j.status<>'processing' OR j.gmail_message_id IS NULL OR j.sent_at IS NULL THEN RAISE EXCEPTION 'Job not ready for finalization'; END IF;
 SELECT * INTO t FROM public.recruiting_email_tracking WHERE id=j.tracking_id AND stage='initial' AND status='sent' AND gmail_message_id=j.gmail_message_id AND owner_user_id=j.owner_user_id AND contact_id=j.contact_id;
 IF t.id IS NULL THEN RAISE EXCEPTION 'Verified tracking record missing'; END IF;
 PERFORM 1 FROM public.recruiting_contacts WHERE id=ANY(j.contact_ids) ORDER BY id FOR UPDATE;
 SELECT count(*) INTO n FROM public.recruiting_contacts WHERE id=ANY(j.contact_ids) AND owner_user_id=j.owner_user_id AND university_id=j.university_id AND lower(btrim(coach_email))=j.recipient_email AND contact_status='not_contacted' AND contact_count=0 AND gmail_thread_id IS NULL AND coalesce(coach_response,'')='';
 IF n<>cardinality(j.contact_ids) THEN RAISE EXCEPTION 'CRM changed after send; manual reconciliation required'; END IF;
 next_date:=((j.sent_at AT TIME ZONE j.school_timezone)::date+7);
 UPDATE public.recruiting_contacts SET contact_status='contacted',last_contact_at=j.sent_at,contact_count=1,follow_up_count=0,last_follow_up_at=NULL,follow_up_date=next_date,auto_follow_up_enabled=true,next_action='次回フォローアップメール送信',gmail_thread_id=j.gmail_thread_id,updated_at=now() WHERE id=ANY(j.contact_ids);
 FOR c IN SELECT * FROM public.recruiting_contacts WHERE id=ANY(j.contact_ids) LOOP
  INSERT INTO public.recruiting_contact_history(owner_user_id,contact_id,event_type,event_at,note,from_status,to_status,gmail_message_id,gmail_message_at)
  VALUES(j.owner_user_id,c.id,'contact_logged',j.sent_at,CASE WHEN c.id=j.contact_id THEN '初回メール予約送信: '||j.subject ELSE '共通アドレス宛てにHC名で初回メール1通を送信。追加送信なし: '||j.subject END,'not_contacted','contacted',CASE WHEN c.id=j.contact_id THEN j.gmail_message_id ELSE NULL END,j.sent_at);
 END LOOP;
 UPDATE public.recruiting_records SET content=jsonb_set(coalesce(content,'{}'::jsonb),'{favs}',
  (SELECT coalesce(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(coalesce(content->'favs','[]'::jsonb)||jsonb_build_array(j.university_id))),true),updated_at=now()
 WHERE id='akihiro_dashboard' AND owner_user_id=j.owner_user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard favorites record unavailable; reconcile verified send'; END IF;
 UPDATE public.recruiting_initial_email_jobs SET status='sent',error_message=NULL WHERE id=j.id;
 RETURN true;
END $function$;


CREATE OR REPLACE FUNCTION public.save_recruiting_dashboard_preferences(p_content jsonb,p_base_favs jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE r public.recruiting_records; merged jsonb; final_favs jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF jsonb_typeof(p_content)<>'object' OR jsonb_typeof(p_content->'favs')<>'array' OR jsonb_typeof(p_base_favs)<>'array' THEN RAISE EXCEPTION 'Invalid favorite preferences';END IF;
 SELECT * INTO r FROM public.recruiting_records WHERE id='akihiro_dashboard' AND owner_user_id=auth.uid() FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Dashboard preferences unavailable'; END IF;
 WITH latest AS(SELECT value FROM jsonb_array_elements(coalesce(r.content->'favs','[]'::jsonb))),
 adds AS(SELECT value FROM jsonb_array_elements(p_content->'favs') EXCEPT SELECT value FROM jsonb_array_elements(p_base_favs)),
 removals AS(SELECT value FROM jsonb_array_elements(p_base_favs) EXCEPT SELECT value FROM jsonb_array_elements(p_content->'favs')),
 retained AS((SELECT value FROM latest UNION SELECT value FROM adds) EXCEPT SELECT value FROM removals)
 SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO final_favs FROM retained;
 merged:=coalesce(r.content,'{}'::jsonb)||p_content||jsonb_build_object('favs',final_favs);
 UPDATE public.recruiting_records SET content=merged,updated_at=now() WHERE id=r.id AND owner_user_id=auth.uid();
 RETURN merged;
END $$;
REVOKE ALL ON FUNCTION public.save_recruiting_dashboard_preferences(jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_recruiting_dashboard_preferences(jsonb,jsonb) TO authenticated;
