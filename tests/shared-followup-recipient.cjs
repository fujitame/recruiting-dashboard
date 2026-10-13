const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
const policy=fs.readFileSync('supabase/functions/_shared/followup-batch-policy.ts','utf8').replace(/^export /gm,'');
const html=fs.readFileSync('index.html','utf8');
const ui=html.slice(html.indexOf('function crmCanBatchFollowUp('),html.indexOf('function crmReservationStatusLabel('));
const hc={id:'hc',university_id:4,coach_role:'head_coach',coach_email:'SHARED@example.com',contact_status:'contacted',follow_up_count:1,gmail_thread_id:'hc-thread'};
const ac={...hc,id:'ac',coach_role:'assistant_coach',coach_email:' shared@example.com ',gmail_thread_id:'ac-thread'};
const c={Map,Set,console,crmContacts:new Map([['hc',hc],['ac',ac]]),crmBatchReservationReady:true,crmBatchPendingReservations:new Map(),isTestUniversityId:id=>Number(id)>=900};
vm.createContext(c);vm.runInContext(stripTypeScriptTypes(policy)+'\n'+ui,c);
assert.equal(c.distinctFollowUpRecipients([ac,hc],false).length,1);assert.equal(c.distinctFollowUpRecipients([ac,hc],false)[0].id,'hc');
assert.equal(c.distinctFollowUpRecipients([ac,hc],true).length,2);
assert.equal(c.distinctFollowUpRecipients([hc,{...ac,coach_email:'other@example.com'}],false).length,2);
assert.equal(c.distinctFollowUpRecipients([hc,{...ac,university_id:11}],false).length,2);
assert.equal(c.crmCanReserveFollowUp(hc),true);assert.equal(c.crmCanReserveFollowUp(ac),false);
c.crmBatchPendingReservations.set('ac',{contact_id:'ac',mode:'production',university_id:4,recipient_email:'shared@example.com',status:'scheduled'});
assert.equal(c.crmCanReserveFollowUp(hc),false);
c.crmBatchPendingReservations.clear();c.crmContacts.set('ac',{...ac,coach_email:'different@example.com'});assert.equal(c.crmCanReserveFollowUp(c.crmContacts.get('ac')),true);
c.crmContacts.set('ac',{...ac,contact_status:'responded'});assert.equal(c.crmCanReserveFollowUp(hc),false);

const endpoint=fs.readFileSync('supabase/functions/recruiting-gmail-followup-batch-prepare/index.ts','utf8').replace(/^import .*;\n/gm,'').replace('export default','globalThis.endpoint =');
async function prepare(options={}){
 const contacts=[hc,options.distinct?{...ac,coach_email:'different@example.com'}:ac];
 const db={from:table=>{const q={select:()=>q,eq:()=>q,in:()=>q,then:fn=>Promise.resolve({data:table==='recruiting_universities'?[{id:4,name:'Fixture',is_test:false}]:table==='recruiting_followup_batch_items'?(options.pending?[{contact_id:'ac',university_id:4,recipient_email:'shared@example.com',status:'scheduled'}]:[]):contacts,error:null}).then(fn)};return q;}};
 const ctx={...c,Response,Request,withSupabase:(setting,h)=>h,timezoneForCoordinates:()=> 'UTC',localScheduleToUtc:()=> '2030-01-01T10:00:00Z',googleAccessToken:async()=> 'fixture',gmailGetThread:async()=>({}),latestOutbound:t=>t,getHeader:()=> 'Original',anyThreadReply:()=>null,outboundIncludesRecipient:()=>true};
 vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(policy+'\n'+endpoint),ctx);
 const response=await ctx.endpoint.fetch(new Request('https://fixture',{method:'POST',body:JSON.stringify({test_mode:false,contact_ids:['hc','ac'],local_date:'2030-01-01',local_time:'10:00'})}),{supabase:db,jwtClaims:{sub:'owner'}});
 return response.json();
}
(async()=>{
 assert.equal((await prepare()).items.length,1);assert.equal((await prepare({distinct:true})).items.length,2);assert.equal((await prepare({pending:true})).items.length,0);
 console.log('PASS: actual recipient policy, reservation UI and preparation endpoint deduplicate shared school addresses, preserve distinct addresses/Test Mode, suppress shared pending reservations and replied schools. Gmail/auth/DB mocked.');
})().catch(error=>{console.error(error);process.exitCode=1});
