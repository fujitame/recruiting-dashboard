import { createClient } from "npm:@supabase/supabase-js@2";
import { buildReplyRaw, gmailSend, googleAccessToken } from "../_shared/followup-batch-gmail.ts";
import { localDateAfterSend } from "../_shared/followup-batch-timezone.ts";

const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const secret=Deno.env.get("FOLLOWUP_BATCH_WORKER_SECRET")||"";
const TEST_TO="fujitame@gmail.com";
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})}
async function finish(item:any,status:string,error?:string,extra:any={}) {
  await supabase.from("recruiting_followup_batch_items").update({status,error_message:error||null,...extra}).eq("id",item.id).eq("status","processing");
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok");
  if(req.method!=="POST"||!secret||req.headers.get("x-recruiting-batch-worker-secret")!==secret||
     req.headers.get("x-recruiting-test-mode")!=="true")return json({ok:false,error:"Unauthorized or explicit Test Mode header missing"},401);
  const {data:items,error}=await supabase.rpc("claim_due_recruiting_followup_batch_items",{p_limit:10});
  if(error)return json({ok:false,error:error.message},500);
  let sent=0,skipped=0,unknown=0;
  for(const item of items||[]){
    try{
      if(String(item.recipient_email||"").toLowerCase()!==TEST_TO||![900,901,902].includes(Number(item.university_id))||!String(item.subject||"").startsWith("[TEST]")){
        await finish(item,"skipped_changed","Test-send safety validation failed.");skipped++;continue;
      }
      const {data:contact,error:ce}=await supabase.from("recruiting_contacts")
       .select("id,owner_user_id,university_id,contact_status,coach_response,follow_up_count,contact_count")
       .eq("id",item.contact_id).eq("owner_user_id",item.owner_user_id).maybeSingle();
      if(ce)throw ce;
      const {data:school,error:se}=await supabase.from("recruiting_universities").select("id,is_test").eq("id",item.university_id).maybeSingle();
      if(se)throw se;
      if(!contact||!school||school.is_test!==true||Number(contact.university_id)!==Number(item.university_id)||
         contact.contact_status==="responded"||String(contact.coach_response||"").trim()||
         Number(contact.follow_up_count||0)!==Number(item.expected_follow_up_count)){
        await finish(item,"skipped_changed","TEST CRM state changed after the batch was scheduled.");skipped++;continue;
      }
      const token=await googleAccessToken();
      const raw=buildReplyRaw({to:TEST_TO,subject:item.subject,body:item.body,messageId:"",references:""});
      let result:any;
      try{result=await gmailSend(raw,null,token)}
      catch(e){await finish(item,"send_unknown","Test inbox send outcome is uncertain; verify Gmail manually before retrying.");unknown++;continue}
      const sentAt=new Date().toISOString(),nextCount=Number(contact.follow_up_count||0)+1;
      const nextDate=nextCount===1?localDateAfterSend(sentAt,item.school_timezone,7):null;
      const {error:updateError}=await supabase.from("recruiting_contacts").update({
        contact_status:nextCount>=2?"no_response":"contacted",
        follow_up_count:nextCount,
        contact_count:Number(contact.contact_count||0)+1,
        last_contact_at:sentAt,
        last_follow_up_at:sentAt,
        follow_up_date:nextDate,
        auto_follow_up_enabled:false,
        next_action:nextDate?"TEST MODE: 次回Follow-up期限 — "+nextDate+" ("+item.school_timezone+")":"TEST MODE: Follow-up上限到達"
      }).eq("id",contact.id).eq("owner_user_id",contact.owner_user_id);
      if(updateError){await finish(item,"send_unknown","Self-test email was sent, but TEST CRM update failed; inspect manually.",{sent_at:sentAt,gmail_message_id:result.id});unknown++;continue}
      const {error:he}=await supabase.from("recruiting_contact_history").insert({
        owner_user_id:contact.owner_user_id,contact_id:contact.id,event_type:"follow_up_sent",event_at:sentAt,
        to_status:nextCount>=2?"no_response":"contacted",
        note:"TEST MODE: Follow-up email delivered only to "+TEST_TO,
        gmail_message_id:result.id||null,gmail_message_at:sentAt,research_ids:item.research_ids
      });
      if(he){await finish(item,"send_unknown","Self-test email and CRM update succeeded, but history insert failed.",{sent_at:sentAt,gmail_message_id:result.id});unknown++;continue}
      await finish(item,"sent",null,{sent_at:sentAt,gmail_message_id:result.id});sent++;
    }catch(e){await finish(item,"send_unknown","Test worker error: "+(e instanceof Error?e.message:String(e)));unknown++}
  }
  for(const batchId of new Set((items||[]).map((x:any)=>x.batch_id))){
    const {data:rows}=await supabase.from("recruiting_followup_batch_items").select("status").eq("batch_id",batchId);
    const states=(rows||[]).map((r:any)=>r.status);
    if(states.every((x:string)=>["sent","skipped_changed","send_unknown","cancelled"].includes(x)))
      await supabase.from("recruiting_followup_batches").update({status:states.every((x:string)=>x==="sent"||x==="cancelled")?"complete":"partial"}).eq("id",batchId).eq("status","scheduled");
  }
  return json({ok:true,test_mode:true,recipient_email:TEST_TO,claimed:(items||[]).length,sent,skipped,send_unknown:unknown});
});