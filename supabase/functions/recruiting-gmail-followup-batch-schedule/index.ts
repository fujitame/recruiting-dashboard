import { withSupabase } from "npm:@supabase/server@1";
import { localScheduleToUtc, timezoneForCoordinates } from "../_shared/followup-batch-timezone.ts";
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json; charset=utf-8","access-control-allow-origin":"*",
 "access-control-allow-headers":"authorization, x-client-info, apikey, content-type, x-recruiting-test-mode",
 "access-control-allow-methods":"POST, OPTIONS"
}})}
function usedIds(history:any[]){return Array.from(new Set((history||[]).flatMap((r:any)=>Array.isArray(r.research_ids)?r.research_ids:[])
 .map((x:unknown)=>Number(x)).filter((x:number)=>Number.isInteger(x)&&x>0)))}
export default {fetch:withSupabase({auth:"user"},async(req,ctx)=>{
 if(req.method==="OPTIONS")return json({ok:true});
 if(req.method!=="POST")return json({ok:false,error:"POST required"},405);
 if(req.headers.get("x-recruiting-test-mode")!=="true")return json({ok:false,error:"Explicit Test Mode header is required"},403);
 try{
  const owner=String(ctx.jwtClaims?.sub??ctx.userClaims?.sub??"");
  if(!owner)return json({ok:false,error:"Authentication required"},401);
  const payload=await req.json(), localDate=String(payload.local_date||""),localTime=String(payload.local_time||"");
  const items=Array.isArray(payload.items)?payload.items:[];
  if(items.length<1||items.length>3)return json({ok:false,error:"Choose 1 to 3 TEST contacts"},400);
  if(new Set(items.map((x:any)=>String(x.contact_id||""))).size!==items.length)return json({ok:false,error:"Duplicate test contacts are not allowed"},400);
  const ids=items.map((x:any)=>String(x.contact_id||""));
  const {data:contacts,error:ce}=await ctx.supabase.from("recruiting_contacts")
   .select("id,owner_user_id,university_id,coach_role,coach_name,contact_status,coach_response,follow_up_count")
   .eq("owner_user_id",owner).in("id",ids);
  if(ce)throw ce;
  if(!contacts||contacts.length!==items.length)throw new Error("A test CRM contact changed or is unavailable.");
  if(new Set(contacts.map((c:any)=>Number(c.university_id))).size!==contacts.length)throw new Error("Choose at most one contact per test school.");
  const schoolIds=Array.from(new Set(contacts.map((c:any)=>Number(c.university_id))));
  const {data:schools,error:se}=await ctx.supabase.from("recruiting_universities").select("id,name,latitude,longitude,is_test").in("id",schoolIds);
  if(se)throw se;
  const sm=new Map((schools||[]).map((s:any)=>[Number(s.id),s]));
  const im=new Map(items.map((x:any)=>[String(x.contact_id),x]));
  const rpcItems:any[]=[],sentenceSet=new Set<string>();
  for(const c of contacts){
   const item:any=im.get(String(c.id)),school:any=sm.get(Number(c.university_id));
   if(!school||school.is_test!==true||![900,901,902].includes(Number(c.university_id)))throw new Error("Only TEST schools 900, 901, and 902 are enabled in this release.");
   if(!["head_coach","assistant_coach"].includes(c.coach_role)||c.contact_status==="responded"||String(c.coach_response||"").trim()||Number(c.follow_up_count||0)>1)
     throw new Error(school.name+" is no longer eligible for a TEST Follow-up.");
   if(Number(item.follow_up_count)!==Number(c.follow_up_count||0))throw new Error(school.name+" Follow-up state changed; generate the preview again.");
   const zone=timezoneForCoordinates(Number(school.latitude),Number(school.longitude));
   const scheduledAt=localScheduleToUtc(localDate,localTime,zone);
   const sentence=String(item.personalization_sentence||"").trim(),body=String(item.body||"");
   const researchIds=Array.isArray(item.research_ids)?item.research_ids.map(Number).filter((n:number)=>Number.isInteger(n)&&n>0):[];
   if(!sentence||!body.includes(sentence)||researchIds.length!==1)throw new Error(school.name+" must retain one verified school-specific Research sentence.");
   const sentenceKey=sentence.toLowerCase().replace(/\s+/g," ").trim();
   if(sentenceSet.has(sentenceKey))throw new Error("Each selected test school must have a different Research sentence.");
   sentenceSet.add(sentenceKey);
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
   const subject=String(item.subject||"").trim();
   if(!subject.startsWith("[TEST]")||subject.length>180||body.length>10000)throw new Error("TEST email subject or body is invalid.");
   rpcItems.push({contact_id:c.id,scheduled_at:scheduledAt,school_timezone:zone,subject,body,
     personalization_sentence:sentence,research_ids:researchIds});
  }
  const {data:batchId,error}=await ctx.supabase.rpc("schedule_recruiting_followup_batch",{
   p_local_date:localDate,p_local_time:localTime,p_items:rpcItems
  });
  if(error)throw error;
  return json({ok:true,test_mode:true,batch_id:batchId,recipient_email:"fujitame@gmail.com",scheduled_count:rpcItems.length,
   items:rpcItems.map((x:any)=>({contact_id:x.contact_id,scheduled_at:x.scheduled_at,school_timezone:x.school_timezone}))});
 }catch(e){console.error("TEST Follow-up scheduling failed:",e);return json({ok:false,error:e instanceof Error?e.message:String(e)},400)}
})};