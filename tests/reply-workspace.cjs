const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('index.html','utf8'),policy=fs.readFileSync('supabase/functions/_shared/recruiting-reply-policy.js','utf8').replace(/^export /gm,'');
const workspace=html.slice(html.indexOf('const crmReplyWorkspaceStates='),html.indexOf('const crmAiReplyGeneratedFor='));
const open=html.slice(html.indexOf('async function openAiReplyInGmailComposer('),html.indexOf('function closeGmailComposer('));
const gate=html.slice(html.indexOf('function updateAiGmailStageGate('),html.indexOf('function renderCrmAiStageSuggestion('));
function element(){return {value:'',textContent:'',hidden:false,disabled:false,checked:false,dataset:{},style:{display:'inline-block'},children:[],replaceChildren(){this.children=[];},append(...items){this.children.push(...items);},classList:{add(){},contains(){return true;}}};}
const els={};const get=id=>els[id]??(els[id]={...element(),type:/reviewed|agency/.test(id)?'checkbox':'text'});
let calls=[],pending=null;const alerts=[];
const a={id:'a',university_id:1,coach_role:'head_coach',coach_name:'John Smith',coach_email:'coach@example.com',coach_response:'Please share your budget.',gmail_thread_id:'thread',contact_status:'responded'};
const b={...a,id:'b',university_id:2,coach_name:'Other Coach',coach_email:'other@example.com',coach_response:'Another reply'};
const c={console,Date,Map,Set,Array,String,Number,JSON,Error,CURRENT_PLAYER:{name:'Akihiro Fujikawa',school:'Harcum College',email:'fujiakihiro8@gmail.com'},universities:[{id:1,name:'School A'},{id:2,name:'School B'}],confirm:()=>true,alert:v=>alerts.push(v),document:{getElementById:get,createElement:()=>element()},getRecruitingSchoolStage:()=> 'none',recruitingStageLabel:s=>s,crmStatusLabel:s=>s==='responded'?'返信有・対応中':s,renderCrmAiStageSuggestion:()=>{},showGmailError:()=>{},supabaseClient:{functions:{invoke:async(name,args)=>{
 calls.push({name,body:args.body});if(pending){const p=pending;pending=null;return p;}
 if(name==='recruiting-gmail-reply-send'){assert.equal(args.body.action,'prepare');return {data:{ok:true,subject:'Re: Original subject',reply_message_id:'<source@example.com>'}};}
 return {data:{ok:true,model:'fixture',reply_message_id:'<source@example.com>',draft:{subject:'Re: AI subject',body:'Dear Coach Smith,\n\nMy budget is a target, not confirmed aid.\n\nBest,\nAkihiro',subject_ja:'Re: 日本語',body_ja:args.body.mode==='translate'?'編集した英文の訳':'日本語の返信案',rationale_ja:'質問への回答',requested_items:['Budget'],analysis_ja:{summary_ja:'予算の質問',confirmed_facts_ja:['予算を尋ねた'],interpretation_ja:'評価のための確認の可能性',uncertainties_ja:['奨学金は未確認'],recommended_actions_ja:['回答する']},stage_suggestion:{stage:'none'}}}};
}}}};
vm.createContext(c);
vm.runInContext('let crmCurrentContact=null,gmailCurrentContactId=null,gmailSendMode="initial",gmailTestMode=false,gmailInitialPersonalized=false,gmailInitialResearchIds=[],gmailFollowUpPersonalized=false,gmailFollowUpResearchIds=[],gmailConversationRequest=0;const crmAiReplyGeneratedFor=new Map(),crmAiStageSuggestionFor=new Map(),crmAiStageDecisionFor=new Map();'+policy+workspace+gate+open+'function resetConversationDraft(){resetReplyComposerOptions();gmailConversationRequest++;}',c);c.contactA=a;c.contactB=b;
(async()=>{
 vm.runInContext('crmCurrentContact=contactA;restoreReplyWorkspace(contactA);',c);
 get('crm-ai-reply-btn').style.display='none';c.updateCrmReplyActions(a);assert.equal(get('crm-ai-reply-btn').style.display,'inline-block');assert.equal(get('crm-manual-reply-btn').style.display,'inline-block');assert.equal(get('crm-ai-reply-btn').disabled,false);
 await c.createManualCrmReply();assert.equal(get('crm-ai-subject').value,'Re: Original subject');
 assert.equal(get('crm-ai-body').value,'Dear Coach Smith,\n\n\n\nBest regards,\nAkihiro Fujikawa\nHarcum College | Men\'s Soccer\nfujiakihiro8@gmail.com');
 assert.equal(calls.filter(r=>r.name==='recruiting-gmail-reply-send').length,1);
 get('crm-reply-direction').value='予算は希望額として伝えたい。';c.crmReplyDirectionChanged();
 await c.analyzeCrmCoachReply();assert.equal(get('crm-reply-analysis').children.length,5);assert.equal(get('crm-ai-body').value,c.manualRecruitingReply(a.coach_name,c.CURRENT_PLAYER));
 await c.generateAiReplyDraft();assert(get('crm-reply-translation').textContent.includes('日本語の返信案'));assert(calls.at(-1).body.user_direction.includes('希望額'));assert(calls.at(-1).body.analysis_ja.includes('予算の質問'));
 get('crm-ai-body').value+=' Updated.';c.crmReplyEnglishChanged();assert(get('crm-reply-translation-note').textContent.includes('編集前'));
 await c.translateCrmReplyDraft();assert(get('crm-reply-translation').textContent.includes('編集した英文の訳'));assert(!get('crm-reply-translation-note').textContent.includes('編集前'));
 const aiBody=get('crm-ai-body').value;
 vm.runInContext('crmCurrentContact=contactB;restoreReplyWorkspace(contactB);',c);assert.equal(get('crm-reply-direction').value,'');assert.equal(get('crm-ai-body').value,'');
 vm.runInContext('crmCurrentContact=contactA;restoreReplyWorkspace(contactA);',c);assert.equal(get('crm-ai-body').value,aiBody);
 assert.equal(get('crm-reply-contact-status').textContent,'返信有・対応中');
 const before=calls.length;await c.openAiReplyInGmailComposer();assert.equal(calls.length,before);assert(alerts.at(-1).includes('連絡状況'));
 get('crm-reply-stage-reviewed').checked=true;await c.openAiReplyInGmailComposer();assert.equal(get('gmail-reply-contact-status').textContent,'返信有・対応中');assert.equal(get('gmail-subject').value,'Re: Original subject');assert.equal(get('gmail-body').value,aiBody);assert.equal(get('gmail-send-btn').disabled,true);
 get('gmail-cc').value='Other@example.com, recruit@withtyou-usa.com';get('gmail-cc-agency').checked=true;c.gmailReplyOptionsChanged();assert.equal(c.gmailReplyCc().length,2);get('gmail-reply-reviewed').checked=true;c.updateGmailReplyReview();assert.equal(get('gmail-send-btn').disabled,false);
 get('gmail-cc').value='bad';c.gmailReplyOptionsChanged();assert.equal(get('gmail-send-btn').disabled,true);assert.equal(get('gmail-reply-reviewed').checked,false);
 c.resetReplyComposerOptions();assert.equal(get('gmail-cc').value,'');assert.equal(get('gmail-cc-agency').checked,false);assert.equal(get('gmail-reply-options').hidden,true);
 let resolve;pending=new Promise(r=>resolve=r);const generating=c.generateAiReplyDraft();
 vm.runInContext('crmCurrentContact=contactB;restoreReplyWorkspace(contactB);',c);resolve({data:{ok:true,draft:{body:'WRONG SCHOOL',body_ja:'誤'}}});await generating;
 assert.equal(get('crm-ai-body').value,'');
 assert.deepEqual(Array.from(c.normalizeReplyCc(' A@example.com; a@example.com; coach@example.com ',a.coach_email)),['a@example.com']);
 assert.throws(()=>c.normalizeReplyCc('a@example.com\r\nBcc: bad@example.com'));
 console.log('PASS: manual skeleton and original subject; analysis plus direction; Japanese translation and stale marker; per-contact state; Stage gate; CC checkbox/validation/review; CC reset across composers; stale async result isolation. Prepare requests only, no mail sent.');
})().catch(e=>{console.error(e);process.exitCode=1;});

