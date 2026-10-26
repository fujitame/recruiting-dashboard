ALTER TABLE public.recruiting_email_tracking ADD COLUMN video_targets jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recruiting_email_tracking DROP CONSTRAINT recruiting_email_tracking_stage_check;
ALTER TABLE public.recruiting_email_tracking ADD CONSTRAINT recruiting_email_tracking_stage_check CHECK(stage IN('initial','reply','follow_up_1','follow_up_2','conversation_follow_up'));
CREATE TABLE public.recruiting_email_engagement_signals(
 tracking_id uuid NOT NULL REFERENCES public.recruiting_email_tracking(id) ON DELETE CASCADE,
 event text NOT NULL CHECK(event IN('profile_interaction','profile_active_15s','resume_click','profile_youtube_click','video_start','video_30s')),
 video_slot text NOT NULL DEFAULT '' CHECK(video_slot IN('','primary','secondary')),
 first_at timestamptz NOT NULL DEFAULT now(),
 last_at timestamptz NOT NULL DEFAULT now(),
 signals integer NOT NULL DEFAULT 1 CHECK(signals BETWEEN 1 AND 100),
 PRIMARY KEY(tracking_id,event,video_slot)
);
ALTER TABLE public.recruiting_email_engagement_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruiting_email_engagement_signals FROM anon,authenticated;
GRANT SELECT ON public.recruiting_email_engagement_signals TO authenticated;
GRANT ALL ON public.recruiting_email_engagement_signals TO service_role;
CREATE POLICY engagement_signal_owner_read ON public.recruiting_email_engagement_signals FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.recruiting_email_tracking t WHERE t.id=tracking_id AND t.owner_user_id=(select auth.uid())));
CREATE FUNCTION public.record_recruiting_engagement_signal(p_token_hash text,p_event text,p_video_slot text DEFAULT '',p_automated boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE target uuid;n integer;
BEGIN
 IF p_automated IS DISTINCT FROM false OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_event IS NULL OR p_event NOT IN('profile_interaction','profile_active_15s','resume_click','profile_youtube_click','video_start','video_30s') OR p_video_slot IS NULL OR p_video_slot NOT IN('','primary','secondary') THEN RETURN false;END IF;
 IF p_event IN('video_start','video_30s','profile_youtube_click') AND p_video_slot NOT IN('primary','secondary') THEN RETURN false;END IF;
 IF p_event NOT IN('video_start','video_30s','profile_youtube_click') AND p_video_slot<>'' THEN RETURN false;END IF;
 SELECT id INTO target FROM public.recruiting_email_tracking WHERE token_hash=p_token_hash AND expires_at>now() AND status='sent';
 IF target IS NULL THEN RETURN false;END IF;
 INSERT INTO public.recruiting_email_engagement_signals(tracking_id,event,video_slot)
 VALUES(target,p_event,p_video_slot)
 ON CONFLICT(tracking_id,event,video_slot) DO UPDATE SET last_at=now(),signals=least(recruiting_email_engagement_signals.signals+1,100)
 WHERE recruiting_email_engagement_signals.last_at<now()-interval '10 minutes';
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END $$;
REVOKE ALL ON FUNCTION public.record_recruiting_engagement_signal(text,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_recruiting_engagement_signal(text,text,text,boolean) TO service_role;
