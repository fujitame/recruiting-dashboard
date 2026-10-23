const assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
const source=fs.readFileSync("supabase/functions/recruiting-gmail-initial-campaign-worker/index.ts","utf8");
const f=source.slice(source.indexOf("export function eligibleJob"),source.indexOf("async function updateJob")).replace("export ","");
const sandbox={};vm.runInNewContext(f+";this.check=eligibleJob",sandbox);
const at=Date.parse("2026-10-23T15:00:00Z"),owner="47e7c1a9-a806-4f65-b5ed-2b9b124ef337";
const j={campaign_key:"ca-new-d1-d2-20261023-0800",university_id:107,owner_user_id:owner,school_timezone:"America/Los_Angeles",scheduled_at:new Date(at).toISOString(),recipient_email:"coach@school.edu",contact_id:"a",contact_ids:["a","b"]};
const c={id:"a",owner_user_id:owner,university_id:107,coach_email:"coach@school.edu",contact_status:"not_contacted",contact_count:0,gmail_thread_id:null,coach_response:""},cs=[c,{...c,id:"b"}],s={is_active:true,is_test:false,division:"NCAA D2"};
assert(sandbox.check(j,cs,s,at));
assert(!sandbox.check(j,cs,s,at-1));assert(!sandbox.check(j,cs,s,at+2*3600000));
assert(!sandbox.check(j,[c],s,at));assert(!sandbox.check(j,[c,{...cs[1],contact_count:1}],s,at));
assert(!sandbox.check(j,[c,{...cs[1],coach_response:"replied"}],s,at));
assert(!sandbox.check(j,cs,{...s,is_test:true},at));
assert(!sandbox.check({...j,university_id:127},cs,s,at));
assert(!sandbox.check({...j,recipient_email:"other@school.edu"},cs,s,at));
assert(source.includes("verifyGmailSentBody"));assert(source.indexOf("verifyGmailSentBody(accepted.id")<source.indexOf('db.rpc("finalize_recruiting_initial_job"'));
console.log("Initial campaign scope, shared recipient, timing, changed CRM and verified-body guards passed");

