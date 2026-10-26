import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { trackingTokenHash, RECRUITING_PROFILE_URL } from "../_shared/recruiting-email-tracking.ts";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const origin="https://fujitame.github.io";
const gif=Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),c=>c.charCodeAt(0));
const cache={"cache-control":"no-store, max-age=0","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
function automated(req:Request){return /bot|crawler|spider|scan|safelinks|headless|preview/i.test(req.headers.get("user-agent")||"")||req.headers.get("purpose")==="prefetch"||req.headers.get("sec-purpose")?.includes("prefetch")===true;}
Deno.serve(async req=>{
 const cors={"access-control-allow-origin":origin,"access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type","vary":"Origin",...cache};
 if(req.method==="OPTIONS")return new Response(null,{status:req.headers.get("origin")===origin?204:403,headers:cors});
 if(req.method==="POST"){
  if(req.headers.get("origin")!==origin)return new Response(null,{status:403,headers:cache});
  if(Number(req.headers.get("content-length")||0)>2048)return new Response(null,{status:413,headers:cors});
  try{
   const text=await req.text();if(text.length>2048)return new Response(null,{status:413,headers:cors});
   const {token,event,video_slot=""}=JSON.parse(text);
   if(typeof token!=="string"||!/^[0-9a-f]{64}$/.test(token)||!["profile_interaction","profile_active_15s","resume_click","profile_youtube_click","video_start","video_30s"].includes(event)||!["","primary","secondary"].includes(video_slot))return new Response(null,{status:400,headers:cors});
   const {error}=await db.rpc("record_recruiting_engagement_signal",{p_token_hash:await trackingTokenHash(token),p_event:event,p_video_slot:video_slot,p_automated:automated(req)});
   if(error)return new Response(null,{status:503,headers:cors});
   return new Response(null,{status:204,headers:cors});
  }catch{return new Response(null,{status:400,headers:cors});}
 }
 const url=new URL(req.url),event=url.searchParams.get("event"),token=url.searchParams.get("t")||"",valid=/^[0-9a-f]{64}$/.test(token);
 if(!["GET","HEAD"].includes(req.method))return new Response("Method not allowed",{status:405});
 if(!["open","profile","youtube"].includes(event||""))return new Response("Not found",{status:404});
 if(req.method==="GET"&&valid){
  try{await db.rpc(event==="youtube"?"record_recruiting_youtube_signal":"record_recruiting_email_signal",{p_token_hash:await trackingTokenHash(token),...(event==="youtube"?{}:{p_event:event}),p_automated:automated(req)});}catch{}
 }
 if(event==="profile")return new Response(null,{status:302,headers:{...cache,location:RECRUITING_PROFILE_URL+(valid?"#rt="+token:"")}});
 if(event==="youtube"){
  let video="kG2G7fUz1SI";
  if(valid){try{
   const {data}=await db.from("recruiting_email_tracking").select("video_targets").eq("token_hash",await trackingTokenHash(token)).maybeSingle();
   const slot=url.searchParams.get("v")||"primary",id=data?.video_targets?.[slot];
   if(typeof id==="string"&&/^[A-Za-z0-9_-]{11}$/.test(id))video=id;
  }catch{}}
  return new Response(null,{status:302,headers:{...cache,location:"https://www.youtube.com/watch?v="+video}});
 }
 return new Response(req.method==="HEAD"?null:gif,{headers:{...cache,"content-type":"image/gif"}});
});
