CREATE TABLE public.recruiting_initial_email_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_key text NOT NULL,
 owner_user_id uuid NOT NULL REFERENCES auth.users(id),
 university_id integer NOT NULL REFERENCES public.recruiting_universities(id),
 contact_id uuid NOT NULL REFERENCES public.recruiting_contacts(id),
 contact_ids uuid[] NOT NULL CHECK(cardinality(contact_ids)>0),
 recipient_email text NOT NULL CHECK(recipient_email=lower(btrim(recipient_email)) AND recipient_email !~ '[\r\n]'),
 recipient_name text NOT NULL,
 subject text NOT NULL CHECK(subject !~ '[\r\n]'),
 body text NOT NULL CHECK(length(btrim(body))>0),
 scheduled_at timestamptz NOT NULL,
 school_timezone text NOT NULL DEFAULT 'America/Los_Angeles',
 source_url text NOT NULL,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN('scheduled','processing','sent','skipped','send_unknown','cancelled')),
 tracking_id uuid REFERENCES public.recruiting_email_tracking(id),
 gmail_message_id text,
 gmail_thread_id text,
 sent_at timestamptz,
 error_message text,
 claimed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,university_id,recipient_email)
);
ALTER TABLE public.recruiting_initial_email_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruiting_initial_email_jobs FROM anon,authenticated;
GRANT SELECT ON public.recruiting_initial_email_jobs TO authenticated;
GRANT ALL ON public.recruiting_initial_email_jobs TO service_role;
CREATE POLICY initial_jobs_owner_read ON public.recruiting_initial_email_jobs FOR SELECT TO authenticated USING((select auth.uid())=owner_user_id);
CREATE INDEX initial_jobs_due_idx ON public.recruiting_initial_email_jobs(scheduled_at) WHERE status='scheduled';
ALTER TABLE public.recruiting_email_tracking DROP CONSTRAINT recruiting_email_tracking_stage_check;
ALTER TABLE public.recruiting_email_tracking ADD CONSTRAINT recruiting_email_tracking_stage_check CHECK(stage IN('initial','follow_up_1','follow_up_2','conversation_follow_up'));
CREATE UNIQUE INDEX recruiting_email_tracking_initial_once ON public.recruiting_email_tracking(contact_id) WHERE stage='initial' AND NOT is_test;
ALTER TABLE public.recruiting_email_tracking
 ADD COLUMN first_youtube_at timestamptz,
 ADD COLUMN last_youtube_at timestamptz,
 ADD COLUMN youtube_signals integer NOT NULL DEFAULT 0,
 ADD COLUMN first_automated_youtube_at timestamptz,
 ADD COLUMN last_automated_youtube_at timestamptz,
 ADD COLUMN automated_youtube_signals integer NOT NULL DEFAULT 0;
CREATE FUNCTION public.record_recruiting_youtube_signal(p_token_hash text,p_automated boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE n integer;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 IF p_automated THEN
  UPDATE public.recruiting_email_tracking SET first_automated_youtube_at=coalesce(first_automated_youtube_at,now()),last_automated_youtube_at=now(),automated_youtube_signals=least(automated_youtube_signals+1,1000)
  WHERE token_hash=p_token_hash AND expires_at>now() AND (last_automated_youtube_at IS NULL OR last_automated_youtube_at<now()-interval '10 minutes');
 ELSE
  UPDATE public.recruiting_email_tracking SET first_youtube_at=coalesce(first_youtube_at,now()),last_youtube_at=now(),youtube_signals=least(youtube_signals+1,1000)
  WHERE token_hash=p_token_hash AND expires_at>now() AND (last_youtube_at IS NULL OR last_youtube_at<now()-interval '10 minutes');
 END IF;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $$;
REVOKE ALL ON FUNCTION public.record_recruiting_youtube_signal(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_recruiting_youtube_signal(text,boolean) TO service_role;
CREATE FUNCTION public.claim_due_recruiting_initial_jobs(p_limit integer DEFAULT 40) RETURNS SETOF public.recruiting_initial_email_jobs
LANGUAGE sql SET search_path=public,pg_catalog AS $$
 UPDATE public.recruiting_initial_email_jobs j SET status='processing',claimed_at=now()
 WHERE j.id IN(SELECT id FROM public.recruiting_initial_email_jobs WHERE status='scheduled' AND scheduled_at<=now() ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT least(greatest(p_limit,1),40))
 RETURNING j.*;
$$;
REVOKE ALL ON FUNCTION public.claim_due_recruiting_initial_jobs(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_recruiting_initial_jobs(integer) TO service_role;
CREATE FUNCTION public.finalize_recruiting_initial_job(p_job_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
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
 UPDATE public.recruiting_initial_email_jobs SET status='sent',error_message=NULL WHERE id=j.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finalize_recruiting_initial_job(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_recruiting_initial_job(uuid) TO service_role;
