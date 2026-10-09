import { schoolInMode, validCoachEmail, followUpEligible, hasReply, TEST_RECIPIENT, TEST_BANNER } from "../_shared/followup-batch-policy.ts";
import { syncContactThreadLabels } from "../_shared/recruiting-gmail-labels.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildReplyRaw, gmailSend, googleAccessToken, gmailGetThread, latestOutbound, getHeader, anyThreadReply, outboundIncludesRecipient, plainTextMessage, verifyGmailSentBody } from "../_shared/followup-batch-gmail.ts";
import { localDateAfterSend } from "../_shared/followup-batch-timezone.ts";

const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const secret=Deno.env.get("FOLLOWUP_BATCH_WORKER_SECRET")||"";
const TEST_TO="fujitame@gmail.com";
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})}
async function finish(item:any,status:string,error?:string,extra:any={}) {
  await supabase.from("recruiting_followup_batch_items").update({status,error_message:error||null,...extra}).eq("id",item.id).eq("status","processing");
}
async function syncReservationLabels(item:any) {
 const {data:contact,error}=await supabase.from('recruiting_contacts').select('*').eq('id',item.contact_id).eq('owner_user_id',item.owner_user_id).maybeSingle();
 if(error)throw error;
 if(!contact?.gmail_thread_id)throw new Error('Original Gmail thread unavailable for label sync');
 await syncContactThreadLabels(supabase,contact);
 const {error:clearError}=await supabase.from('recruiting_followup_batch_items').update({error_message:null}).eq('id',item.id).eq('status','sent');
 if(clearError)throw clearError;
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok");
  if(req.method!=="POST"||!secret||req.headers.get("x-recruiting-batch-worker-secret")!==secret)return json({ok:false,error:"Unauthorized"},401);
  const {data:items,error}=await supabase.rpc("claim_due_recruiting_followup_batch_items",{p_limit:10});
  if(error)return json({ok:false,error:error.message},500);
  let sent=0,skipped=0,unknown=0,labelPending=0;
  // Label retries never resend an email and resolve the target from current CRM state.
  const {data:labelRetries,error:retryError}=await supabase.from('recruiting_followup_batch_items').select('*').eq('mode','production').eq('status','sent').like('error_message','LABEL_SYNC_PENDING:%').limit(10);
  if(retryError)return json({ok:false,error:retryError.message},500);
  for(const retry of labelRetries||[]){try{await syncReservationLabels(retry)}catch(e){labelPending++;console.warn('Label retry pending',e)}}
  for(const item of items||[]){
    try{
      const mode=item.mode||'test',isTest=mode==='test';
      if(!['test','production'].includes(mode)||![0,1].includes(Number(item.expected_follow_up_count))||
         (Number(item.expected_follow_up_count)===1&&(String(item.personalization_sentence||'').trim()||(item.research_ids||[]).length))||
         (isTest&&(item.recipient_email!==TEST_RECIPIENT||!String(item.body||'').startsWith(TEST_BANNER)||
          !String(item.subject||'').startsWith('[TEST] Follow-up #'+(Number(item.expected_follow_up_count)+1)+' — ')))||
         (!isTest&&(!validCoachEmail(item.recipient_email)||!item.gmail_thread_id||String(item.body||'').startsWith('TEST MODE')||String(item.subject||'').startsWith('[TEST]')))){
        await finish(item,'skipped_changed','Reservation mode or recipient validation failed.');skipped++;continue;
      }
      const {data:contact,error:ce}=await supabase.from("recruiting_contacts")
       .select("id,owner_user_id,university_id,coach_role,coach_email,gmail_thread_id,contact_status,coach_response,follow_up_count,contact_count")
       .eq("id",item.contact_id).eq("owner_user_id",item.owner_user_id).maybeSingle();
      if(ce)throw ce;
      const {data:school,error:se}=await supabase.from("recruiting_universities").select("id,is_test").eq("id",item.university_id).maybeSingle();
      if(se)throw se;
      if(!contact||!schoolInMode(school,mode)||Number(contact.university_id)!==Number(item.university_id)||
         !followUpEligible(contact)||
         (!isTest&&(String(contact.coach_email||"").trim().toLowerCase()!==item.recipient_email||contact.gmail_thread_id!==item.gmail_thread_id))||
         Number(contact.follow_up_count||0)!==Number(item.expected_follow_up_count)){
        await finish(item,"skipped_changed","TEST CRM state changed after the batch was scheduled.");skipped++;continue;
      }
      const {data:schoolContacts,error:replyError}=await supabase.from("recruiting_contacts")
        .select("id,coach_email,gmail_thread_id,contact_status,coach_response").eq("owner_user_id",item.owner_user_id).eq("university_id",item.university_id);
      if(replyError)throw replyError;
      if((schoolContacts||[]).some((c:any)=>c.contact_status==="responded"||String(c.coach_response||"").trim())){
        await finish(item,"skipped_changed","A coach at this test school has replied; school-wide Follow-up is blocked.");skipped++;continue;
      }
      const token=await googleAccessToken();
      let threadId:string|null=null,messageId='',references='';
      if(!isTest){
        const threads=new Map<string,any>();let foundReply=false;
        for(const sibling of schoolContacts||[]){
          if(!sibling.gmail_thread_id)continue;
          if(!threads.has(sibling.gmail_thread_id))threads.set(sibling.gmail_thread_id,await gmailGetThread(sibling.gmail_thread_id,token));
          const reply=anyThreadReply(threads.get(sibling.gmail_thread_id));
          if(reply){
            foundReply=true;
            const {error:markError}=await supabase.from('recruiting_contacts').update({contact_status:'responded',coach_response:plainTextMessage(reply).slice(0,4000)||getHeader(reply.payload?.headers||[],'Subject')||'Gmail返信あり',follow_up_date:null,auto_follow_up_enabled:false,next_action:'Coachの返信を個別CRMで確認'}).eq('id',sibling.id).eq('owner_user_id',item.owner_user_id);
            if(markError)throw markError;
            try{await syncContactThreadLabels(supabase,sibling)}catch(e){console.warn('Reply label sync pending',e)}
            const {data:existing,error:historyLookupError}=await supabase.from('recruiting_contact_history').select('id').eq('contact_id',sibling.id).eq('gmail_message_id',reply.id).eq('event_type','reply_received');
            if(historyLookupError)throw historyLookupError;
            if(!existing?.length){const replyAt=new Date(Number(reply.internalDate)||Date.now()).toISOString();
              const {error:replyHistoryError}=await supabase.from('recruiting_contact_history').insert({owner_user_id:item.owner_user_id,contact_id:sibling.id,event_type:'reply_received',event_at:replyAt,to_status:'responded',note:'予約送信前にGmail返信を検出: '+plainTextMessage(reply).slice(0,4000),gmail_message_id:reply.id,gmail_message_at:replyAt});
              if(replyHistoryError)throw replyHistoryError;
            }
          }
        }
        if(foundReply){await finish(item,'skipped_changed','A coach at this school replied in Gmail; reservation stopped.');skipped++;continue;}
        const thread=threads.get(item.gmail_thread_id)||await gmailGetThread(item.gmail_thread_id,token);
        const outbound=latestOutbound(thread);
        if(!outbound||!outboundIncludesRecipient(outbound,item.recipient_email)||getHeader(outbound.payload?.headers||[],'Subject')!==item.subject){
          await finish(item,'skipped_changed','Original Gmail thread, subject or recipient changed.');skipped++;continue;
        }
        threadId=item.gmail_thread_id;messageId=getHeader(outbound.payload?.headers||[],'Message-ID');references=getHeader(outbound.payload?.headers||[],'References');
        if(!messageId){await finish(item,'skipped_changed','Original Message-ID missing.');skipped++;continue;}
      }
      // Check CRM again after the Gmail reads and immediately before sending.
      const {data:currentSchool,error:currentError}=await supabase.from('recruiting_contacts').select('id,coach_role,coach_email,gmail_thread_id,contact_status,coach_response,follow_up_count').eq('owner_user_id',item.owner_user_id).eq('university_id',item.university_id);
      if(currentError)throw currentError;
      const current=(currentSchool||[]).find((c:any)=>c.id===contact.id);
      if(!current||!followUpEligible(current)||(currentSchool||[]).some(hasReply)||Number(current.follow_up_count)!==Number(item.expected_follow_up_count)||(!isTest&&(String(current.coach_email||'').trim().toLowerCase()!==item.recipient_email||current.gmail_thread_id!==threadId))){
        await finish(item,'skipped_changed','CRM changed before sending.');skipped++;continue;
      }
      const raw=buildReplyRaw({to:item.recipient_email,subject:item.subject,body:item.body,messageId,references});
      let result:any;
      try{result=await gmailSend(raw,threadId,token)}
      catch(e){await finish(item,"send_unknown","Test inbox send outcome is uncertain; verify Gmail manually before retrying.");unknown++;continue}
      const sentAt=new Date().toISOString();
      // A successful send API response alone does not prove that Gmail retained the body.
      try{await verifyGmailSentBody(result.id,item.body,token)}
      catch(e){await finish(item,'send_unknown','EMAIL_BODY_UNVERIFIED: '+(e instanceof Error?e.message:String(e)),{sent_at:sentAt,gmail_message_id:result.id});unknown++;continue}
      const nextCount=Number(contact.follow_up_count||0)+1;
      const nextDate=nextCount===1?localDateAfterSend(sentAt,item.school_timezone,7):null;
      const {data:updated,error:updateError}=await supabase.from("recruiting_contacts").update({
        contact_status:nextCount>=2?"no_response":"contacted",
        follow_up_count:nextCount,
        contact_count:Number(contact.contact_count||0)+1,
        last_contact_at:sentAt,
        last_follow_up_at:sentAt,
        follow_up_date:nextDate,
        auto_follow_up_enabled:false,
        next_action:(isTest?"TEST MODE: ":"")+(nextDate?"Follow-up #2送信予定 — "+nextDate+" ("+item.school_timezone+")":"2回フォローアップ済み・返信なし"),
        ...(!isTest?{gmail_thread_id:result.threadId||threadId}:{})
      }).eq("id",contact.id).eq("owner_user_id",contact.owner_user_id).eq("follow_up_count",item.expected_follow_up_count).in("contact_status",["contacted","follow_up_due"]).select("id");
      if(updateError||!updated?.length){await finish(item,"send_unknown","Self-test email was sent, but TEST CRM update failed; inspect manually.",{sent_at:sentAt,gmail_message_id:result.id});unknown++;continue}
      const {error:he}=await supabase.from("recruiting_contact_history").insert({
        owner_user_id:contact.owner_user_id,contact_id:contact.id,event_type:"follow_up_sent",event_at:sentAt,
        to_status:nextCount>=2?"no_response":"contacted",
        note:isTest?"TEST MODE: Follow-up email delivered only to "+TEST_TO:"Follow-up #"+nextCount+" 予約送信: "+item.subject,
        gmail_message_id:result.id||null,gmail_message_at:sentAt,research_ids:item.research_ids
      });
      if(he){await finish(item,"send_unknown","Self-test email and CRM update succeeded, but history insert failed.",{sent_at:sentAt,gmail_message_id:result.id});unknown++;continue}
      await finish(item,"sent",null,{sent_at:sentAt,gmail_message_id:result.id});sent++;
      if(!isTest){try{await syncReservationLabels(item)}catch(e){labelPending++;const {error:labelError}=await supabase.from('recruiting_followup_batch_items').update({error_message:'LABEL_SYNC_PENDING: '+(e instanceof Error?e.message:String(e))}).eq('id',item.id).eq('status','sent');if(labelError)console.error('Could not persist pending Gmail label',labelError);console.warn('Gmail label retry scheduled',e)}}
    }catch(e){await finish(item,"send_unknown","Test worker error: "+(e instanceof Error?e.message:String(e)));unknown++}
  }
  for(const batchId of new Set((items||[]).map((x:any)=>x.batch_id))){
    const {data:rows}=await supabase.from("recruiting_followup_batch_items").select("status").eq("batch_id",batchId);
    const states=(rows||[]).map((r:any)=>r.status);
    if(states.every((x:string)=>["sent","skipped_changed","send_unknown","cancelled"].includes(x)))
      await supabase.from("recruiting_followup_batches").update({status:states.every((x:string)=>x==="sent"||x==="cancelled")?"complete":"partial"}).eq("id",batchId).eq("status","scheduled");
  }
  return json({ok:true,claimed:(items||[]).length,sent,skipped,send_unknown:unknown,label_pending:labelPending});
});
