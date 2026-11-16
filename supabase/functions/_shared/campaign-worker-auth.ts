import {admin,checked} from './campaign-outreach.ts';
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export async function campaignWorkerInput(req:Request){
 const id=req.headers.get('x-campaign-call-id')||'',token=req.headers.get('x-campaign-call-token')||'';
 if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f]{64}$/.test(token))throw Error('Unauthorized');
 const body=await req.text();if(body.length>4096)throw Error('Unauthorized');
 const input=JSON.parse(body||'{}');
 const accepted=checked(await admin.rpc('consume_recruiting_campaign_worker_call',{p_call_id:id,p_token_hash:await hash(token),p_body_hash:await hash(body)}));
 if(accepted!==true)throw Error('Unauthorized');return input;
}
