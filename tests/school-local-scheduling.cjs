const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const time=require('../recruiting-schedule-time.js');
for(const [local,zone,expected] of [
 ['2026-11-19T10:00','America/New_York','2026-11-19T15:00:00.000Z'],
 ['2027-07-01T10:00','America/New_York','2027-07-01T14:00:00.000Z'],
 ['2026-11-19T10:00','America/Los_Angeles','2026-11-19T18:00:00.000Z'],
 ['2027-07-01T10:00','America/Phoenix','2027-07-01T17:00:00.000Z'],
 ['2027-07-01T10:00','Pacific/Honolulu','2027-07-01T20:00:00.000Z'],
 ['2026-11-19T10:00','America/Chicago','2026-11-19T16:00:00.000Z'],
 ['2026-11-19T10:00','America/Denver','2026-11-19T17:00:00.000Z'],
 ['2026-11-19T00:00','Asia/Tokyo','2026-11-18T15:00:00.000Z'],
 ['2026-11-19T10:00','Asia/Kolkata','2026-11-19T04:30:00.000Z']]){
 assert.equal(time.toUtc(local,zone),expected);assert.equal(time.localInput(expected,zone),local);
}
assert.throws(()=>time.toUtc('2027-03-14T02:30','America/New_York'),/存在しない/);
assert.throws(()=>time.toUtc('2027-11-07T01:30','America/New_York'),/2回現れる/);
assert.throws(()=>time.toUtc('2026-02-30T10:00','America/New_York'),/有効な/);
assert.throws(()=>time.toUtc('2026-11-19T10:00',''),/タイムゾーン/);
assert.equal(time.localInput('2026-11-19T15:00:00Z','Asia/Tokyo'),'2026-11-20T00:00');
assert.equal(time.offsetLabel('2027-07-01T14:00:00Z','America/New_York'),'GMT−04:00');
console.log('PASS: US time zones, summer time, non-DST states, half-hour offset, JST date rollover, invalid and ambiguous local times');

const nodes={},events=[],get=id=>nodes[id]??(nodes[id]={value:'',checked:false,disabled:false,hidden:false,innerHTML:'',textContent:'',listeners:{},addEventListener(n,fn){this.listeners[n]=fn;},querySelectorAll:()=>[],querySelector:()=>null,showModal(){this.open=true},close(){this.open=false}});
let snapshot={ok:true,campaign_id:'campaign',stage:'initial',content_confirmed:true,reservation_available:true,execution_enabled:false,groups:[{university_id:1,school_name:'Example Shared University',school_timezone:'America/Los_Angeles',recipient_email:'shared@example.edu',contact_ids:['hc','ac'],source_key:'current-key',ready:false,excluded:false,audience_reasons:[],send_reasons:['draft_incomplete'],drafts:['hc','ac'].map(contact_id=>({contact_id,subject:'Subject',body:'Confirmed body',planned_at:null}))}]};
let reserved=[],conflict=false;
const db={rpc:async(name,p)=>{events.push({name,p});if(conflict)return {error:{message:"Draft changed; reopen"}};const g=snapshot.groups[0];for(const d of g.drafts)if(p.p_apply_shared||d.contact_id===p.p_contact_id)Object.assign(d,{subject:p.p_subject,body:p.p_body,planned_at:p.p_planned_at});g.source_key='saved-key';g.ready=true;g.send_reasons=[];return {data:2};},functions:{invoke:async(name,{body})=>{events.push({action:body.action,body});if(body.action==='preview')return {data:structuredClone(snapshot)};if(body.action==='schedule')return {data:{ok:true,deliveries:[]}};throw Error('Unexpected action');}},from:()=>({select(){return this},order(){return this},async range(){return {data:reserved}}})};
const context={window:{supabase:{createClient:()=>db},RecruitingScheduleTime:time,CampaignDraftReview:{html:()=>'',bind(){},payload:()=>({p_review:{reviewed:true},p_review_revisions:{hc:1,ac:1}})},location:{search:''}},document:{getElementById:get},console,Date,Intl,URLSearchParams,alert:message=>events.push({alert:message}),structuredClone};context.window.parent=context.window;
vm.createContext(context);vm.runInContext(fs.readFileSync('recruiting-status.js','utf8'),context);vm.runInContext(fs.readFileSync('activity.js','utf8').split("$('close').onclick=")[0],context);
get('campaign').value='campaign';get('stage').value='initial';context.fixture=snapshot;
vm.runInContext("user={id:'owner'};campaigns=[{id:'campaign'}];schools=[{id:1,name:'Example Shared University'}];contacts=['hc','ac'].map(id=>({id,university_id:1,coach_name:id,coach_email:'shared@example.edu'}));preflightSnapshot=fixture;messages=['hc','ac'].map(contact_id=>({id:contact_id,campaign_id:'campaign',contact_id,stage:'initial',subject:'Subject',body:'Confirmed body'}));load=async()=>{};",context);
function edit(local){get('draft-subject').value='Subject';get('draft-body').value='Confirmed body';get('draft-date').value=local;get('draft-date').listeners.input();}
(async()=>{
 context.openContact('hc');assert.match(get('detail-body').innerHTML,/送信日時（学校現地時間）/);assert.match(get('detail-body').innerHTML,/共有宛先へ1通を予約/);
 edit('2026-12-01T10:00');await get('save-shared-draft').onclick();let save=events.find(x=>x.p);assert.equal(save.p.p_planned_at,'2026-12-01T18:00:00.000Z');assert.equal(save.p.p_source_key,'current-key');assert.equal(save.p.p_apply_shared,true);assert.equal(events.filter(x=>x.action==='schedule').length,0,'Draft save must never reserve');
 context.openContact('hc');edit('2026-12-01T10:00');assert.equal(get('reserve-draft').disabled,false);await get('reserve-draft').onclick();const schedule=events.find(x=>x.action==='schedule');assert.equal(schedule.body.confirm_schedule,true);assert.equal(schedule.body.groups.length,1,'Shared contacts must use one physical reservation');assert.equal(schedule.body.groups[0].source_key,'saved-key');assert.equal(events.filter(x=>x.action==='schedule').length,1);
 snapshot.reservation_available=false;snapshot.reservation_not_before='2099-11-17T03:00:00+09:00';context.openContact('hc');edit('2026-12-01T10:00');assert.equal(get('reserve-draft').disabled,true);const before=events.length;await get('reserve-draft').onclick();assert.equal(events.slice(before).filter(x=>x.action==='schedule'||x.p).length,0,'Blocked window must not save or reserve through reserve action');
 snapshot.reservation_available=true;snapshot.reservation_not_before=null;snapshot.groups[0].audience_reasons=['school_reply'];context.openContact('hc');edit('2026-12-01T10:00');assert.equal(get('reserve-draft').disabled,true,'School reply must stop reservation');snapshot.groups[0].audience_reasons=[];
 const count=events.filter(x=>x.action==='schedule').length;await context.openSendReview();assert.match(get('detail-body').innerHTML,/予約済みメールはまだありません/);assert.equal(events.filter(x=>x.action==='schedule').length,count);
 reserved=[{id:'reserved',campaign_id:'campaign',stage:'initial',university_id:1,contact_ids:['hc','ac'],recipient_email:'shared@example.edu',subject:'Reserved subject',body:'Reserved body',scheduled_at:'2026-12-01T18:00:00Z',school_timezone:'America/Los_Angeles',status:'scheduled'}];await context.openSendReview();const html=get('detail-body').innerHTML;assert.match(html,/2026-12-01 10:00/);assert.match(html,/2026-12-02 03:00/);assert.match(html,/この予約を停止/);assert.match(html,/Reserved body/);assert.equal(events.filter(x=>x.action==='schedule').length,count,'Send review must be read-only');
 conflict=true;context.openContact('hc');edit('2026-12-01T10:00');get('draft-body').value='Keep unsaved edit';await get('save-draft').onclick();assert.equal(get('draft-body').value,'Keep unsaved edit');assert.ok(events.some(e=>e.alert?.includes('Draft changed')));conflict=false;
 const waiting={};db.functions.invoke=async(name,{body})=>new Promise(resolve=>waiting[body.stage]=resolve);get('stage').value='initial';const first=context.refreshPreflight();get('stage').value='follow_up_1';const second=context.refreshPreflight();waiting.initial({data:structuredClone(snapshot)});await first;assert.equal(get('list').inert,true);waiting.follow_up_1({data:{...structuredClone(snapshot),stage:'follow_up_1'}});await second;assert.equal(get('list').inert,false);assert.equal(vm.runInContext('preflightSnapshot.stage',context),'follow_up_1');
 console.log('PASS: local save, JST summary, one shared reservation, start-time gate, reply exclusion, and read-only reserved-mail inspection');
})().catch(error=>{console.error(error);process.exitCode=1});
