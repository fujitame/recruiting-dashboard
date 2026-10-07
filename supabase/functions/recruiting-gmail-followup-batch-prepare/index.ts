import { batchMode, schoolInMode, validCoachEmail, TEST_RECIPIENT } from "../_shared/followup-batch-policy.ts";
import { googleAccessToken, gmailGetThread, latestOutbound, getHeader, anyThreadReply, outboundIncludesRecipient } from "../_shared/followup-batch-gmail.ts";
import { withSupabase } from "npm:@supabase/server@1";
import { localScheduleToUtc, timezoneForCoordinates } from "../_shared/followup-batch-timezone.ts";

function json(body: unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{
  "content-type":"application/json; charset=utf-8","access-control-allow-origin":"*",
  "access-control-allow-headers":"authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods":"POST, OPTIONS"
}})}
export default { fetch: withSupabase({auth:"user"},async(req,ctx)=>{
  if(req.method==="OPTIONS")return json({ok:true});
  if(req.method!=="POST")return json({ok:false,error:"POST required"},405);
  try{
    const body=await req.json();
    const mode=batchMode(body?.test_mode),isTest=mode==="test";
    const owner=String(ctx.jwtClaims?.sub??ctx.userClaims?.sub??"");
    if(!owner)return json({ok:false,error:"Authentication required"},401);
    const ids=Array.isArray(body.contact_ids)?Array.from(new Set(body.contact_ids.map((x:unknown)=>String(x).trim()).filter(Boolean))):[];
    if(ids.length<1||ids.length>(isTest?6:250))return json({ok:false,error:"Select contacts within the reservation limit"},400);
    const {data:contacts,error}=await ctx.supabase.from("recruiting_contacts")
      .select("id,owner_user_id,university_id,coach_role,coach_name,coach_email,gmail_thread_id,contact_status,coach_response,follow_up_count")
      .eq("owner_user_id",owner).in("id",ids);
    if(error)throw error;
    if(!contacts||contacts.length!==ids.length)return json({ok:false,error:"TEST contact unavailable"},400);
    const schoolIds=Array.from(new Set(contacts.map((c:any)=>Number(c.university_id))));
    const {data:schools,error:se}=await ctx.supabase.from("recruiting_universities").select("id,name,latitude,longitude,is_test").in("id",schoolIds);
    if(se)throw se;
    const sm=new Map((schools||[]).map((s:any)=>[Number(s.id),s]));
    const {data:schoolContacts,error:replyError}=await ctx.supabase.from("recruiting_contacts")
      .select("university_id,contact_status,coach_response").eq("owner_user_id",owner).in("university_id",schoolIds);
    if(replyError)throw replyError;
    const repliedSchools=new Set((schoolContacts||[]).filter((c:any)=>c.contact_status==="responded"||String(c.coach_response||"").trim()).map((c:any)=>Number(c.university_id)));
    const localDate=String(body.local_date||""),localTime=String(body.local_time||"");
    const items:any[]=[],skipped:any[]=[];
    let token:string|undefined;
    const threads=new Map<string,any>();
    for(const c of contacts){
      const school:any=sm.get(Number(c.university_id));
      const skip=(reason:string)=>skipped.push({contact_id:c.id,school_name:school?.name||String(c.university_id),reason});
      if(!schoolInMode(school,mode)){skip("現在のモードの対象校ではありません。");continue}
      if(repliedSchools.has(Number(c.university_id))){skip("同校のコーチから返信があるため、学校全体のFollow-upを停止しています。");continue}
      if(!["head_coach","assistant_coach"].includes(c.coach_role)||!["contacted","follow_up_due"].includes(c.contact_status)||String(c.coach_response||"").trim()||![0,1].includes(Number(c.follow_up_count||0))){skip("返信済み、またはFollow-up上限のため対象外です。");continue}
      try{
        if(!isTest&&(!validCoachEmail(c.coach_email)||!String(c.gmail_thread_id||"").trim())){skip("Coachの宛先または初回メールのGmail Thread IDがありません。");continue}
        let subject=(isTest?"[TEST] ":"")+"Follow-up #"+(Number(c.follow_up_count||0)+1)+" — "+school.name;
        if(!isTest){
          token ||= await googleAccessToken();
          if(!threads.has(c.gmail_thread_id))threads.set(c.gmail_thread_id,await gmailGetThread(c.gmail_thread_id,token));
          const thread=threads.get(c.gmail_thread_id),outbound=latestOutbound(thread);
          if(!outbound){skip("初回メールの送信履歴がありません。");continue}
          if(anyThreadReply(thread)){repliedSchools.add(Number(c.university_id));skip("Gmailで返信を検出したため同校のFollow-upを停止しました。");continue}
          if(!outboundIncludesRecipient(outbound,String(c.coach_email))){skip("初回メールの宛先とCoachの宛先が一致しません。");continue}
          subject=getHeader(outbound.payload?.headers||[],"Subject");
          if(!subject.trim()){skip("初回メールの件名を確認できません。");continue}
        }
        const zone=timezoneForCoordinates(Number(school.latitude),Number(school.longitude));
        const scheduledAt=localScheduleToUtc(localDate,localTime,zone);
        items.push({contact_id:c.id,university_id:Number(c.university_id),school_name:school.name,coach_name:c.coach_name,
          coach_role:c.coach_role,follow_up_count:Number(c.follow_up_count||0),school_timezone:zone,scheduled_at:scheduledAt,
          recipient_email:isTest?TEST_RECIPIENT:String(c.coach_email).trim().toLowerCase(),gmail_thread_id:isTest?null:c.gmail_thread_id,subject});
      }catch(e){skip(e instanceof Error?e.message:String(e))}
    }
    return json({ok:true,test_mode:isTest,mode,recipient_email:isTest?TEST_RECIPIENT:null,items:items.filter(item=>!repliedSchools.has(item.university_id)),skipped});
  }catch(e){console.error("TEST Follow-up preparation failed:",e);return json({ok:false,error:e instanceof Error?e.message:String(e)},500)}
})};
