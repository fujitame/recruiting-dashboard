import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { googleAccessToken, buildReplyRaw, gmailSend, verifyGmailSentBody, GMAIL_ACCOUNT } from "../_shared/followup-batch-gmail.ts";
import { prepareEmailTracking, trackingHtml } from "../_shared/recruiting-email-tracking.ts";
import { syncContactThreadLabels } from "../_shared/recruiting-gmail-labels.ts";
const db=createClient(Deno.env.get("SUPABASE_URL"),Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),{auth:{persistSession:false}});
const secret=Deno.env.get("FOLLOWUP_BATCH_WORKER_SECRET");
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json"}});
export function eligibleJob(j,contacts,school,now=Date.now()){
 return j.campaign_key==="ca-new-d1-d2-20261023-0800" && ([7,8,52].includes(j.university_id)||(j.university_id>=107 && j.university_id<=126)) &&
 j.owner_user_id==="47e7c1a9-a806-4f65-b5ed-2b9b124ef337" && j.school_timezone==="America/Los_Angeles" &&
 j.scheduled_at && now>=Date.parse(j.scheduled_at) && now<Date.parse(j.scheduled_at)+2*3600000 &&
 school?.region_code==='ca' && school?.is_active && !school.is_test && ["NCAA D1","NCAA D2"].includes(school.division) &&
 /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.recipient_email) &&
 j.contact_ids.length===contacts.length && contacts.some(c=>c.id===j.contact_id) &&
 contacts.every(c=>c.owner_user_id===j.owner_user_id && c.university_id===j.university_id &&
 String(c.coach_email||"").trim().toLowerCase()===j.recipient_email && c.contact_status==="not_contacted" &&
 Number(c.contact_count)===0 && !c.gmail_thread_id && !String(c.coach_response||"").trim());
}
async function updateJob(j,payload){
 const {error}=await db.from("recruiting_initial_email_jobs").update(payload).eq("id",j.id).eq("status","processing");
 if(error)throw error;
}
async function processJob(j,token){
 let accepted=null,tracking=null;
 try{
  const [{data:contacts,error:ce},{data:school,error:se}]=await Promise.all([
   db.from("recruiting_contacts").select("*").in("id",j.contact_ids),
   db.from("recruiting_universities").select("id,region_code,is_active,is_test,division").eq("id",j.university_id).single()
  ]);
  if(ce||se)throw ce||se;
  if(!eligibleJob(j,contacts||[],school)){await updateJob(j,{status:"skipped",error_message:"Eligibility or send window changed"});return "skipped";}
  const search=new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  search.searchParams.set("q","in:sent to:"+j.recipient_email);search.searchParams.set("maxResults","1");
  const priorResponse=await fetch(search,{headers:{Authorization:"Bearer "+token}});
  if(!priorResponse.ok)throw new Error("Could not check Gmail for previous sends");
  const prior=await priorResponse.json();
  if(prior.messages?.length){await updateJob(j,{status:"skipped",error_message:"Existing sent Gmail message to recipient; review before first contact"});return "skipped";}
  tracking=await prepareEmailTracking({contactId:j.contact_id,ownerId:j.owner_user_id,stage:"initial",body:j.body});
  const profileLink=tracking.plain.match(/https:\/\/[^\s]+\/functions\/v1\/recruiting-email-events\?event=profile&t=[0-9a-f]{64}/)?.[0];
  if(!profileLink)throw new Error("Tracking profile link missing");
  const videoLink=profileLink.replace("event=profile","event=youtube");
  const plain=tracking.plain.replace("https://www.youtube.com/watch?v=kG2G7fUz1SI",()=>videoLink);
  const html=trackingHtml(plain,profileLink.replace("event=profile","event=open"));
  await updateJob(j,{tracking_id:tracking.id});
  // A second CRM check immediately before transport; never send from changed contact state.
  const {data:current,error:currentError}=await db.from("recruiting_contacts").select("*").in("id",j.contact_ids);
  if(currentError)throw currentError;
  if(!eligibleJob(j,current||[],school)){await updateJob(j,{status:"skipped",error_message:"CRM changed before transport"});return "skipped";}
  accepted=await gmailSend(buildReplyRaw({to:j.recipient_email,subject:j.subject,body:plain,htmlBody:html,messageId:"",references:""}),null,token);
  const sentAt=new Date().toISOString();
  await updateJob(j,{gmail_message_id:accepted.id,gmail_thread_id:accepted.threadId,sent_at:sentAt});
  const pending=await db.from("recruiting_email_tracking").update({status:"send_unknown",gmail_message_id:accepted.id,sent_at:sentAt}).eq("id",tracking.id);if(pending.error)throw pending.error;
  await verifyGmailSentBody(accepted.id,plain,token);
  const verified=await db.from("recruiting_email_tracking").update({status:"sent"}).eq("id",tracking.id);if(verified.error)throw verified.error;
  const done=await db.rpc("finalize_recruiting_initial_job",{p_job_id:j.id});if(done.error||done.data!==true)throw done.error||new Error("CRM finalization failed");
  for(const c of current){try{await syncContactThreadLabels(db,{...c,contact_status:"contacted",gmail_thread_id:accepted.threadId,follow_up_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),auto_follow_up_enabled:true});}catch{console.warn("Initial campaign Gmail label sync pending");}}
  return "sent";
 }catch(e){
  if(tracking)await db.from("recruiting_email_tracking").update({status:"send_unknown",...(accepted?.id?{gmail_message_id:accepted.id,sent_at:new Date().toISOString()}:{})}).eq("id",tracking.id);
  await updateJob(j,{status:"send_unknown",error_message:String(e?.message||e).slice(0,600),...(accepted?.id?{gmail_message_id:accepted.id,gmail_thread_id:accepted.threadId}:{})});
  return "send_unknown";
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST"||!secret||req.headers.get("x-recruiting-batch-worker-secret")!==secret)return json({ok:false,error:"Unauthorized"},401);
 const {data:due,error:de}=await db.from("recruiting_initial_email_jobs").select("id").eq("status","scheduled").lte("scheduled_at",new Date().toISOString()).limit(1);
 if(de)return json({ok:false,error:"Queue lookup failed"},500);
 // Validate OAuth before claiming; authentication failure leaves reservations scheduled.
 if(!due?.length)return json({ok:true,sent:0,claimed:0});
 let token;
 try{token=await googleAccessToken();const r=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",{headers:{Authorization:"Bearer "+token}});const p=await r.json();if(!r.ok||p.emailAddress?.toLowerCase()!==GMAIL_ACCOUNT)throw Error("Sender mismatch");}
 catch{return json({ok:false,error:"Gmail authentication requires attention; reservations retained"},503);}
 if(!due?.length)return json({ok:true,sender:GMAIL_ACCOUNT,sent:0,claimed:0});
 const {data:jobs,error}=await db.rpc("claim_due_recruiting_initial_jobs",{p_limit:8});if(error)return json({ok:false,error:"Claim failed"},500);
 const results=[];
 for(let i=0;i<(jobs||[]).length;i+=4)results.push(...await Promise.all(jobs.slice(i,i+4).map(j=>processJob(j,token))));
 return json({ok:true,claimed:jobs.length,sent:results.filter(x=>x==="sent").length,skipped:results.filter(x=>x==="skipped").length,send_unknown:results.filter(x=>x==="send_unknown").length});
});