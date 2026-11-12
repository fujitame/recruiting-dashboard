import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {GMAIL_ACCOUNT,getHeader,emailAddress,gmailGetThread,googleAccessToken,verifyGmailSentBody} from './followup-batch-gmail.ts';
import {timezoneForCoordinates} from './followup-batch-timezone.ts';
export const OWNER='47e7c1a9-a806-4f65-b5ed-2b9b124ef337';
export const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
export const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-headers':'authorization, apikey, content-type, x-client-info, x-recruiting-batch-worker-secret'}});
export function checked(result:any){if(result.error)throw result.error;return result.data;}
export async function ownerFor(req:Request){
 const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
 if(!token)throw new Error('Unauthorized');
 const {data,error}=await admin.auth.getUser(token);
 if(error||data.user?.id!==OWNER)throw new Error('Unauthorized');return data.user.id;
}
export async function preflight(owner:string,campaign:string,stage:string,ignore:string|null=null){
 return checked(await admin.rpc('recruiting_campaign_preflight',{p_campaign_id:campaign,p_stage:stage,p_owner_id:owner,p_ignore_delivery:ignore}));
}
export async function preview(owner:string,campaign:string,stage:string){
 const snapshot=await preflight(owner,campaign,stage);
 const schools=checked(await admin.from('recruiting_universities').select('id,name,latitude,longitude').in('id',[...new Set(snapshot.groups.map((g:any)=>g.university_id))]));
 for(const group of snapshot.groups){
  const school=schools.find((s:any)=>s.id===group.university_id);group.school_name=school?.name||'';
  try{if(school?.latitude==null||school?.longitude==null)throw Error('Coordinates unavailable');group.school_timezone=timezoneForCoordinates(school.latitude,school.longitude);}catch{group.send_reasons.push('timezone_missing');group.ready=false;}
 }
 return snapshot;
}
export async function issue(d:any,kind:string,details:string,blocking=true,key?:string){
 checked(await admin.from('recruiting_campaign_issues').upsert({owner_user_id:d.owner_user_id,campaign_id:d.campaign_id||null,university_id:d.university_id||null,contact_ids:d.contact_ids||[d.id].filter(Boolean),issue_key:key||'delivery:'+d.id,kind,blocking,status:'open',delivery_id:d.campaign_id?d.id:null,gmail_thread_id:d.gmail_thread_id||null,details:details.slice(0,3000),updated_at:new Date().toISOString()},{onConflict:'owner_user_id,issue_key'}));
}
export async function hold(d:any,message:string,unknown=false){
 checked(await admin.from('recruiting_campaign_deliveries').update({status:unknown?'send_unknown':'held',error_message:message,updated_at:new Date().toISOString()}).eq('id',d.id).neq('status','sent'));
 await issue(d,unknown?'send_unknown':'delivery_held',message);
}
export async function accountToken(){
 const token=await googleAccessToken();
 const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:'Bearer '+token}});
 const profile=await response.json();if(!response.ok||String(profile.emailAddress||'').toLowerCase()!==GMAIL_ACCOUNT)throw Error('Gmail account mismatch');return token;
}
export const marker=(id:string)=>'<crm-'+id+'@fujitame.github.io>';
export function decodedSubject(value:string){return value.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi,(_m,kind,encoded)=>{const bytes=kind.toLowerCase()==='b'?Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)):Uint8Array.from(encoded.replace(/_/g,' ').replace(/=([0-9a-f]{2})/gi,(_m:string,h:string)=>String.fromCharCode(parseInt(h,16))),c=>c.charCodeAt(0));return new TextDecoder().decode(bytes);});}
export async function verifyDelivery(d:any,id:string,token:string){
 const message=await verifyGmailSentBody(id,d.transport_body,token);
 const headers=message.payload?.headers||[];
 const recipients=getHeader(headers,'To').split(',').map((s:string)=>emailAddress(s));
 if(emailAddress(getHeader(headers,'From'))!==GMAIL_ACCOUNT||recipients.length!==1||recipients[0]!==d.recipient_email||getHeader(headers,'Message-ID').trim()!==marker(d.id)||decodedSubject(getHeader(headers,'Subject'))!==d.subject||!(message.labelIds||[]).includes('SENT'))throw Error('Gmail delivery identity mismatch');
 if(d.stage!=='initial'){
  const predecessor=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('id',d.predecessor_id).eq('owner_user_id',d.owner_user_id).single());
  if(predecessor.status!=='sent'||message.threadId!==predecessor.gmail_thread_id)throw Error('Campaign follow-up thread mismatch');
 }
 return message;
}
export async function reconcile(d:any,token:string){
 if(d.status==='sent')return {verified:true,already_sent:true};
 if(!d.transport_started_at||!d.transport_body)return {verified:false,reason:'No transport attempt recorded'};
 const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q='+encodeURIComponent('in:sent rfc822msgid:'+marker(d.id)),{headers:{Authorization:'Bearer '+token}});
 const found=await response.json();if(!response.ok)throw Error(found.error?.message||'Gmail search failed');
 if((found.messages||[]).length!==1)return {verified:false,reason:'No unique verified Gmail match; do not resend'};
 const message=await verifyDelivery(d,found.messages[0].id,token);
 checked(await admin.rpc('finalize_recruiting_campaign_delivery',{p_delivery_id:d.id,p_gmail_message_id:message.id,p_gmail_thread_id:message.threadId,p_sent_at:new Date(Number(message.internalDate)).toISOString()}));
 return {verified:true};
}
// Check every known thread at this school, including another coach and old campaigns.
export async function schoolGmailGate(d:any,token:string){
 const contacts=checked(await admin.from('recruiting_contacts').select('id,gmail_thread_id,coach_email').eq('owner_user_id',d.owner_user_id).eq('university_id',d.university_id));
 const addresses=[...new Set<string>(contacts.map((c:any)=>String(c.coach_email||'').trim().toLowerCase()).filter((email:string)=>/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)))];
 if(addresses.length){
  const q='in:anywhere -in:spam -in:trash {'+addresses.map(email=>'from:'+email).join(' ')+'}';
  const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q='+encodeURIComponent(q),{headers:{Authorization:'Bearer '+token}}),found=await r.json();if(!r.ok)throw Error('School sender reply search failed');
  if(found.messages?.length){await issue(d,'reply_attribution','学校のコーチからGmailへの受信あり。別スレッドも含めて返信を確認してください。',true,'gmail-reply:'+d.campaign_id+':'+d.university_id);throw Error('School sender reply found in Gmail; bulk outreach stopped');}
 }
 const threads=new Set<string>(contacts.map((c:any)=>c.gmail_thread_id).filter(Boolean));
 for(const table of ['recruiting_initial_email_jobs','recruiting_followup_batch_items','recruiting_campaign_deliveries']){
  const rows=checked(await admin.from(table).select('gmail_thread_id').eq('owner_user_id',d.owner_user_id).eq('university_id',d.university_id).eq('status','sent'));
  for(const row of rows)if(row.gmail_thread_id)threads.add(row.gmail_thread_id);
 }
 for(const id of threads){
  const thread=await gmailGetThread(id,token);
  if((thread.messages||[]).some((m:any)=>{const from=emailAddress(getHeader(m.payload?.headers||[],'From'));return from&&from!==GMAIL_ACCOUNT;})){
   await issue(d,'reply_attribution','Gmailの学校スレッドに返信あり。返信を取り込んで学校全体を確認してください。',true,'gmail-reply:'+d.campaign_id+':'+d.university_id);
   checked(await admin.from('recruiting_campaign_deliveries').update({status:'cancelled',cancel_requested:true,error_message:'School reply found in Gmail'}).eq('owner_user_id',d.owner_user_id).eq('university_id',d.university_id).eq('status','scheduled'));
   throw Error('School has an external Gmail response; bulk outreach stopped');
  }
 }
}
