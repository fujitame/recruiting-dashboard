import {admin,checked,json,ownerFor,preview,accountToken,reconcile} from '../_shared/campaign-outreach.ts';
import {syncCampaignDeliveryLabels,syncRecruitingThreadLabels,syncContactThreadLabels,googleAccessToken} from '../_shared/recruiting-gmail-labels.ts';
import {gmailGetThread,GMAIL_ACCOUNT} from '../_shared/followup-batch-gmail.ts';
import {liveReplyStateLabel} from '../_shared/campaign-reply-attribution.js';
export async function handler(req:Request){
 if(req.method==='OPTIONS')return json({ok:true});if(req.method!=='POST')return json({ok:false,error:'POST required'},405);
 try{
  const owner=await ownerFor(req),input=await req.json();
  if(input.action==='preview')return json({ok:true,...await preview(owner,input.campaign_id,input.stage)});
  if(input.action==='schedule'){
   if(input.reviewed!==true||!Array.isArray(input.groups)||!input.groups.length)throw Error('Review recipients, content, and dates first');
   const current=await preview(owner,input.campaign_id,input.stage);
   if(!current.execution_enabled)throw Error('②学校別日程・③メール内容の確定後に有効化します。');
   const groups=input.groups.map((r:any)=>{const g=current.groups.find((g:any)=>g.source_key===r.source_key&&g.ready);if(!g)throw Error('Preview changed; review again');return {source_key:g.source_key,school_timezone:g.school_timezone};});
   return json({ok:true,deliveries:checked(await admin.rpc('schedule_recruiting_campaign',{p_owner_id:owner,p_campaign_id:input.campaign_id,p_stage:input.stage,p_groups:groups}))});
  }
  if(input.action==='retry_issue'){
   const item=checked(await admin.from('recruiting_campaign_issues').select('*').eq('owner_user_id',owner).eq('id',input.issue_id).single());
   if(item.kind!=='label_sync'||!item.gmail_thread_id)throw Error('Only Gmail label failures can be retried here');
   checked(await admin.from('recruiting_campaign_issues').update({attempts:item.attempts+1,updated_at:new Date().toISOString()}).eq('id',item.id).eq('owner_user_id',owner));
   if(item.delivery_id){const d=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('owner_user_id',owner).eq('id',item.delivery_id).single());await syncCampaignDeliveryLabels(admin,d);checked(await admin.from('recruiting_campaign_label_tasks').update({status:'done',error_message:null,updated_at:new Date().toISOString()}).eq('delivery_id',d.id));}
   else{
    const ds=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('owner_user_id',owner).eq('gmail_thread_id',item.gmail_thread_id).eq('status','sent').order('sent_at',{ascending:false}).limit(1));
    if(ds.length)await syncCampaignDeliveryLabels(admin,ds[0]);
    else{
     const cs=checked(await admin.from('recruiting_contacts').select('*').eq('owner_user_id',owner).eq('gmail_thread_id',item.gmail_thread_id).limit(1));
     if(cs.length)await syncContactThreadLabels(admin,cs[0]);
     else{const target=liveReplyStateLabel(await gmailGetThread(item.gmail_thread_id,await googleAccessToken()),GMAIL_ACCOUNT);if(!target)throw Error('Thread state unavailable');await syncRecruitingThreadLabels(item.gmail_thread_id,target);}
    }
   }
   checked(await admin.from('recruiting_campaign_issues').update({status:'resolved',updated_at:new Date().toISOString()}).eq('id',item.id).eq('owner_user_id',owner));return json({ok:true});
  }
  const d=checked(await admin.from('recruiting_campaign_deliveries').select('*').eq('id',input.delivery_id).eq('owner_user_id',owner).single());
  if(input.action==='reconcile')return json({ok:true,...await reconcile(d,await accountToken())});
  if(input.action==='cancel'){
   if(!['scheduled','held','processing'].includes(d.status)||d.transport_started_at)throw Error('A transport attempt must be reconciled; do not cancel and resend');
   const result=checked(await admin.from('recruiting_campaign_deliveries').update({status:d.status==='processing'?'processing':'cancelled',cancel_requested:true,updated_at:new Date().toISOString()}).eq('id',d.id).eq('owner_user_id',owner).is('transport_started_at',null).in('status',['scheduled','held','processing']).select('id'));
   if(!result.length)throw Error('Delivery changed; refresh before continuing');
   checked(await admin.from('recruiting_campaign_issues').update({status:'resolved',updated_at:new Date().toISOString()}).eq('owner_user_id',owner).eq('delivery_id',d.id).eq('kind','delivery_held'));return json({ok:true});
  }
  throw Error('Unknown action');
 }catch(e){return json({ok:false,error:e instanceof Error?e.message:String(e)},String(e).includes('Unauthorized')?403:400);}
}
Deno.serve(handler);
