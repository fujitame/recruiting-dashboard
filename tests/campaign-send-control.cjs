// No network, database, or email transport is used by these tests.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/campaign-send-control.js'),'utf8');
const {gmailResponseError,isGmailGlobalStop,runPacedCampaignBatch}=new Function(source.replace(/^export /gm,'')+'\nreturn {gmailResponseError,isGmailGlobalStop,runPacedCampaignBatch};')();
(async()=>{
 for(const status of [401,403,429])assert.equal(isGmailGlobalStop(gmailResponseError({status,headers:{get:()=>null}},{error:{message:'Rejected'}})),true);
 assert.equal(isGmailGlobalStop(gmailResponseError({status:400},{error:{message:'Invalid recipient'}})),false);
 let clock=0,next=0,claims=0;const times=[];
 await runPacedCampaignBatch({now:()=>clock,gate:async()=>({allowed:true,wait_ms:Math.max(0,next-clock)}),claim:async()=>({id:++claims}),deliver:async()=>{times.push(clock);next=clock+30000;return 'sent';},sleep:async ms=>{clock+=ms;}});
 assert.equal(times.length,2);assert.ok(times[1]-times[0]>=30000);
 for(const reason of ['account_paused','worker_lease_lost']){
 let calls=0;const result=await runPacedCampaignBatch({gate:async()=>({allowed:false,reason}),claim:async()=>{calls++;},deliver:async()=>{throw Error('must not send');},sleep:async()=>{}});
 assert.equal(calls,0);assert.equal(result.stopped,reason);
 }
 let calls=0;const result=await runPacedCampaignBatch({gate:async()=>({allowed:true,wait_ms:0}),claim:async()=>({id:++calls}),deliver:async()=> 'send_unknown',sleep:async()=>{}});
 assert.equal(calls,1);assert.equal(result.stopped,'send_unknown');
 console.log('PASS: pacing, Gmail limit classification, pause, lease loss, and no retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
