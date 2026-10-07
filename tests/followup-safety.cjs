const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/followup-batch-policy.ts','utf8').replace(/^export /gm,'')+'\n'+fs.readFileSync('supabase/functions/recruiting-gmail-followup-batch-worker/index.ts','utf8').replace(/^import .*;\n/gm,''));
async function run(mode,count,options={}){
 let handler;const writes=[],sends=[],labels=[];const prod=mode==='production',id=prod?1:900;
 const item={id:'item',batch_id:'batch',contact_id:'contact',owner_user_id:'owner',university_id:id,mode,recipient_email:prod?'coach@example.com':'fujitame@gmail.com',expected_follow_up_count:count,gmail_thread_id:prod?'thread':null,subject:prod?'Original subject':`[TEST] Follow-up #${count+1} — TEST Alpha`,body:prod?'Dear Coach, fixture only.':'TEST MODE — This message is sent only to fujitame@gmail.com.',personalization_sentence:'',research_ids:[],school_timezone:'America/New_York'};
 const contact={id:'contact',owner_user_id:'owner',university_id:id,coach_role:'head_coach',coach_email:'coach@example.com',gmail_thread_id:'thread',contact_status:options.status||'contacted',coach_response:null,follow_up_count:count,contact_count:2};
 const sibling={id:'sibling',coach_email:'assistant@example.com',gmail_thread_id:'sibling-thread',coach_role:'assistant_coach',contact_status:options.dbReply?'responded':'contacted',coach_response:null,follow_up_count:0};
 if(options.emailChanged)contact.coach_email='changed@example.com';
 const db={rpc:async()=>({data:options.retryOnly?[]:[item],error:null}),from(table){let op='select',payload,columns;const eqs={};let chain={select(c){columns=c;return chain},eq(k,v){eqs[k]=v;return chain},in(){return chain},like(){return chain},limit(){return chain},update(p){op='update';payload=p;return chain},insert(p){op='insert';payload=p;return chain},maybeSingle:async()=>({data:table==='recruiting_universities'?{id,is_test:options.wrongSchoolMode?prod:!prod}:contact,error:null}),then(resolve){if(op!=='select')writes.push({table,op,payload});if(op==='update'&&table==='recruiting_contacts'&&eqs.id===contact.id)Object.assign(contact,payload);const data=op==='update'?[{id:eqs.id}]:op==='insert'?null:table==='recruiting_contacts'?[contact,sibling]:table==='recruiting_contact_history'?[]:eqs.mode==='production'?(options.retryOnly?[item]:[]):[{status:'sent'}];return Promise.resolve({data,error:null}).then(resolve)}};return chain}};
 const context={createClient:()=>db,Deno:{env:{get:k=>k==='FOLLOWUP_BATCH_WORKER_SECRET'?'test':'stub'},serve:h=>handler=h},Response,Date,Set,Map,console:{...console,warn:()=>{}},
 googleAccessToken:async()=>'stub',gmailGetThread:async thread=>({subject:'Original subject',to:thread==='thread'?'coach@example.com':'assistant@example.com',reply:options.gmailReply&&thread==='sibling-thread'}),
 anyThreadReply:t=>t.reply?{id:'inbound',internalDate:String(Date.now())}:null,latestOutbound:t=>t,outboundIncludesRecipient:(t,email)=>!options.wrongThread&&t.to===email,
 getHeader:(h,key)=>key==='Subject'?'Original subject':key==='Message-ID'?'original-message-id':'',plainTextMessage:()=> 'Fixture reply',
 buildReplyRaw:obj=>obj,gmailSend:async(raw,thread)=>{sends.push({raw,thread});return{id:'fake-message',threadId:thread}},localDateAfterSend:()=> '2026-10-14',syncRecruitingThreadLabels:async(...args)=>labels.push(args),syncContactThreadLabels:async(db,c)=>{if(options.labelFailure)throw new Error('fixture label failure');labels.push([c.gmail_thread_id,c.contact_status==='responded'?'Recruiting/Needs Reply':Number(c.follow_up_count)>=2?'Recruiting/No Response':'Recruiting/Waiting Coach'])}};
 vm.runInNewContext(source,context);
 const response=await handler({method:'POST',headers:{get:k=>k==='x-recruiting-batch-worker-secret'?'test':null}});return {result:await response.json(),writes,sends,labels};
}
(async()=>{
 for(const mode of ['test','production'])for(const count of [0,1]){const r=await run(mode,count);assert.equal(r.result.sent,1);assert.equal(r.sends.length,1);assert.equal(r.sends[0].raw.to,mode==='test'?'fujitame@gmail.com':'coach@example.com');assert.equal(r.sends[0].thread,mode==='test'?null:'thread');const update=r.writes.find(w=>w.table==='recruiting_contacts').payload;assert.equal(update.follow_up_count,count+1);assert.equal(update.contact_status,count===0?'contacted':'no_response');assert.equal(update.follow_up_date,count===0?'2026-10-14':null);assert.equal(r.writes.filter(w=>w.table==='recruiting_contact_history').length,1);assert.equal(r.labels.length,mode==='test'?0:1);}
 for(const options of [{status:'not_contacted'},{dbReply:true},{gmailReply:true},{emailChanged:true},{wrongThread:true},{wrongSchoolMode:true}]){const r=await run('production',1,options);assert.equal(r.sends.length,0);assert.equal(r.result.skipped,1);if(options.gmailReply){assert(r.writes.some(w=>w.payload?.event_type==='reply_received'));assert(r.writes.some(w=>w.payload?.coach_response==='Fixture reply'));}}
 const failedLabel=await run('production',1,{labelFailure:true});assert.equal(failedLabel.sends.length,1);assert.equal(failedLabel.result.sent,1);assert.equal(failedLabel.result.label_pending,1);assert(failedLabel.writes.some(w=>String(w.payload?.error_message||'').startsWith('LABEL_SYNC_PENDING:')));
 const retried=await run('production',1,{retryOnly:true});assert.equal(retried.sends.length,0);assert.equal(retried.result.sent,0);assert(retried.writes.some(w=>w.table==='recruiting_followup_batch_items'&&w.payload.error_message===null));
 console.log('PASS: Test fixed routing; production coach recipient/original thread; #1/#2 CRM/history/labels; DB/Gmail sibling reply, changed email/thread, unsent/mode mismatch suppressed. All Gmail calls mocked.');
})().catch(e=>{console.error(e);process.exitCode=1});
// Exercise the actual label chooser and the resolver for shared HC/AC threads.
(async()=>{
 const text=fs.readFileSync('supabase/functions/_shared/recruiting-gmail-labels.ts','utf8');
 const choose=text.slice(text.indexOf('export function recruitingEventTime'),text.indexOf('export async function syncRecruitingThreadLabels'));
 const resolve=text.slice(text.indexOf('export async function syncContactThreadLabels'));
 const labels=[];const c={console,batchAccessToken:async()=>'fixture',gmailGetThread:async()=>({}),threadReplyFrom:()=>null,syncRecruitingThreadLabels:async(thread,label)=>labels.push({thread,label})};
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes((choose+resolve).replace(/^export /gm,'')),c);
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'contacted',follow_up_count:0},[]),'Recruiting/Waiting Coach');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'contacted',follow_up_count:1},[]),'Recruiting/Waiting Coach');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'contacted',follow_up_count:2},[]),'Recruiting/No Response');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'follow_up_due',follow_up_count:2},[]),'Recruiting/No Response');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'follow_up_due'},[]),'Recruiting/Follow-up Due');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'no_response',follow_up_count:2},[]),'Recruiting/No Response');
 assert.equal(c.chooseRecruitingStateLabel({contact_status:'contacted',coach_response:'Coach replied'},[]),'Recruiting/Needs Reply');
 async function shared(contacts,history=[]){const db={from:table=>{const q={select:()=>q,eq:()=>q,in:()=>q,then:fn=>Promise.resolve({data:table==='recruiting_contacts'?contacts:history,error:null}).then(fn)};return q}};await c.syncContactThreadLabels(db,{owner_user_id:'fixture',gmail_thread_id:'shared-thread'});return labels.at(-1).label;}
 assert.equal(await shared([{contact_status:'no_response',follow_up_count:2},{contact_status:'contacted',follow_up_count:0}]),'Recruiting/Waiting Coach');
 assert.equal(await shared([{contact_status:'no_response',follow_up_count:2},{contact_status:'no_response',follow_up_count:2}]),'Recruiting/No Response');
 assert.equal(await shared([{contact_status:'responded',coach_response:'Reply'},{contact_status:'contacted'}],[{event_type:'reply_received',event_at:'2026-10-07T00:00:00Z'}]),'Recruiting/Needs Reply');
 assert.equal(await shared([{contact_status:'responded',coach_response:'Reply'},{contact_status:'contacted'}],[{event_type:'reply_received',event_at:'2026-10-07T00:00:00Z'},{event_type:'reply_sent',event_at:'2026-10-07T01:00:00Z'}]),'Recruiting/Waiting Coach');
 c.threadReplyFrom=()=>({id:'new-inbound'});assert.equal(await shared([{contact_status:'contacted'}]),'Recruiting/Needs Reply');
 console.log('PASS: actual stage label chooser; shared HC/AC thread aggregation; received reply → Needs Reply; individual reply sent → Waiting Coach.');
})().catch(e=>{console.error(e);process.exitCode=1});
// The manual and old automated endpoints share this exact school reply gate.
(async()=>{
 const policy=fs.readFileSync('supabase/functions/_shared/followup-batch-policy.ts','utf8');
 const guard=fs.readFileSync('supabase/functions/_shared/followup-school-guard.ts','utf8').replace(/^import .*;\n/gm,'');
 async function check(options={}){
  const contact={id:'HC',owner_user_id:'owner',university_id:1,coach_role:'head_coach',coach_email:'hc@example.com',gmail_thread_id:'hc-thread',contact_status:'contacted',follow_up_count:options.completed?2:0};
  const sibling={...contact,id:'AC',coach_email:'ac@example.com',gmail_thread_id:'ac-thread',contact_status:options.dbReply?'responded':'contacted'};let gmailReads=0;
  const db={from:table=>{const q={select:()=>q,eq:()=>q,in:()=>q,update:()=>q,insert:()=>q,then:fn=>Promise.resolve({data:table==='recruiting_contacts'?[contact,sibling]:table==='recruiting_followup_batch_items'?(options.pending?[{id:'reservation'}]:[]):[],error:null}).then(fn)};return q}};
  const c={console,Map,Date,gmailGetThread:async id=>{gmailReads++;return{id}},anyThreadReply:t=>options.gmailReply&&t.id==='ac-thread'?{id:'reply'}:null,latestOutbound:t=>t,outboundIncludesRecipient:()=>true,plainTextMessage:()=> 'Reply',getHeader:()=> 'Reply subject'};
  vm.createContext(c);vm.runInContext(stripTypeScriptTypes((policy+'\n'+guard).replace(/^export /gm,'')),c);
  const result=await c.guardSchoolFollowUp(db,contact,'fake-token');return {result,gmailReads};
 }
 assert.equal((await check()).result.blocked,false);
 for(const options of [{dbReply:true},{gmailReply:true},{completed:true},{pending:true}])assert.equal((await check(options)).result.blocked,true);
 assert.equal((await check({dbReply:true})).gmailReads,0);
 console.log('PASS: actual school gate blocks sibling DB reply, unsynced Gmail reply, exhausted stage and existing reservation in manual/legacy paths.');
})().catch(e=>{console.error(e);process.exitCode=1});
