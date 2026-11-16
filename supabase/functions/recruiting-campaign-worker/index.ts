import {isGmailGlobalStop,runPacedCampaignBatch} from '../_shared/campaign-send-control.js';
import {campaignWorkerInput} from '../_shared/campaign-worker-auth.ts';
import {runCampaignSelfTest} from '../_shared/campaign-self-test.ts';
import {admin,checked,json,preflight,hold,issue,OWNER,accountToken,schoolGmailGate,marker,verifyDelivery} from '../_shared/campaign-outreach.ts';
import {prepareEmailTracking} from '../_shared/recruiting-email-tracking.ts';
import {buildReplyRaw,gmailSend,gmailGetThread,getHeader} from '../_shared/followup-batch-gmail.ts';
import {syncCampaignDeliveryLabels} from '../_shared/recruiting-gmail-labels.ts';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function pauseAccount(error:unknown,d?:any){
 const reason=error instanceof Error?error.message:String(error);
 checked(await admin.rpc('pause_recruiting_campaign_sends',{p_owner_id:OWNER,p_reason:reason}));
 if(d)await issue(d,'delivery_held','Gmail送信を全体停止しました。制限・送信結果を確認するまで再開しません。 '+reason,true,'gmail-pause:'+OWNER);
}
async function permittedTransport(d:any,lease:string,deadline:number){
 for(;;){
  const result=checked(await admin.rpc('permit_paced_recruiting_campaign_transport',{p_delivery_id:d.id,p_token:lease}));
  if(result?.permitted)return true;
  if(result?.reason==='send_interval'){
   const delay=Math.max(1,Number(result.wait_ms)||0)+25;
   if(Date.now()+delay<deadline){await wait(delay);continue;}
  }
  if(['account_paused','worker_lease_lost','send_interval'].includes(result?.reason)){
   const stopped=new Error(result.reason);Object.assign(stopped,{campaignGateStop:true});throw stopped;
  }
  return false;
 }
}

export async function deliver(d:any,token:string,lease:string,deadline:number){
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
  const permitted=await permittedTransport(d,lease,deadline);
  if(!permitted)throw Error('Reservation cancelled or eligibility changed before sending');
  attempted=true;
  const sent=await gmailSend(raw,threadId,token);
  checked(await admin.from('recruiting_campaign_deliveries').update({gmail_message_id:sent.id,gmail_thread_id:sent.threadId}).eq('id',d.id));
  d={...d,gmail_message_id:sent.id,gmail_thread_id:sent.threadId};
  const verified=await verifyDelivery(d,sent.id,token);
  checked(await admin.rpc('finalize_recruiting_campaign_delivery',{p_delivery_id:d.id,p_gmail_message_id:verified.id,p_gmail_thread_id:verified.threadId,p_sent_at:new Date(Number(verified.internalDate)).toISOString()}));
  return 'sent';
 }catch(e){
  const current=checked(await admin.from('recruiting_campaign_deliveries').select('status,cancel_requested,transport_started_at').eq('id',d.id).single());
  if(current.status==='sent'){if(isGmailGlobalStop(e))await pauseAccount(e,d);return 'sent';} // A lost commit response must never cause resend.
  if((e as any)?.campaignGateStop&&!attempted&&!current.transport_started_at){checked(await admin.from('recruiting_campaign_deliveries').update({status:'scheduled',processing_started_at:null,updated_at:new Date().toISOString()}).eq('id',d.id).eq('status','processing').is('transport_started_at',null));return 'paused';}
  if(!attempted&&current.cancel_requested&&!current.transport_started_at){checked(await admin.from('recruiting_campaign_deliveries').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',d.id).is('transport_started_at',null));return 'cancelled';}
  const unknown=attempted||!!d.transport_started_at||!!current.transport_started_at;
  const reason=e instanceof Error?e.message:String(e);
  if(isGmailGlobalStop(e)||unknown)await pauseAccount(e,d);
  await hold(d,reason,unknown);return unknown?'send_unknown':'held';
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
  }catch(e){const reason=e instanceof Error?e.message:String(e);checked(await admin.from('recruiting_campaign_label_tasks').update({status:'failed',error_message:reason,next_attempt_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(6,task.attempts))).toISOString(),updated_at:new Date().toISOString()}).eq('delivery_id',d.id));await issue(d,'label_sync',reason,false,'label:'+d.id);failed++;if(isGmailGlobalStop(e)){await pauseAccount(e,d);break;}}
 }
 return {done,failed};
}
export async function handler(req:Request){
 if(req.method!=='POST')return json({ok:false,error:'POST required'},405);
 let input:any;try{input=await campaignWorkerInput(req);}catch{return json({ok:false,error:'Unauthorized'},403);}
 try{
  if(input.action==='self_test')return json({ok:true,test:await runCampaignSelfTest(input.test_id)});
  const lease=checked(await admin.rpc('acquire_recruiting_campaign_worker',{p_owner_id:OWNER}));
  if(!lease)return json({ok:true,deliveries:[],skipped:'worker_busy_or_account_paused'});
  try{
   const result=await runPacedCampaignBatch({
    gate:()=>admin.rpc('recruiting_campaign_worker_status',{p_owner_id:OWNER,p_token:lease}).then(checked),
    claim:async()=>checked(await admin.rpc('claim_paced_recruiting_campaign_delivery',{p_owner_id:OWNER,p_token:lease}))?.[0]||null,
    deliver:async(d:any,deadline:number)=>{
     let token:string;try{token=await accountToken();}catch(e){await pauseAccount(e,d);await hold(d,'Gmail authentication failed before transport');return 'paused';}
     return await deliver(d,token,lease,deadline);
    },
    sleep:wait
   });
   const state=checked(await admin.rpc('recruiting_campaign_worker_status',{p_owner_id:OWNER,p_token:lease}));
   const labels=state.allowed?await processLabelTasks():{skipped:'account_paused'};
   return json({ok:true,...result,labels});
  }finally{
   checked(await admin.rpc('release_recruiting_campaign_worker',{p_owner_id:OWNER,p_token:lease}));
  }
 }catch(e){if(isGmailGlobalStop(e))await pauseAccount(e);return json({ok:false,error:e instanceof Error?e.message:String(e)},500);}
}
Deno.serve(handler);

