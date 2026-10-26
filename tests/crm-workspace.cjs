const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
const model=html.slice(html.indexOf('const ENGAGEMENT_LABELS='),html.indexOf('let crmEngagementSignals='));
const workspace=html.slice(html.indexOf("let crmWorkspaceTab='overview';"),html.indexOf("let currentRecruitingArea='schools';"));
const interest=html.slice(html.indexOf('let crmEngagementSignals='),html.indexOf('let crmEmailTracking=[],'));
const elements={};for(const id of ['crm-email-engagement-list','crm-interest-summary','crm-interest-chart','crm-interest-chart-note','crm-email-engagement-counts','crm-interest-results','crm-interest-page','crm-interest-prev','crm-interest-next','crm-interest-scope','crm-interest-level','crm-interest-search','crm-interest-sort'])elements[id]={innerHTML:'',textContent:'',value:'',scrollIntoView:()=>{}};
elements['crm-interest-scope'].value='tracked';elements['crm-interest-level'].value='all';elements['crm-interest-sort'].value='interest';
const panels=['overview','reservations','interest'].map(name=>({id:name==='overview'?'crm-panel-overview':name==='interest'?'crm-panel-interest':'crm-batch-followup',dataset:{crmPanel:name},hidden:true,classList:{toggle:()=>{}}}));
panels.forEach(p=>elements[p.id]=p);
const tabs=['overview','reservations','interest'].map(name=>({dataset:{crmTab:name},attrs:{},setAttribute(k,v){this.attrs[k]=v;},focus(){this.focused=true;}}));
let reservationLoads=0,mailLoads=0;
const c={now:new Date().toISOString(),Date,Set,Map,Math,Number,Array,String,Infinity,document:{getElementById:id=>elements[id],querySelectorAll:s=>s==='[data-crm-panel]'?panels:s==='[data-crm-tab]'?tabs:[]},crmEsc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),crmEngagementRows:rows=>rows.length+' emails',loadCrmEmailTracking:()=>mailLoads++,loadCrmFollowUpBatchReservations:()=>reservationLoads++,renderCrmFollowUpBatch:()=>{}};
vm.createContext(c);
vm.runInContext('let currentRecruitingArea="crm",testMode=false,crmReservationsOpen=false,crmEmailTrackingError=false,crmBatchReservationReady=true,crmBatchPreparing=false;const crmContacts=new Map();let crmEmailTracking=[];const schools=[];function visibleUniversities(){return schools.filter(s=>Boolean(s.is_test)===testMode)};function switchRecruitingArea(area){currentRecruitingArea=area;applyCrmWorkspaceVisibility();}'+model+workspace+interest,c);
vm.runInContext([
 'for(let i=1;i<=22;i++){schools.push({id:i,name:"School "+String(i).padStart(2,"0"),div:"NCAA D1",conf:"Conference",fav:i===1});crmEmailTracking.push({id:"m"+i,university_id:i,contact_id:"h"+i,recipient_email:"coach"+i+"@example.com",status:"sent",is_test:false,first_profile_at:i===3?now:null,first_open_at:i===4?now:null});}',
 'schools.push({id:900,name:"Test School",is_test:true});crmEmailTracking.push({id:"test",university_id:900,status:"sent",is_test:true});',
 'crmEmailTracking.push({id:"unsent",university_id:1,status:"prepared",is_test:false});',
 'crmContacts.set("hc",{id:"h1",university_id:1,coach_role:"head_coach",coach_email:"coach1@example.com",coach_name:"Head"});',
 'crmContacts.set("ac",{id:"a1",university_id:1,coach_role:"assistant_coach",coach_email:"coach1@example.com",coach_name:"Assistant"});',
 'crmEngagementSignals=[{tracking_id:"m1",event:"video_30s",video_slot:"primary",last_at:now},{tracking_id:"m2",event:"video_start",video_slot:"primary",last_at:now}];crmTrackingLoaded=true;renderSchoolMailInterest();'
].join('\n'),c);
const list=()=>elements['crm-email-engagement-list'].innerHTML;
assert(!list().includes('Test School'));assert(list().includes('HC／AC 共通アドレス'));assert(list().includes('School 01'));assert(!list().includes('School 22'));
assert(elements['crm-interest-summary'].innerHTML.includes('22<small>校'));assert(elements['crm-interest-summary'].innerHTML.includes('2<small>校'));
assert.equal((elements['crm-interest-chart'].innerHTML.match(/class="interest-bar-row"/g)||[]).length,5);
vm.runInContext('changeCrmInterestPage(1);',c);assert(list().includes('School 22'));assert.equal(elements['crm-interest-page'].textContent,'2 / 2');
elements['crm-interest-sort'].value='name';vm.runInContext('changeCrmInterestFilters();',c);assert(list().indexOf('School 01')<list().indexOf('School 02'));
elements['crm-interest-sort'].value='interest-low';vm.runInContext('changeCrmInterestFilters();',c);assert(!list().includes('School 01'));
vm.runInContext('filterCrmInterestLevel("active");',c);assert(list().includes('School 01')&&list().includes('School 02'));assert(!list().includes('School 03'));
elements['crm-interest-level'].value='all';elements['crm-interest-search'].value='Assistant';vm.runInContext('changeCrmInterestFilters();',c);assert(list().includes('School 01'));assert(!list().includes('School 02'));
vm.runInContext('toggleSchoolInterestDetail(1);',c);assert(list().includes('aria-expanded="true"'));assert(!list().includes('id="school-interest-detail-1" class="interest-detail-row" hidden'));
const drafts=new Map([['approved','unchanged']]);c.drafts=drafts;
vm.runInContext('switchCrmWorkspaceTab("interest");',c);assert.deepEqual(panels.map(p=>p.hidden),[true,true,false]);assert.equal(tabs[2].attrs['aria-selected'],'true');assert.equal(tabs[2].tabIndex,0);
vm.runInContext('switchCrmWorkspaceTab("reservations");switchCrmWorkspaceTab("overview");',c);assert.deepEqual(panels.map(p=>p.hidden),[false,true,true]);assert.equal(drafts.get('approved'),'unchanged');assert.equal(reservationLoads,0);assert.equal(mailLoads,0);
vm.runInContext('currentRecruitingArea="schools";applyCrmWorkspaceVisibility();',c);assert(panels.every(p=>p.hidden));
vm.runInContext('testMode=true;crmInterestPage=1;',c);elements['crm-interest-search'].value='';vm.runInContext('switchCrmWorkspaceTab("interest");',c);assert(list().includes('Test School'));assert(!list().includes('School 01'));
let prevented=false;c.event={target:tabs[2],key:'ArrowLeft',preventDefault:()=>prevented=true};vm.runInContext('crmWorkspaceTabKey(event);',c);assert(prevented);assert(tabs[1].focused);assert.deepEqual(panels.map(p=>p.hidden),[true,false,true]);
assert.equal((html.match(/role="tabpanel"/g)||[]).length,3);assert.equal((html.match(/data-crm-tab=/g)||[]).length,3);
console.log('PASS: isolated CRM tabs, keyboard navigation, 5-category school chart, sent-only summary, sorting/search/filter/pagination, expandable shared HC/AC, and Test Mode separation. No network writes.');
