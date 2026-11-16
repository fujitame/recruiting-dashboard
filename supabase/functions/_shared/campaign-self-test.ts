import {admin,checked,accountToken,verifyDelivery,marker} from './campaign-outreach.ts';
import {prepareEmailTracking,recordEmailTrackingResult} from './recruiting-email-tracking.ts';
import {GMAIL_ACCOUNT,buildReplyRaw,gmailSend} from './followup-batch-gmail.ts';
import {syncCampaignDeliveryLabels} from './recruiting-gmail-labels.ts';
export const SELF_TEST_TO='fujitame@gmail.com';
export const SELF_TEST_COPY='fujiakihiro8@gmail.com';
async function markTestLabel(messageId:string,token:string){
 const request=async(path:string,init:RequestInit={})=>{
  const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...init,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
  const value=await r.json();if(!r.ok)throw Error('Test label operation failed');return value;
 };
 let labels=await request('labels'),label=labels.labels?.find((l:any)=>l.name==='Recruiting/Tests');
 if(!label)label=await request('labels',{method:'POST',body:JSON.stringify({name:'Recruiting/Tests',labelListVisibility:'labelShow',messageListVisibility:'show'})});
 await request('messages/'+encodeURIComponent(messageId)+'/modify',{method:'POST',body:JSON.stringify({addLabelIds:[label.id],removeLabelIds:[]})});
}
export async function runCampaignSelfTest(id:string){
 if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid self-test id');
 let t=checked(await admin.from('recruiting_campaign_self_tests').select('*').eq('id',id).single());
 if(t.recipient_email!==SELF_TEST_TO||t.copy_email!==SELF_TEST_COPY||GMAIL_ACCOUNT!==SELF_TEST_COPY)throw Error('Self-test address mismatch');
 const c=checked(await admin.from('recruiting_contacts').select('id,university_id,coach_email').eq('id',t.contact_id).eq('owner_user_id',t.owner_user_id).single());
 const u=checked(await admin.from('recruiting_universities').select('is_test').eq('id',c.university_id).single());
 const campaign=checked(await admin.from('recruiting_campaigns').select('id').eq('id',t.campaign_id).eq('owner_user_id',t.owner_user_id).single());
 if(!campaign||!u.is_test||c.coach_email!==SELF_TEST_TO)throw Error('Self-test requires the configured test contact');
 if(!['pending','sent','send_unknown'].includes(t.status))return {status:t.status,test_id:t.id,resent:false};
 if(t.status==='sent'&&t.label_status==='done')return {status:'sent',test_id:t.id,resent:false,label_status:'done'};
 let token:string;
 if(t.status==='send_unknown'){
  if(!t.gmail_message_id||!t.transport_body||!t.tracking_id)return {test_id:t.id,status:'send_unknown',resent:false};
  token=await accountToken();
  const verified=await verifyDelivery({...t,stage:'initial'},t.gmail_message_id,token);
  if(!await recordEmailTrackingResult(t.tracking_id,verified.id,true))throw Error('Tracking reconciliation failed');
  const sentAt=new Date(Number(verified.internalDate)).toISOString();
  checked(await admin.from('recruiting_campaign_self_tests').update({status:'sent',sent_at:sentAt,error_message:null,updated_at:new Date().toISOString()}).eq('id',t.id));
  t={...t,status:'sent',sent_at:sentAt};
 }
 if(t.status==='pending'){
  const claimed=checked(await admin.from('recruiting_campaign_self_tests').update({status:'processing',attempt_count:1,updated_at:new Date().toISOString()}).eq('id',id).eq('status','pending').eq('attempt_count',0).select('*'));
  if(!claimed?.length)return {status:'already_claimed',test_id:id,resent:false};
  t=claimed[0];let attempted=false,tracking:any=null,sent:any=null;
  try{
   token=await accountToken();
   tracking=await prepareEmailTracking({contactId:t.contact_id,ownerId:t.owner_user_id,stage:'initial',body:t.body,isTest:true,campaignFormat:true,testRunId:t.id});
   checked(await admin.from('recruiting_campaign_self_tests').update({tracking_id:tracking.id,transport_body:tracking.plain}).eq('id',t.id));
   const raw=buildReplyRaw({to:SELF_TEST_TO,cc:[SELF_TEST_COPY],subject:t.subject,body:tracking.plain,htmlBody:tracking.html,messageId:'',references:'',transportMessageId:marker(t.id)});
   const started=checked(await admin.from('recruiting_campaign_self_tests').update({transport_started_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',t.id).eq('status','processing').is('transport_started_at',null).select('id'));
   if(!started?.length)throw Error('Self-test transport already started');
   attempted=true;sent=await gmailSend(raw,null,token);
   checked(await admin.from('recruiting_campaign_self_tests').update({gmail_message_id:sent.id,gmail_thread_id:sent.threadId}).eq('id',t.id));
   const verified=await verifyDelivery({...t,id:t.id,stage:'initial',recipient_email:SELF_TEST_TO,transport_body:tracking.plain,gmail_message_id:sent.id,gmail_thread_id:sent.threadId},sent.id,token);
   if(!await recordEmailTrackingResult(tracking.id,verified.id,true))throw Error('Self-test tracking commit failed; do not resend');
   const sentAt=new Date(Number(verified.internalDate)).toISOString();
   checked(await admin.from('recruiting_campaign_self_tests').update({status:'sent',gmail_message_id:verified.id,gmail_thread_id:verified.threadId,sent_at:sentAt,updated_at:new Date().toISOString()}).eq('id',t.id));
   t={...t,status:'sent',gmail_message_id:verified.id,gmail_thread_id:verified.threadId,sent_at:sentAt};
  }catch(e){
   const error=e instanceof Error?e.message:String(e);
   if(attempted&&tracking)await recordEmailTrackingResult(tracking.id,sent?.id||null,false);
   checked(await admin.from('recruiting_campaign_self_tests').update({status:attempted?'send_unknown':'failed',error_message:error,updated_at:new Date().toISOString()}).eq('id',t.id));
   return {test_id:t.id,status:attempted?'send_unknown':'failed',error};
  }
 }else token=await accountToken();
 try{
  const state=await syncCampaignDeliveryLabels(admin,{...t,contact_ids:[t.contact_id],stage:'initial',status:'sent'});
  await markTestLabel(t.gmail_message_id,token!);
  checked(await admin.from('recruiting_campaign_self_tests').update({label_status:'done',state_label:state,error_message:null,updated_at:new Date().toISOString()}).eq('id',t.id));
  return {test_id:t.id,status:'sent',label_status:'done',state_label:state};
 }catch(e){
  const error=e instanceof Error?e.message:String(e);
  checked(await admin.from('recruiting_campaign_self_tests').update({label_status:'failed',error_message:error,updated_at:new Date().toISOString()}).eq('id',t.id));
  return {test_id:t.id,status:'sent',label_status:'failed',error};
 }
}
