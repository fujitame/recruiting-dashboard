import { batchMode, schoolInMode, validCoachEmail, TEST_RECIPIENT } from "../_shared/followup-batch-policy.ts";
import { withSupabase } from "npm:@supabase/server@1";
import { localScheduleToUtc, timezoneForCoordinates } from "../_shared/followup-batch-timezone.ts";
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json; charset=utf-8","access-control-allow-origin":"*",
 "access-control-allow-headers":"authorization, x-client-info, apikey, content-type",
 "access-control-allow-methods":"POST, OPTIONS"
}})}
function usedIds(history:any[]){return Array.from(new Set((history||[]).flatMap((r:any)=>Array.isArray(r.research_ids)?r.research_ids:[])
 .map((x:unknown)=>Number(x)).filter((x:number)=>Number.isInteger(x)&&x>0)))}
export default {fetch:withSupabase({auth:"user"},async(req,ctx)=>{
 if(req.method==="OPTIONS")return json({ok:true});
 if(req.method!=="POST")return json({ok:false,error:"POST required"},405);
 try{
  const payload=await req.json();
  const mode=batchMode(payload?.test_mode),isTest=mode==="test";
  const owner=String(ctx.jwtClaims?.sub??ctx.userClaims?.sub??"");
  if(!owner)return json({ok:false,error:"Authentication required"},401);
  const localDate=String(payload.local_date||""),localTime=String(payload.local_time||"");
  const items=Array.isArray(payload.items)?payload.items:[];
  if(items.length<1||items.length>(isTest?6:250))return json({ok:false,error:"Choose contacts within the reservation limit"},400);
  if(new Set(items.map((x:any)=>String(x.contact_id||""))).size!==items.length)return json({ok:false,error:"Duplicate test contacts are not allowed"},400);
  const ids=items.map((x:any)=>String(x.contact_id||""));
  const {data:contacts,error:ce}=await ctx.supabase.from("recruiting_contacts")
   .select("id,owner_user_id,university_id,coach_role,coach_name,coach_email,gmail_thread_id,contact_status,coach_response,follow_up_count")
   .eq("owner_user_id",owner).in("id",ids);
  if(ce)throw ce;
  if(!contacts||contacts.length!==items.length)throw new Error("A test CRM contact changed or is unavailable.");
  const schoolIds=Array.from(new Set(contacts.map((c:any)=>Number(c.university_id))));
  const {data:schools,error:se}=await ctx.supabase.from("recruiting_universities").select("id,name,latitude,longitude,is_test").in("id",schoolIds);
  if(se)throw se;
  const sm=new Map((schools||[]).map((s:any)=>[Number(s.id),s]));
  const {data:schoolContacts,error:replyError}=await ctx.supabase.from("recruiting_contacts")
    .select("university_id,contact_status,coach_response").eq("owner_user_id",owner).in("university_id",schoolIds);
  if(replyError)throw replyError;
  const repliedSchools=new Set((schoolContacts||[]).filter((c:any)=>c.contact_status==="responded"||String(c.coach_response||"").trim()).map((c:any)=>Number(c.university_id)));
  const im=new Map(items.map((x:any)=>[String(x.contact_id),x]));
  const rpcItems:any[]=[],sentenceSchools=new Map<string,number>();
  for(const c of contacts){
   const item:any=im.get(String(c.id)),school:any=sm.get(Number(c.university_id));
   if(!schoolInMode(school,mode))throw new Error("School is not eligible in the selected mode.");
   const recipient=isTest?TEST_RECIPIENT:String(c.coach_email||"").trim().toLowerCase();
   if(!isTest&&(!validCoachEmail(recipient)||!c.gmail_thread_id))throw new Error("Coach email and original Gmail thread are required.");
   if(item.recipient_email!==recipient||(!isTest&&item.gmail_thread_id!==c.gmail_thread_id))throw new Error("Recipient or Gmail thread changed; generate the preview again.");
   if(repliedSchools.has(Number(c.university_id)))throw new Error(school.name+" has a coach reply; school-wide Follow-up is blocked.");
   if(!["head_coach","assistant_coach"].includes(c.coach_role)||!["contacted","follow_up_due"].includes(c.contact_status)||String(c.coach_response||"").trim()||![0,1].includes(Number(c.follow_up_count||0)))
     throw new Error(school.name+" is no longer eligible for a TEST Follow-up.");
   if(Number(item.follow_up_count)!==Number(c.follow_up_count||0))throw new Error(school.name+" Follow-up state changed; generate the preview again.");
   const zone=timezoneForCoordinates(Number(school.latitude),Number(school.longitude));
   const scheduledAt=localScheduleToUtc(localDate,localTime,zone);
   if(item.scheduled_at!==scheduledAt||item.school_timezone!==zone)throw new Error("Reservation time changed; generate the preview again.");
   const sentence=String(item.personalization_sentence||"").trim(),body=String(item.body||"");
   const researchIds=Array.isArray(item.research_ids)?item.research_ids.map(Number).filter((n:number)=>Number.isInteger(n)&&n>0):[];
   if((isTest&&!body.startsWith("TEST MODE — This message is sent only to fujitame@gmail.com."))||(!isTest&&body.startsWith("TEST MODE"))||!body.trim()||!body.includes(sentence)||!((sentence&&researchIds.length===1)||(!sentence&&researchIds.length===0)))
     throw new Error(school.name+" must retain the TEST-only recipient notice and one verified school-specific Research sentence.");
   if(Number(c.follow_up_count)===1&&(sentence||researchIds.length))throw new Error("Follow-up #2 must use the standard body without Research personalization.");
   const sentenceKey=sentence.toLowerCase().replace(/\s+/g," ").trim();
   if(sentenceKey&&sentenceSchools.has(sentenceKey)&&sentenceSchools.get(sentenceKey)!==Number(c.university_id))throw new Error("Different test schools must have different Research sentences.");
   if(sentenceKey)sentenceSchools.set(sentenceKey,Number(c.university_id));
   if(researchIds.length){
   const {data:history,error:he}=await ctx.supabase.from("recruiting_contact_history").select("research_ids").eq("contact_id",c.id);
   if(he)throw he;
   const role=c.coach_role==="head_coach"?"HC":"AC";
   const {data:research,error:re}=await ctx.supabase.rpc("get_personalization_context_excluding",{
     p_university_id:Number(c.university_id),p_recipient_role:role,p_recipient_name:String(c.coach_name||""),
     p_excluded_ids:usedIds(history||[]),p_max_facts:2
   });
   if(re)throw re;
   const valid=new Set((research||[]).map((x:any)=>Number(x.research_id)));
   if(!researchIds.every((id:number)=>valid.has(id)))throw new Error(school.name+" Research changed; generate the preview again.");
   }
   const subject=String(item.subject||"").trim();
   if((isTest&&!subject.startsWith("[TEST] Follow-up #"+(Number(c.follow_up_count||0)+1)+" — "))||(!isTest&&subject.startsWith("[TEST]"))||!subject||subject.length>180||body.length>10000)throw new Error("TEST email subject or body is invalid.");
   rpcItems.push({contact_id:c.id,expected_follow_up_count:Number(c.follow_up_count||0),recipient_email:recipient,gmail_thread_id:isTest?null:c.gmail_thread_id,scheduled_at:scheduledAt,school_timezone:zone,subject,body,
     personalization_sentence:sentence,research_ids:researchIds});
  }
  const {data:batchId,error}=await ctx.supabase.rpc("schedule_recruiting_followup_batch",{
   p_local_date:localDate,p_local_time:localTime,p_items:rpcItems,p_mode:mode
  });
  if(error)throw error;
  return json({ok:true,test_mode:isTest,mode,batch_id:batchId,recipient_email:isTest?TEST_RECIPIENT:null,scheduled_count:rpcItems.length,
   items:rpcItems.map((x:any)=>({contact_id:x.contact_id,scheduled_at:x.scheduled_at,school_timezone:x.school_timezone}))});
 }catch(e){console.error("TEST Follow-up scheduling failed:",e);return json({ok:false,error:e instanceof Error?e.message:String(e)},400)}
})};
