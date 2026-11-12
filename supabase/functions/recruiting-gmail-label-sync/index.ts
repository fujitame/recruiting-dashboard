import {admin,checked,json,ownerFor} from '../_shared/campaign-outreach.ts';
import {syncContactThreadLabels} from '../_shared/recruiting-gmail-labels.ts';
export async function handler(req:Request){
 if(req.method==='OPTIONS')return json({ok:true});if(req.method!=='POST')return json({ok:false,error:'POST required'},405);
 let contact:any=null;
 try{
  const owner=await ownerFor(req),input=await req.json();
  contact=checked(await admin.from('recruiting_contacts').select('*').eq('id',input.contact_id).eq('owner_user_id',owner).single());
  if(!contact.gmail_thread_id)throw Error('Gmail thread ID is missing');
  const target=await syncContactThreadLabels(admin,contact);
  checked(await admin.from('recruiting_campaign_issues').update({status:'resolved',updated_at:new Date().toISOString()}).eq('owner_user_id',owner).eq('issue_key','contact-label:'+contact.id));
  return json({ok:true,university_id:contact.university_id,coach_name:contact.coach_name,contact_status:contact.contact_status,target_label:target,thread_id:contact.gmail_thread_id});
 }catch(e){
  const message=e instanceof Error?e.message:String(e);
  if(contact?.gmail_thread_id){const result=await admin.from('recruiting_campaign_issues').upsert({owner_user_id:contact.owner_user_id,university_id:contact.university_id,contact_ids:[contact.id],issue_key:'contact-label:'+contact.id,kind:'label_sync',blocking:false,status:'open',gmail_thread_id:contact.gmail_thread_id,details:message,updated_at:new Date().toISOString()},{onConflict:'owner_user_id,issue_key'});if(result.error)console.error('Could not persist Gmail label issue',result.error.code);}
  return json({ok:false,error:message},message==='Unauthorized'?403:400);
 }
}
Deno.serve(handler);
