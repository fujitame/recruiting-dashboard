const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync('supabase/functions/_shared/email-interest-model.js','utf8').replace(/^export /gm,'');
const c={Date,Set};vm.createContext(c);vm.runInContext(source,c);
const now=Date.parse('2026-10-26T10:00Z'),recent=new Date(now-1000).toISOString(),old=new Date(now-31*86400000).toISOString(),rows=[{id:'a',status:'sent'}];
const score=(r=rows,s=[])=>c.emailInterest(r,s,now);
assert.equal(score([]).rank,-1);assert.equal(score().rank,0);
assert.equal(score([{...rows[0],first_open_at:recent}]).rank,1);
assert.equal(score([{...rows[0],first_profile_at:recent}]).rank,2);
assert.equal(score([{...rows[0],last_profile_at:old,first_automated_youtube_at:recent}]).rank,0);
for(const [event,rank,slot] of [['profile_interaction',3,''],['profile_active_15s',3,''],['resume_click',4,''],['profile_youtube_click',3,'primary'],['video_start',3,'primary'],['video_30s',4,'secondary']]){
 const signal={tracking_id:'a',event,video_slot:slot,last_at:recent};assert.equal(score(rows,[signal]).rank,rank);
 assert.equal(score(rows,[{...signal,last_at:old}]).rank,0);assert.equal(score([{id:'a',status:'send_unknown'}],[signal]).rank,-1);
 assert.equal(score(rows,[signal,signal]).rank,rank);assert.equal(score(rows,[{...signal,tracking_id:'other'}]).rank,0);
}
const dashboard=fs.readFileSync('index.html','utf8');
assert(dashboard.includes(source.trim())); // UI must use the exact tested classifier.
new vm.Script(dashboard.match(/<script>([\s\S]*?)<\/script>/)[1]);
// Exercise actual school/role renderer with test mode, multiple emails and a shared HC/AC address.
const els={'crm-email-engagement-list':{innerHTML:'',querySelectorAll:()=>[]},'crm-email-engagement-counts':{textContent:''}};
const ui={Date,Set,Map,document:{getElementById:id=>els[id],querySelectorAll:()=>[]},visibleUniversities:()=>[{id:1,name:'School A'},{id:900,name:'Test School'}],crmEsc:s=>String(s),crmEngagementRows:rs=>'Rows:'+rs.length};
vm.createContext(ui);
const uiCode=dashboard.slice(dashboard.indexOf('let crmEngagementSignals='),dashboard.indexOf('let crmEmailTracking=[],'));
vm.runInContext(source+'\nlet testMode=false,crmEmailTrackingError=false;const crmContacts=new Map([["hc",{id:"hc",university_id:1,coach_email:"shared@example.com",coach_role:"head_coach",coach_name:"Head"}],["ac",{id:"ac",university_id:1,coach_email:"shared@example.com",coach_role:"assistant_coach",coach_name:"Assistant"}]]);let crmEmailTracking=[{id:"a",contact_id:"hc",university_id:1,recipient_email:"shared@example.com",status:"sent",is_test:false},{id:"t",contact_id:"test",university_id:900,status:"sent",is_test:true}];'+uiCode+'\ncrmTrackingLoaded=true;renderSchoolMailInterest();',ui);
assert(els['crm-email-engagement-list'].innerHTML.includes('HC／AC 共通アドレス'));assert(!els['crm-email-engagement-list'].innerHTML.includes('Test School'));
vm.runInContext('testMode=true;renderSchoolMailInterest();',ui);
assert(els['crm-email-engagement-list'].innerHTML.includes('Test School'));assert(!els['crm-email-engagement-list'].innerHTML.includes('School A'));
console.log('PASS: five interest levels, 30-day window, uncertainty/automated exclusions, same classifier in UI, school grouping, HC/AC shared inbox and test-mode isolation.');
