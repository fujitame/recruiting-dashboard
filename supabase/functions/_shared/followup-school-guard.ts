import { anyThreadReply, gmailGetThread, latestOutbound, outboundIncludesRecipient, plainTextMessage, getHeader } from './followup-batch-gmail.ts';
import { followUpEligible, hasReply } from './followup-batch-policy.ts';

// Every recruiting Follow-up path uses the same school-wide reply gate.
export async function guardSchoolFollowUp(db:any, contact:any, token:string) {
  if(!followUpEligible(contact))return {blocked:true,reason:'Contact is not awaiting recruiting Follow-up.',thread:null};
  const {data:siblings,error}=await db.from('recruiting_contacts').select('*').eq('owner_user_id',contact.owner_user_id).eq('university_id',contact.university_id);
  if(error)throw error;
  if((siblings||[]).some(hasReply))return {blocked:true,reason:'A coach at this school has replied.',thread:null};
  const threads=new Map<string,any>();
  for(const sibling of siblings||[]) {
    if(!sibling.gmail_thread_id)continue;
    if(!threads.has(sibling.gmail_thread_id))threads.set(sibling.gmail_thread_id,await gmailGetThread(sibling.gmail_thread_id,token));
    const reply=anyThreadReply(threads.get(sibling.gmail_thread_id));
    if(reply){
      const at=new Date(Number(reply.internalDate)||Date.now()).toISOString();
      const {error:updateError}=await db.from('recruiting_contacts').update({contact_status:'responded',coach_response:plainTextMessage(reply).slice(0,4000)||getHeader(reply.payload?.headers||[],'Subject')||'Gmail返信あり',follow_up_date:null,auto_follow_up_enabled:false,next_action:'Coachの返信を個別CRMで確認'}).eq('id',sibling.id).eq('owner_user_id',contact.owner_user_id);
      if(updateError)throw updateError;
      const {data:existing,error:lookupError}=await db.from('recruiting_contact_history').select('id').eq('contact_id',sibling.id).eq('gmail_message_id',reply.id).eq('event_type','reply_received');
      if(lookupError)throw lookupError;
      if(!existing?.length){const {error:historyError}=await db.from('recruiting_contact_history').insert({owner_user_id:contact.owner_user_id,contact_id:sibling.id,event_type:'reply_received',event_at:at,to_status:'responded',note:'Follow-up前にGmail返信を検出: '+plainTextMessage(reply).slice(0,4000),gmail_message_id:reply.id,gmail_message_at:at});if(historyError)throw historyError;}
      return {blocked:true,reason:'A coach at this school replied in Gmail.',thread:null};
    }
  }
  const thread=threads.get(contact.gmail_thread_id);
  const outbound=latestOutbound(thread);
  if(!outbound||!outboundIncludesRecipient(outbound,contact.coach_email))return {blocked:true,reason:'Original Gmail thread recipient does not match.',thread:null};
  const {data:current,error:currentError}=await db.from('recruiting_contacts').select('*').eq('owner_user_id',contact.owner_user_id).eq('university_id',contact.university_id);
  if(currentError)throw currentError;
  const live=(current||[]).find((c:any)=>c.id===contact.id);
  if(!live||!followUpEligible(live)||(current||[]).some(hasReply)||Number(live.follow_up_count)!==Number(contact.follow_up_count)||live.gmail_thread_id!==contact.gmail_thread_id||String(live.coach_email).toLowerCase()!==String(contact.coach_email).toLowerCase())return {blocked:true,reason:'CRM changed while checking Gmail.',thread:null};
  const {data:pending,error:pendingError}=await db.from('recruiting_followup_batch_items').select('id').eq('contact_id',contact.id).in('status',['scheduled','processing','send_unknown']);
  if(pendingError)throw pendingError;
  if(pending?.length)return {blocked:true,reason:'A reservation already owns this Follow-up.',thread:null};
  return {blocked:false,reason:'',thread};
}
