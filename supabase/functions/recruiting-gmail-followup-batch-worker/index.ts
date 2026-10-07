import { createClient } from "npm:@supabase/supabase-js@2";
import { buildReplyRaw, emailAddress, gmailGetThread, gmailSend, getHeader, googleAccessToken, latestOutbound, threadReplyFrom, plainTextMessage, GMAIL_ACCOUNT } from "../_shared/followup-batch-gmail.ts";
import { localDateAfterSend } from "../_shared/followup-batch-timezone.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const secret = Deno.env.get("FOLLOWUP_BATCH_WORKER_SECRET") || "";

function reply(body: unknown, status=200) { return new Response(JSON.stringify(body), {status, headers: {"content-type":"application/json"}}); }
async function recordReply(contact:any, message:any) {
  const at = new Date(Number(message.internalDate || Date.now())).toISOString();
  const headers = message.payload?.headers || [];
  const msgId = getHeader(headers,"Message-ID") || String(message.id || "");
  await supabase.from("recruiting_contacts").update({contact_status:"responded",coach_response:plainTextMessage(message).slice(0,4000) || "Gmail reply detected",last_contact_at:at,follow_up_date:null,auto_follow_up_enabled:false,next_action:"返信内容を確認"}).eq("id",contact.id).eq("owner_user_id",contact.owner_user_id);
  await supabase.from("recruiting_contact_history").upsert({owner_user_id:contact.owner_user_id,contact_id:contact.id,event_type:"reply_received",event_at:at,note:"予約一括送信直前にGmail返信を検出",to_status:"responded",gmail_message_id:msgId || null,gmail_message_at:at},{onConflict:"owner_user_id,gmail_message_id",ignoreDuplicates:true});
}
async function finishItem(item:any,status:string,error?:string,extra:any={}) {
  await supabase.from("recruiting_followup_batch_items").update({status,error_message:error || null,...extra}).eq("id",item.id).eq("status","processing");
}
Deno.serve(async req => {
  if (req.method==="OPTIONS") return new Response("ok");
  if (req.method!=="POST" || !secret || req.headers.get("x-recruiting-batch-worker-secret")!==secret) return reply({ok:false,error:"Unauthorized"},401);
  const {data:items,error}=await supabase.rpc("claim_due_recruiting_followup_batch_items",{p_limit:10});
  if(error) return reply({ok:false,error:error.message},500);
  let sent=0, skipped=0, unknown=0;
  for(const item of items || []) {
    try {
      const {data:contact,error:ce}=await supabase.from("recruiting_contacts").select("id,owner_user_id,university_id,coach_email,coach_response,contact_status,follow_up_count,follow_up_date,gmail_thread_id,contact_count").eq("id",item.contact_id).eq("owner_user_id",item.owner_user_id).maybeSingle();
      if(ce) throw ce;
      if(!contact || !["contacted","follow_up_due"].includes(contact.contact_status) || Number(contact.follow_up_count||0)!==Number(item.expected_follow_up_count) || contact.coach_response || !contact.gmail_thread_id || contact.gmail_thread_id===null) {
        await finishItem(item,"skipped_changed","CRM状態が予約時から変更されています。"); skipped++; continue;
      }
      const token=await googleAccessToken();
      const thread=await gmailGetThread(contact.gmail_thread_id,token);
      const replyMsg=threadReplyFrom(thread,contact.coach_email);
      if(replyMsg) { await recordReply(contact,replyMsg); await finishItem(item,"skipped_reply","送信直前に返信を検出しました。"); skipped++; continue; }
      const outbound=latestOutbound(thread);
      if(!outbound) { await finishItem(item,"skipped_changed","Gmailスレッドの送信履歴を確認できません。"); skipped++; continue; }
      const headers=outbound.payload?.headers||[];
      const raw=buildReplyRaw({to:contact.coach_email,subject:item.subject,body:item.body,messageId:getHeader(headers,"Message-ID"),references:getHeader(headers,"References")});
      let gmailResult:any;
      try { gmailResult=await gmailSend(raw,contact.gmail_thread_id,token); }
      catch(e) { await finishItem(item,"send_unknown","Gmail送信結果を確認できません。二重送信防止のため自動再送していません。"); unknown++; continue; }
      const sentAt=new Date().toISOString();
      const nextCount=Number(contact.follow_up_count||0)+1;
      const nextDate=nextCount===1 ? localDateAfterSend(sentAt,item.school_timezone,7) : null;
      const {error:updateError}=await supabase.from("recruiting_contacts").update({
        contact_status: nextCount>=2 ? "no_response" : "contacted",
        follow_up_count: nextCount,
        contact_count: (Number((contact as any).contact_count)||0)+1,
        last_contact_at: sentAt,
        follow_up_date: nextDate,
        auto_follow_up_enabled: false,
        next_action: nextDate ? "次回Follow-upを確認 — "+nextDate+" ("+item.school_timezone+")" : "Follow-up上限到達 — 返信を待つ"
      }).eq("id",contact.id).eq("owner_user_id",contact.owner_user_id);
      if(updateError) { await finishItem(item,"send_unknown","Gmail送信済み。CRM更新に失敗したため手動確認が必要です。",{sent_at:sentAt,gmail_message_id:gmailResult.id}); unknown++; continue; }
      const {error:historyError}=await supabase.from("recruiting_contact_history").insert({
        owner_user_id:contact.owner_user_id,contact_id:contact.id,event_type:"follow_up_sent",event_at:sentAt,
        to_status: nextCount>=2 ? "no_response" : "contacted",note:"ユーザー確認済み一括Follow-up送信",
        gmail_message_id:gmailResult.id,gmail_message_at:sentAt,research_ids:item.research_ids
      });
      if(historyError) { await finishItem(item,"send_unknown","送信・CRM更新済み。履歴保存に失敗したため手動確認が必要です。",{sent_at:sentAt,gmail_message_id:gmailResult.id}); unknown++; continue; }
      await finishItem(item,"sent",null,{sent_at:sentAt,gmail_message_id:gmailResult.id}); sent++;
    } catch(e) {
      // If the error happened after claiming, fail closed; never auto-retry an uncertain send.
      await finishItem(item,"send_unknown","処理中にエラー: "+(e instanceof Error?e.message:String(e)));
      unknown++;
    }
  }
  const batchIds=Array.from(new Set((items||[]).map((i:any)=>i.batch_id)));
  for(const id of batchIds) {
    const {data:rows}=await supabase.from("recruiting_followup_batch_items").select("status").eq("batch_id",id);
    const states=(rows||[]).map((r:any)=>r.status);
    const done=states.every((s:string)=>["sent","skipped_reply","skipped_changed","send_unknown","cancelled"].includes(s));
    if(done) await supabase.from("recruiting_followup_batches").update({status:states.every((s:string)=>s==="sent"||s==="cancelled")?"complete":"partial"}).eq("id",id).eq("status","scheduled");
  }
  return reply({ok:true,claimed:(items||[]).length,sent,skipped,send_unknown:unknown});
});