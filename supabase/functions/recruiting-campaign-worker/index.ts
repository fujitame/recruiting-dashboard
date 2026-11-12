import {admin,checked,json,preflight,hold,issue,accountToken,schoolGmailGate,marker,verifyDelivery} from '../_shared/campaign-outreach.ts';
import {prepareEmailTracking} from '../_shared/recruiting-email-tracking.ts';
import {buildReplyRaw,gmailSend,gmailGetThread,getHeader} from '../_shared/followup-batch-gmail.ts';
import {syncCampaignDeliveryLabels} from '../_shared/recruiting-gmail-labels.ts';
export async function deliver(d:any,token:string){
 let attempted=false;
 try{
  if(d.transport_started_at)throw Error('Transport was already attempted; reconciliation required');
  const state=await preflight(d.owner_user_id,d.campaign_id,d.stage,d.id),g=state.groups.find((g:any)=>g.source_key===d.source_key);
  if(!state.execution_enabled||!g||g.audience_reasons.length||g.send_reasons.some((r:string)=>r!=='date_past'))throw Error('Recipient, draft, or school eligibility changed');
  await schoolGmailGate(d,token);
  let threadId:string|null=null,parent='',references='';
  if(d.stage!=='initial'){
   const previous=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('owner_user_id',d.owner_user_id).eq('campaign_id',d.campaign_id).eq('id',d.predecessor_id).single());
   if(previous.status!=='sent'||previous.recipient_email!==d.recipient_email)throw Error('Previous campaign stage is not verified');
   const thread=await gmailGetThread(previous.gmail_thread_id,token),outbound=(thread.messages||[]).find((m:any)=>m.id===previous.gmail_message_id);
   parent=getHeader(outbound?.payload?.headers||[],'Message-ID');references=getHeader(outbound?.payload?.headers||[],'References');
   if(!parent)throw Error('Previous campaign Message-ID unavailable');threadId=previous.gmail_thread_id;
  }
  const tracking=await prepareEmailTracking({contactId:d.contact_ids[0],ownerId:d.owner_user_id,stage:d.stage,body:d.body,campaignDeliveryId:d.id});
  checked(await admin.from('recruiting_campaign_deliveries').update({tracking_id:tracking.id,transport_body:tracking.plain}).eq('id',d.id).eq('status','processing').is('transport_started_at',null));
  d={...d,tracking_id:tracking.id,transport_body:tracking.plain};
  const raw=buildReplyRaw({to:d.recipient_email,subject:d.subject,body:tracking.plain,htmlBody:tracking.html,messageId:parent,references,transportMessageId:marker(d.id)});
  // Read Gmail again just before the durable, compare-and-set database send gate.
  await schoolGmailGate(d,token);
  const permitted=checked(await admin.rpc('permit_recruiting_campaign_transport',{p_delivery_id:d.id}));
  if(!permitted)throw Error('Reservation cancelled or eligibility changed before sending');
  attempted=true;
  const sent=await gmailSend(raw,threadId,token);
  checked(await admin.from('recruiting_campaign_deliveries').update({gmail_message_id:sent.id,gmail_thread_id:sent.threadId}).eq('id',d.id));
  const verified=await verifyDelivery(d,sent.id,token);
  checked(await admin.rpc('finalize_recruiting_campaign_delivery',{p_delivery_id:d.id,p_gmail_message_id:verified.id,p_gmail_thread_id:verified.threadId,p_sent_at:new Date(Number(verified.internalDate)).toISOString()}));
  return 'sent';
 }catch(e){
  const current=checked(await admin.from('recruiting_campaign_deliveries').select('status,cancel_requested,transport_started_at').eq('id',d.id).single());
  if(current.status==='sent')return 'sent'; // The commit succeeded even if its response was lost.
  if(!attempted&&current.cancel_requested&&!current.transport_started_at){checked(await admin.from('recruiting_campaign_deliveries').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',d.id).is('transport_started_at',null));return 'cancelled';}
  const unknown=attempted||!!d.transport_started_at||!!current.transport_started_at;
  const reason=e instanceof Error?e.message:String(e);await hold(d,reason,unknown);return unknown?'send_unknown':'held';
 }
}
export async function processLabelTasks(){
 checked(await admin.from('recruiting_campaign_label_tasks').update({status:'failed',next_attempt_at:new Date().toISOString()}).eq('status','processing').lt('updated_at',new Date(Date.now()-600000).toISOString()));
 const tasks=checked(await admin.from('recruiting_campaign_label_tasks').select('*').in('status',['pending','failed']).lte('next_attempt_at',new Date().toISOString()).order('next_attempt_at').limit(10));
 let done=0,failed=0;
 for(const task of tasks){
  const claimed=checked(await admin.from('recruiting_campaign_label_tasks').update({status:'processing',attempts:task.attempts+1,updated_at:new Date().toISOString()}).eq('delivery_id',task.delivery_id).in('status',['pending','failed']).select('delivery_id'));
  if(!claimed.length)continue;
  const d=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('id',task.delivery_id).single());
  try{
   await syncCampaignDeliveryLabels(admin,d);
   checked(await admin.from('recruiting_campaign_label_tasks').update({status:'done',error_message:null,updated_at:new Date().toISOString()}).eq('delivery_id',d.id));
   checked(await admin.from('recruiting_campaign_issues').update({status:'resolved',updated_at:new Date().toISOString()}).eq('owner_user_id',d.owner_user_id).eq('issue_key','label:'+d.id));done++;
  }catch(e){const reason=e instanceof Error?e.message:String(e);checked(await admin.from('recruiting_campaign_label_tasks').update({status:'failed',error_message:reason,next_attempt_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(6,task.attempts))).toISOString(),updated_at:new Date().toISOString()}).eq('delivery_id',d.id));await issue(d,'label_sync',reason,false,'label:'+d.id);failed++;}
 }
 return {done,failed};
}
export async function handler(req:Request){
 if(req.method!=='POST')return json({ok:false,error:'POST required'},405);
 const secret=Deno.env.get('FOLLOWUP_BATCH_WORKER_SECRET');
 if(!secret||req.headers.get('x-recruiting-batch-worker-secret')!==secret)return json({ok:false,error:'Unauthorized'},403);
 try{
  const results=[];
  for(let i=0;i<5;i++){
   const rows=checked(await admin.rpc('claim_recruiting_campaign_delivery'));if(!rows?.length)break;
   const d=rows[0];let token;
   try{token=await accountToken();}catch(e){await hold(d,'Gmail authentication failed before transport');throw e;}
   results.push({id:d.id,status:await deliver(d,token)});
  }
  return json({ok:true,deliveries:results,labels:await processLabelTasks()});
 }catch(e){return json({ok:false,error:e instanceof Error?e.message:String(e)},500);}
}
Deno.serve(handler);
