const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
const source=html.slice(html.indexOf('async function sendAiGmailReply('),html.indexOf('async function sendFollowUpGmailViaServer('));
async function run(kind,options={}){
 const btn={},errors=[],alerts=[],updates=[];let calls=0,open=true;
 const contact={id:'contact',coach_key:'hc',university_id:1,coach_email:'coach@example.com',contact_count:1};
 const data=kind==='initial'?{ok:false,sent:true,error:'Gmail accepted; fixture CRM failure',gmail_message_id:'sent'}:{ok:true,gmail_message_id:'sent',gmail_thread_id:'thread',body_verified:!options.unverified};
 const db={functions:{invoke:async()=>{calls++;return {data,error:null};}},from:()=>{const q={update:p=>{updates.push(p);return q;},insert:()=>q,eq:()=>q,select:()=>q,single:async()=>options.crmFailure?{error:{message:'fixture CRM failure'}}:{data:contact,error:null},then:fn=>Promise.resolve({error:null}).then(fn)};return q;}};
 const c={gmailReplyCc:()=>['cc@example.com'],gmailReplyContext:{contactId:'contact',stage:'none',origin:'ai',replyMessageId:'<coach@example.com>'},gmailConversationRequest:1,gmailSendMode:'reply',gmailReplyAccepted:false,crmReplyWorkspaceStates:new Map(),getRecruitingSchoolStage:()=> 'none',recruitingStageLabel:s=>s,crmStatusLabel:s=>s,crmCurrentContact:contact,Date,console:{...console,error:()=>{}},confirm:()=>true,alert:s=>alerts.push(s),showGmailError:s=>errors.push(s),gmailCurrentContactId:'contact',gmailInitialResearchIds:[],DASHBOARD_OWNER_ID:'owner',crmContacts:new Map([['1:hc',contact]]),supabaseClient:db,document:{getElementById:id=>id==='gmail-send-btn'?btn:id==='gmail-reply-reviewed'?{checked:true}:id==='gmail-subject'?{value:'Subject'}:id==='gmail-body'?{value:'Body'}:{classList:{contains:()=>open}}},renderCrmSummary:()=>{},renderCrmActionList:()=>{},loadCrmHistory:async()=>{},closeGmailComposer:()=>{open=false;}};
 vm.createContext(c);vm.runInContext(source,c);
 await c[kind==='initial'?'sendInitialGmailViaServer':'sendAiGmailReply']();
 return {btn,errors,alerts,updates,calls};
}
(async()=>{
 for(const kind of ['initial','reply']){
  const r=await run(kind,{crmFailure:true});assert.equal(r.calls,1);assert.equal(r.btn.disabled,true);assert.match(r.errors.at(-1),/再送せず/);assert.match(r.btn.textContent,/送信済み/);
 }
 const warning=await run('reply',{unverified:true});assert.match(warning.updates[0].next_action,/送信本文の確認/);assert.match(warning.alerts[0],/再送せず/);assert.equal(warning.updates[0].auto_follow_up_enabled,false);
 console.log('PASS: actual initial/reply UI keeps accepted-send buttons disabled after record failure and displays unverified-body warning. Backend/DOM mocked.');
})().catch(error=>{console.error(error);process.exitCode=1});

