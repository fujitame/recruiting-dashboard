import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { trackingTokenHash, RECRUITING_PROFILE_URL } from "../_shared/recruiting-email-tracking.ts";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const gif=Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),c=>c.charCodeAt(0));
// Public image/link endpoint: only unguessable tokens can affect a tracking row. No anonymous reads.
Deno.serve(async req=>{
 const url=new URL(req.url),event=url.searchParams.get("event"),token=url.searchParams.get("t")||"";
 if(!["GET","HEAD"].includes(req.method))return new Response("Method not allowed",{status:405});
 if(!["open","profile"].includes(event||""))return new Response("Not found",{status:404});
 if(req.method==="GET"&&/^[0-9a-f]{64}$/.test(token)){
  const ua=req.headers.get("user-agent")||"";
  const automated=/bot|crawler|spider|scan|safelinks|headless|preview/i.test(ua)||req.headers.get("purpose")==="prefetch"||req.headers.get("sec-purpose")?.includes("prefetch")===true;
  try{const {error}=await db.rpc("record_recruiting_email_signal",{p_token_hash:await trackingTokenHash(token),p_event:event,p_automated:automated});if(error)console.warn("Email signal storage failed");}catch{console.warn("Email signal storage unavailable");}
 }
 const headers={"cache-control":"no-store, max-age=0","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
 if(event==="profile")return new Response(null,{status:302,headers:{...headers,location:RECRUITING_PROFILE_URL}});
 return new Response(req.method==="HEAD"?null:gif,{headers:{...headers,"content-type":"image/gif"}});
});
