import { withSupabase } from "npm:@supabase/server@1";
import { localScheduleToUtc, timezoneForCoordinates } from "../_shared/followup-batch-timezone.ts";

function json(body: unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{
  "content-type":"application/json; charset=utf-8","access-control-allow-origin":"*",
  "access-control-allow-headers":"authorization, x-client-info, apikey, content-type, x-recruiting-test-mode",
  "access-control-allow-methods":"POST, OPTIONS"
}})}
export default { fetch: withSupabase({auth:"user"},async(req,ctx)=>{
  if(req.method==="OPTIONS")return json({ok:true});
  if(req.method!=="POST")return json({ok:false,error:"POST required"},405);
  if(req.headers.get("x-recruiting-test-mode")!=="true")return json({ok:false,error:"Explicit Test Mode header is required"},403);
  try{
    const owner=String(ctx.jwtClaims?.sub??ctx.userClaims?.sub??"");
    if(!owner)return json({ok:false,error:"Authentication required"},401);
    const body=await req.json();
    const ids=Array.isArray(body.contact_ids)?Array.from(new Set(body.contact_ids.map((x:unknown)=>String(x).trim()).filter(Boolean))):[];
    if(ids.length<1||ids.length>3)return json({ok:false,error:"Select 1 to 3 TEST contacts"},400);
    const {data:contacts,error}=await ctx.supabase.from("recruiting_contacts")
      .select("id,owner_user_id,university_id,coach_role,coach_name,contact_status,coach_response,follow_up_count")
      .eq("owner_user_id",owner).in("id",ids);
    if(error)throw error;
    if(!contacts||contacts.length!==ids.length)return json({ok:false,error:"TEST contact unavailable"},400);
    if(new Set(contacts.map((c:any)=>Number(c.university_id))).size!==contacts.length)return json({ok:false,error:"Choose at most one contact per test school"},400);
    const schoolIds=Array.from(new Set(contacts.map((c:any)=>Number(c.university_id))));
    const {data:schools,error:se}=await ctx.supabase.from("recruiting_universities").select("id,name,latitude,longitude,is_test").in("id",schoolIds);
    if(se)throw se;
    const sm=new Map((schools||[]).map((s:any)=>[Number(s.id),s]));
    const localDate=String(body.local_date||""),localTime=String(body.local_time||"");
    const items:any[]=[],skipped:any[]=[];
    for(const c of contacts){
      const school:any=sm.get(Number(c.university_id));
      const skip=(reason:string)=>skipped.push({contact_id:c.id,school_name:school?.name||String(c.university_id),reason});
      if(!school||school.is_test!==true||![900,901,902].includes(Number(c.university_id))){skip("このリリースのテスト対象校（900–902）ではありません。");continue}
      if(!["head_coach","assistant_coach"].includes(c.coach_role)||c.contact_status==="responded"||String(c.coach_response||"").trim()||Number(c.follow_up_count||0)>1){skip("返信済み、またはFollow-up上限のため対象外です。");continue}
      try{
        const zone=timezoneForCoordinates(Number(school.latitude),Number(school.longitude));
        const scheduledAt=localScheduleToUtc(localDate,localTime,zone);
        items.push({contact_id:c.id,university_id:Number(c.university_id),school_name:school.name,coach_name:c.coach_name,
          coach_role:c.coach_role,follow_up_count:Number(c.follow_up_count||0),school_timezone:zone,scheduled_at:scheduledAt,
          recipient_email:"fujitame@gmail.com",subject:"[TEST] Follow-up #"+(Number(c.follow_up_count||0)+1)+" — "+school.name});
      }catch(e){skip(e instanceof Error?e.message:String(e))}
    }
    return json({ok:true,test_mode:true,recipient_email:"fujitame@gmail.com",items,skipped});
  }catch(e){console.error("TEST Follow-up preparation failed:",e);return json({ok:false,error:e instanceof Error?e.message:String(e)},500)}
})};