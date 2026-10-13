import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { buildReplyRaw, gmailSend, verifyGmailSentBody } from "./followup-batch-gmail.ts";

export const RECRUITING_PROFILE_URL = "https://fujitame.github.io/profile/";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {auth:{persistSession:false}});
const encode = new TextEncoder();
export async function trackingTokenHash(token: string): Promise<string> {
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encode.encode(token))),x=>x.toString(16).padStart(2,"0")).join("");
}
export function trackingHtml(body: string, pixelUrl: string): string {
 const escape=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
 const content=escape(body).replace(/https?:\/\/[^\s<]+/g,url=>'<a href="'+url+'">'+(url.includes('/functions/v1/recruiting-email-events?event=profile')?'View Recruiting Profile':url)+'</a>');
 return '<!doctype html><html><body><div style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.5">'+content+'</div><img src="'+escape(pixelUrl)+'" width="1" height="1" alt="" style="border:0" /></body></html>';
}
export async function prepareEmailTracking(args: {contactId:string;ownerId:string;stage:string;body:string;reservationItemId?:string;isTest?:boolean}): Promise<any> {
 if(!args.body.trim())throw new Error("Email body must not be empty.");
 const identity=args.reservationItemId||crypto.randomUUID();
 const secret=Deno.env.get("FOLLOWUP_BATCH_WORKER_SECRET");
 if(!secret)throw new Error("Email tracking signing secret unavailable.");
 const key=await crypto.subtle.importKey("raw",encode.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=await crypto.subtle.sign("HMAC",key,encode.encode("email-tracking:v1:"+identity));
 const token=Array.from(new Uint8Array(signature),x=>x.toString(16).padStart(2,"0")).join("");
 const tokenHash=await trackingTokenHash(token);
 const base=Deno.env.get("SUPABASE_URL")!+"/functions/v1/recruiting-email-events";
 const clickUrl=base+"?event=profile&t="+token;
 // Keep the preview text as approved. Substitute only the known fixed Profile URL at transport time.
 const plain=args.body.replace(/https:\/\/fujitame\.github\.io\/profile\/?(?=$|[\s)])/g,()=>clickUrl);
 const html=trackingHtml(plain,base+"?event=open&t="+token);
 const {data:contact,error:contactError}=await admin.from("recruiting_contacts").select("university_id,coach_email").eq("id",args.contactId).eq("owner_user_id",args.ownerId).single();
 if(contactError||!contact)throw new Error("Tracking contact unavailable.");
 const row={owner_user_id:args.ownerId,contact_id:args.contactId,university_id:contact.university_id,recipient_email:String(contact.coach_email||'').trim().toLowerCase(),reservation_item_id:args.reservationItemId||null,token_hash:tokenHash,stage:args.stage,is_test:args.isTest===true};
 const {data,error}=await admin.from("recruiting_email_tracking").insert(row).select("id").single();
 if(error)throw new Error("Tracking preparation failed; an uncertain earlier send must be checked before retrying: "+error.message);
 return {id:data.id,plain,html};
}

export async function finalizeTrackedRegularFollowUp(trackingId:string,contactPayload:any,historyPayload:any):Promise<any[]> {
 const {data,error}=await admin.rpc("finalize_tracked_recruiting_followup",{p_tracking_id:trackingId,p_contact:contactPayload,p_history:historyPayload});
 if(error||!data?.length)throw new Error("Gmail送信済みですがCRM記録を確定できません。再送せず確認してください。 "+(error?.message||"No contacts updated"));
 return data;
}
export async function sendTrackedFollowUp(args: {contactId:string;ownerId:string;stage:string;body:string;to:string;subject:string;messageId:string;references:string;threadId:string|null;token:string;reservationItemId?:string;isTest?:boolean}): Promise<any> {
 const tracking=await prepareEmailTracking(args);
 let result:any=null;
 try {
  const raw=buildReplyRaw({to:args.to,subject:args.subject,body:tracking.plain,htmlBody:tracking.html,messageId:args.messageId,references:args.references});
  result=await gmailSend(raw,args.threadId,args.token);
  const sentAt=new Date().toISOString();
  const pending=await admin.from("recruiting_email_tracking").update({status:"send_unknown",gmail_message_id:result.id,sent_at:sentAt}).eq("id",tracking.id);
  if(pending.error)throw pending.error;
  await verifyGmailSentBody(result.id,tracking.plain,args.token);
  const done=await admin.from("recruiting_email_tracking").update({status:"sent"}).eq("id",tracking.id);
  if(done.error)throw done.error;
  return {...result,tracking_id:tracking.id};
 } catch(error) {
  await admin.from("recruiting_email_tracking").update({status:"send_unknown",...(result?.id?{gmail_message_id:result.id,sent_at:new Date().toISOString()}:{})}).eq("id",tracking.id);
  const uncertain=new Error("送信結果の確認が必要です。再送せずGmailを確認してください。 "+(error instanceof Error?error.message:String(error)));
  Object.assign(uncertain,{gmailMessageId:result?.id||null});throw uncertain;
 }
}
