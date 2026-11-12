const fs=require('fs'),vm=require('vm'),assert=require('assert');
const root=fs.existsSync('index.html')?'.':'menu-check';
const html=fs.readFileSync(root+'/index.html','utf8'),activity=fs.readFileSync(root+'/activity.js','utf8');
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1]);
class Element{constructor(dataset={},id=''){this.dataset=dataset;this.id=id;this.hidden=true;this.attrs={};this.active=false;this.classList={toggle:(_,v)=>this.active=v};}setAttribute(k,v){this.attrs[k]=v}getAttribute(k){return this.attrs[k]||null}}
const primary=['schools','activity','correspondence'].map(area=>new Element({area}));
const secondary=['active','outreach','crm'].map(correspondenceArea=>new Element({correspondenceArea}));
const sections=['schools','activity','active','outreach','crm'].map(area=>{const e=new Element();e.getAttribute=()=>area;return e;});
const panels=['overview','reservations','interest'].map(crmPanel=>new Element({crmPanel},crmPanel==='reservations'?'crm-batch-followup':''));
const tabs=panels.map(p=>new Element({crmTab:p.dataset.crmPanel}));
const elements={'correspondence-nav':new Element(),'activity-frame':new Element(),'crm-batch-followup':panels[1]};
const context={document:{getElementById:id=>elements[id],querySelectorAll:s=>({'[data-recruiting-area]':sections,'[data-correspondence-area]':secondary,'.recruiting-nav-btn':primary,'[data-crm-panel]':panels,'[data-crm-tab]':tabs}[s]||[])},window:{scrollTo(){}},currentRecruitingArea:'schools',lastCorrespondenceArea:'active',crmWorkspaceTab:'overview',crmReservationsOpen:false,currentView:'list',map:null,setTimeout};
vm.createContext(context);
vm.runInContext(html.slice(html.indexOf('function applyCrmWorkspaceVisibility(){'),html.indexOf('function switchCrmWorkspaceTab(')),context);
vm.runInContext(html.slice(html.indexOf('function switchRecruitingArea(area){'),html.indexOf('function renderRecruitingNavCounts(){')),context);
const go=area=>vm.runInContext(`switchRecruitingArea('${area}')`,context);
go('correspondence');assert.equal(context.currentRecruitingArea,'active');assert.equal(elements['correspondence-nav'].hidden,false);assert.equal(primary[2].active,true);assert.equal(secondary[0].active,true);
go('outreach');assert.equal(context.currentRecruitingArea,'outreach');assert.equal(secondary[1].active,true);assert.equal(primary[2].active,true);
context.crmWorkspaceTab='reservations';context.crmReservationsOpen=true;go('crm');assert.equal(panels[1].hidden,false);assert.equal(panels[0].hidden,true);assert.equal(tabs[1].attrs['aria-selected'],'true');
go('activity');assert.equal(elements['correspondence-nav'].hidden,true);assert.equal(panels[1].hidden,true);assert.equal(elements['activity-frame'].src,'activity.html');
go('correspondence');assert.equal(context.currentRecruitingArea,'crm');assert.equal(panels[1].hidden,false);
go('invalid');assert.equal(context.currentRecruitingArea,'schools');assert.equal(elements['correspondence-nav'].hidden,true);
const nav=html.match(/<nav id="recruiting-nav"[\s\S]*?<\/nav>/)[0];assert.equal((nav.match(/class="recruiting-nav-btn/g)||[]).length,4);for(const id of ['nav-count-schools','nav-count-outreach','nav-count-active'])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
const ae={campaign:{value:'new'},stage:{value:'initial'},detail:{showModal(){}},'detail-title':{},'detail-body':{querySelectorAll:()=>[]},'save-draft':{}};
const ac={window:{supabase:{createClient:()=>({})}},document:{getElementById:id=>ae[id]||{}},Date};ac.window.parent=ac.window;vm.createContext(ac);vm.runInContext(fs.readFileSync(root+'/recruiting-status.js','utf8'),ac);vm.runInContext(activity.split("$('close').onclick=")[0],ac);
vm.runInContext("campaigns=[{id:'new'}];schools=[{id:1,name:'Example'}];contacts=[{id:'coach',university_id:1,coach_name:'Example Coach',coach_email:'coach@example.edu'}]",ac);
for(const [stage,heading] of [['initial','初回メールの準備'],['follow_up_1','Follow-up 1の準備'],['follow_up_2','Follow-up 2の準備']]){ae.stage.value=stage;vm.runInContext("openContact('coach')",ac);assert.ok(ae['detail-body'].innerHTML.includes('<h3>'+heading+'</h3>'));assert.ok(!ae['detail-body'].innerHTML.includes('今回の今回の'));}
console.log('PASS: four primary menus; reply/history/detail routing; existing reservation tabs; returning to last view; unique counts; all preparation headings; inline script syntax');

