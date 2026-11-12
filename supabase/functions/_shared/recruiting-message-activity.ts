import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
const activityAdmin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
// Add attribution after the existing accepted-send/receive path. Failure never retries mail.
export async function recordMessageActivity(owner:string,contact:string,message:string,thread:string,parent:string|null=null){
 if(!message)return false;
 try{const {error}=await activityAdmin.rpc('record_recruiting_message_activity',{p_owner_id:owner,p_contact_id:contact,p_message_id:message,p_thread_id:thread||null,p_parent_id:parent||null});if(error)throw error;return true;}
 catch(error){console.warn('Activity attribution pending; original history is preserved',error instanceof Error?error.message:String(error));return false;}
}

