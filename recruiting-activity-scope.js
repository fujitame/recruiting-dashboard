'use strict';
(function(root){
 const STAGES={initial:'初回',follow_up_1:'Follow-up 1',follow_up_2:'Follow-up 2'};
 const EVENTS={contact_logged:'連絡記録',follow_up_sent:'Follow-up送信',reply_received:'コーチからの返信',reply_sent:'こちらからの返信',conversation_follow_up_sent:'返信後のFollow-up',status_changed:'連絡状況の変更',follow_up_set:'予定の変更',note:'メモ',visit_camp_updated:'面談・訪問メモ'};
 const STATES={unsent:'未送信',prepared:'準備中・日時案（未予約）',scheduled:'予約済み・処理中',sent:'送信済み',reply:'学校に今回の返信あり',review:'要確認',excluded:'一括送信対象外',history:'過去の連絡記録あり'};
 const QUEUE={scheduled:'予約済み',processing:'送信処理中',sent:'送信済み',held:'保留',send_unknown:'送信結果不明',cancelled:'取消済み',skipped_changed:'状態変更で停止'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'記録なし';
 const email=c=>String(c.coach_email||'').trim().toLowerCase();
 const stage=f=>f.stage||(Number(f.expected_follow_up_count)===0?'follow_up_1':'follow_up_2');
 function model(data){
  const defs=new Map((data.campaigns||[]).map(p=>[p.id,p]));
  const records=new Map(),byMessage=new Map();
  for(const r of data.records||[]){if(r.history_id)records.set(r.history_id,r);if(r.gmail_message_id)byMessage.set(r.gmail_message_id,r);}
  function historyScope(h){
   const exact=records.get(h.id)||(h.gmail_message_id&&byMessage.get(h.gmail_message_id));if(exact&&exact.activity_scope!=='unassigned')return exact.activity_scope==='campaign'?exact.campaign_id:exact.activity_scope;
   const ids=new Set();
   for(const d of data.deliveries||[]){if(d.status!=='sent'||!d.contact_ids.includes(h.contact_id))continue;if((h.gmail_message_id&&h.gmail_message_id===d.gmail_message_id)||(String(h.note||'').startsWith('Campaign '+d.campaign_id+' / ')&&String(h.note).includes(' / delivery '+d.id+' / gmail ')))ids.add(d.campaign_id);}
   for(const m of data.messages||[]){const t=(data.tracking||[]).find(t=>t.id===m.tracking_id);if(m.contact_id===h.contact_id&&h.gmail_message_id&&t?.status==='sent'&&t.gmail_message_id===h.gmail_message_id)ids.add(m.campaign_id);}
   for(const s of data.schoolStates||[]){if(s.reply_status==='received'&&h.event_type==='reply_received'&&h.gmail_message_id&&String(s.reply_reference||'').split(' | ')[0]==='gmail:'+h.gmail_message_id){const c=(data.contacts||[]).find(c=>c.id===h.contact_id);if(c?.university_id===s.university_id)ids.add(s.campaign_id);}}
   return ids.size===1?[...ids][0]:'unassigned';
  }
  const histories=(data.histories||[]).map(h=>({...h,scope:historyScope(h)})).sort((a,b)=>Date.parse(b.event_at)-Date.parse(a.event_at));
  const historiesFor=(id,scope)=>histories.filter(h=>(!id||h.contact_id===id)&&(scope==='all'||h.scope===scope));
  function trackScope(t){
   const ids=new Set((data.messages||[]).filter(m=>m.tracking_id===t.id).map(m=>m.campaign_id));
   const d=(data.deliveries||[]).find(d=>d.id===t.campaign_delivery_id||d.tracking_id===t.id);if(d)ids.add(d.campaign_id);
   const r=t.gmail_message_id&&byMessage.get(t.gmail_message_id);if(r&&r.activity_scope!=='unassigned')return r.activity_scope==='campaign'?r.campaign_id:r.activity_scope;
   const h=histories.find(h=>t.gmail_message_id&&h.gmail_message_id===t.gmail_message_id);if(h&&h.scope!=='unassigned')return h.scope;
   return ids.size===1?[...ids][0]:'unassigned';
  }
  function queue(scope){
   const out=(data.deliveries||[]).map(d=>({...d,scope:d.campaign_id,kind:'campaign',stage:d.stage}));
   for(const j of data.initialJobs||[]){const p=(data.campaigns||[]).find(p=>p.campaign_key===j.campaign_key);out.push({...j,contact_ids:[...new Set([j.contact_id,...(j.contact_ids||[])].filter(Boolean))],scope:p?.id||'legacy',kind:'initial',stage:'initial'});}
   for(const f of data.followups||[]){if(f.mode==='test')continue;const ids=[...new Set((data.messages||[]).filter(m=>m.reservation_item_id===f.id).map(m=>m.campaign_id))];out.push({...f,contact_ids:[f.contact_id],scope:ids.length===1?ids[0]:ids.length?'unassigned':'legacy',kind:'followup',stage:stage(f)});}
   return out.filter(r=>(data.schools||[]).some(u=>u.id===Number(r.university_id))&&(scope==='all'||r.scope===scope)).sort((a,b)=>String(b.scheduled_at||b.created_at||'').localeCompare(String(a.scheduled_at||a.created_at||'')));
  }
  const scopedTracks=scope=>(data.tracking||[]).filter(t=>!t.is_test&&(scope==='all'||trackScope(t)===scope));
  function contactState(c,scope){
   const hs=historiesFor(c.id,scope),sent=(data.deliveries||[]).filter(d=>d.campaign_id===scope&&d.contact_ids.includes(c.id)&&d.status==='sent');
   const qs=queue(scope).filter(q=>q.contact_ids.includes(c.id));const ts=scopedTracks(scope).filter(t=>t.contact_id===c.id||((data.messages||[]).some(m=>m.contact_id===c.id&&m.tracking_id===t.id)));
   const ss=(data.schoolStates||[]).find(s=>s.campaign_id===scope&&s.university_id===c.university_id);
   const ms=(data.messages||[]).filter(m=>m.campaign_id===scope&&m.contact_id===c.id);
   const ownReply=hs.some(h=>h.event_type==='reply_received');
   const currentSchoolReply=(data.contacts||[]).some(p=>p.university_id===c.university_id&&historiesFor(p.id,scope).some(h=>h.event_type==='reply_received'));
   const inquiry=(data.leads||[]).some(l=>(data.contacts||[]).some(p=>p.university_id===c.university_id&&(l.linked_contact_id===p.id||(l.lead_status!=='dismissed'&&email(p)&&email(p)===String(l.coach_email||'').trim().toLowerCase()))));
   const staff=['学校接触済み・個人メール非公開','学校接触済み・別スタッフ経由','Staff要確認'].includes(String(c.next_action||'').trim())||!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email(c));
   const blocked=(data.issues||[]).some(i=>i.campaign_id===scope&&i.status==='open'&&i.blocking&&(i.university_id===c.university_id||(i.contact_ids||[]).includes(c.id)));
   const previousReply=(data.contacts||[]).some(p=>p.university_id===c.university_id&&(p.contact_status==='responded'||String(p.coach_response||'').trim()||historiesFor(p.id,'legacy').some(h=>h.event_type==='reply_received')));
   let key='unsent',label=STATES.unsent;
   if(scope==='all'){key=c.contact_status==='responded'?'reply':['closed','not_a_fit'].includes(c.contact_status)?'excluded':c.contact_count||c.gmail_thread_id?'history':'unsent';label=key==='reply'?'返信あり（全活動）':key==='history'?'連絡記録あり（累積）':STATES[key];}
   else if(scope==='legacy'){key=ownReply?'reply':hs.length||qs.some(q=>q.status==='sent')||ts.some(t=>t.status==='sent')?'history':'unsent';label=key==='reply'?'返信記録あり（過去）':key==='history'?STATES.history:'過去の記録なし';}
   else{
    if(qs.some(q=>['held','send_unknown'].includes(q.status))||ts.some(t=>t.status==='send_unknown')||ss?.reply_status==='review')key='review';
    else if(currentSchoolReply||ss?.reply_status==='received')key='reply';
    else if(previousReply||inquiry||['closed','not_a_fit'].includes(c.contact_status)||ss?.progress&&ss.progress!=='unknown')key='excluded';
    else if(staff||blocked)key='review';
    else if(qs.some(q=>['scheduled','processing'].includes(q.status)))key='scheduled';
    else if(sent.length||ts.some(t=>t.status==='sent')||hs.some(h=>['reply_sent','follow_up_sent','contact_logged','conversation_follow_up_sent'].includes(h.event_type)))key='sent';
    else if(ms.some(m=>String(m.subject||'').trim()||String(m.body||'').trim()||m.planned_at))key='prepared';
    label=STATES[key];
   }
   const times=[...hs.filter(h=>['contact_logged','follow_up_sent','reply_received','reply_sent','conversation_follow_up_sent'].includes(h.event_type)).map(h=>h.event_at),...qs.filter(q=>q.status==='sent').map(q=>q.sent_at),...ts.filter(t=>t.status==='sent').map(t=>t.sent_at)].filter(Boolean).sort((a,b)=>Date.parse(b)-Date.parse(a));
   const stages=Object.keys(STAGES).map(s=>{const ds=qs.filter(q=>q.stage===s),mts=ts.filter(t=>t.stage===s),draft=ms.find(m=>m.stage===s);return {stage:s,label:ds.some(d=>['held','send_unknown'].includes(d.status))||mts.some(t=>t.status==='send_unknown')?'要確認':ds.some(d=>d.status==='sent')||mts.some(t=>t.status==='sent')?'送信済み':ds.some(d=>['scheduled','processing'].includes(d.status))?'予約済み':draft&&(draft.subject?.trim()||draft.body?.trim()||draft.planned_at)?'準備中（未予約）':'未送信'};});
   return {key,label,reason:key==='review'?(staff?'担当コーチ・宛先情報を確認してください。':'送信・返信の記録を確認してください。'):'',last:times[0]||null,histories:hs,stages,schoolReply:!ownReply&&ss?.reply_status==='received'};
  }
  function contactsFor(scope){
   const all=(data.contacts||[]).filter(c=>(data.schools||[]).some(u=>u.id===Number(c.university_id)));
   if(scope==='all')return all;
   if(defs.has(scope)){const ids=new Set((data.members||[]).filter(m=>m.campaign_id===scope).map(m=>m.contact_id));return all.filter(c=>ids.has(c.id));}
   const ids=new Set(historiesFor(null,scope).map(h=>h.contact_id));for(const q of queue(scope))q.contact_ids.forEach(id=>ids.add(id));return all.filter(c=>ids.has(c.id));
  }
  return {historyScope,historiesFor,trackScope,queue,scopedTracks,contactState,contactsFor,defs};
 }
 root.RecruitingActivityScopeModel={model,STAGES,STATES,QUEUE,EVENTS};

 const state={a:null,data:null,m:null,key:'default',drawer:'all',loading:false,error:'',request:0,search:'',filter:'all',favorite:false,interestSchool:null,history:[],contact:null,booted:false};
 const $=id=>document.getElementById(id);
 const label=key=>key==='legacy'?'過去の活動':key==='all'?'全活動（累積・共通記録）':key==='unassigned'?'活動未分類・共通記録':state.m?.defs.get(key)?.name||'活動を確認中';
 const enabled=()=>{const yes=!!state.a&&!state.a.isTest();document.querySelectorAll('[data-scope-toolbar]').forEach(el=>el.hidden=!yes);if(!yes){for(const id of ['overview','reservations','interest']){const old=$(id==='overview'?'crm-legacy-overview':id==='reservations'?'crm-legacy-reservations':'crm-legacy-interest'),pane=$('crm-scoped-'+id);if(old)old.hidden=false;if(pane)pane.hidden=true;}if($('crm-activity-context'))$('crm-activity-context').hidden=true;const overview=$('crm-drawer')?.querySelector('.coach-overview-facts');if(overview)overview.hidden=false;}return yes;};
 function options(key){return (state.data?.campaigns||[]).map(p=>`<option value="${esc(p.id)}" ${key===p.id?'selected':''}>${esc(p.name)}</option>`).join('')+`<option value="legacy" ${key==='legacy'?'selected':''}>過去の活動</option><option value="all" ${key==='all'?'selected':''}>全活動（累積・共通記録）</option>`;}
 function selectors(){document.querySelectorAll('[data-correspondence-scope]').forEach(s=>{s.innerHTML=options(state.key);s.disabled=state.loading||!state.m;s.value=state.key;});document.querySelectorAll('[data-scope-note]').forEach(p=>p.textContent=state.error?'活動の記録を取得できません。更新してから確認してください。':state.loading?'活動別の履歴・予約を確認しています…':state.key==='all'?'全活動の累積表示です。活動未分類の共通メモも含みます。':state.key==='legacy'?'再アプローチとは分けて、過去の連絡・返信・予約を表示しています。':'この活動に紐付く連絡・返信・予約だけを表示します。過去の連絡回数・最終日を今回の実績へ加算しません。');}
 async function rows(table,fields='*'){let out=[];for(let offset=0;;offset+=500){const result=await state.a.client().from(table).select(fields).eq('owner_user_id',state.a.owner()).order(table==='recruiting_campaign_contacts'?'contact_id':table==='recruiting_campaign_schools'?'university_id':'id').range(offset,offset+499);if(result.error)throw Error(table+': '+result.error.message);out.push(...result.data);if(result.data.length<500)return out;}}
 function bind(rootEl){
  rootEl.querySelectorAll('[data-scope-contact]').forEach(b=>b.onclick=()=>{state.a.openContact(b.dataset.scopeContact);setDrawer(state.key);});
  rootEl.querySelectorAll('[data-scope-prep]').forEach(b=>b.onclick=()=>state.a.openPreparation(state.key,b.dataset.scopePrep||null));
  rootEl.querySelectorAll('[data-scope-current]').forEach(b=>b.onclick=()=>setScope(state.data.campaigns[0]?.id||'all'));
  rootEl.querySelectorAll('[data-scope-refresh]').forEach(b=>b.onclick=refresh);
 }
 function status(){return `<div class="crm-empty">${esc(state.error||'活動別の記録を読み込んでいます…')} <button type="button" data-scope-refresh>更新</button></div>`;}
 function ready(){return state.m&&!state.loading&&!state.error;}
 function name(c){return state.data.schools.find(u=>u.id===Number(c?.university_id));}
 function schoolTitle(u){return state.a.schoolName(u);}
 function renderOutreach(){
  if(!enabled())return false;selectors();const el=$('outreach-school-list');if(!el)return true;
  if(!ready()){el.innerHTML=status();const badge=$('nav-count-outreach');if(badge)badge.textContent='—';bind(el);return true;}
  let hs=state.m.historiesFor(null,state.key);const filter=state.a.outreachFilter();
  const groups=new Map();for(const h of hs){const c=state.data.contacts.find(c=>c.id===h.contact_id),u=name(c);if(!u)continue;if(!groups.has(u.id))groups.set(u.id,{u,hs:[]});groups.get(u.id).hs.push(h);}
  let list=[...groups.values()].sort((a,b)=>Date.parse(b.hs[0]?.event_at)-Date.parse(a.hs[0]?.event_at));
  list=list.filter(g=>{const replied=g.hs.some(h=>h.event_type==='reply_received');return filter==='responded'?replied:filter==='waiting'?!replied:filter==='due'?state.m.queue(state.key).some(q=>q.university_id===g.u.id&&q.status==='scheduled'&&Date.parse(q.scheduled_at)<=Date.now())&&!replied:true;});
  const count=$('outreach-area-count');if(count)count.textContent=list.length;
  const badge=$('nav-count-outreach');if(badge)badge.textContent=groups.size;
  el.innerHTML=list.length?list.map(g=>`<article class="outreach-school-card"><div class="outreach-card-head"><h3>${schoolTitle(g.u)}</h3><span class="scope-badge">${esc(label(state.key))}</span></div><p>${g.hs.length}件の履歴 · 最終記録 ${esc(date(g.hs[0]?.event_at))}</p>${g.hs.slice(0,3).map(h=>eventHTML(h)).join('')}${g.hs.length>3?`<details><summary>残りの履歴を表示（${g.hs.length-3}件）</summary>${g.hs.slice(3).map(h=>eventHTML(h)).join('')}</details>`:''}</article>`).join(''):`<div class="crm-empty">${state.key==='legacy'?'過去の活動の履歴はありません。':state.key==='all'?'連絡履歴はまだありません。':'この活動の連絡履歴はまだありません。過去への送信は「過去の活動」で確認できます。'}${state.m.defs.has(state.key)?'<p><button data-scope-prep>この活動の送信準備へ</button></p>':''}</div>`;
  bind(el);return true;
 }
 function eventHTML(h,allowContact=true){const c=state.data.contacts.find(c=>c.id===h.contact_id);return `<div class="scope-event"><b>${esc(EVENTS[h.event_type]||h.event_type)}</b> · ${esc(date(h.event_at))} <span class="scope-badge">${esc(label(h.scope))}</span><p>${esc(c?.coach_name||'コーチ')} ${c&&allowContact?`<button data-scope-contact="${esc(c.id)}">詳細</button>`:''}</p>${h.note?`<details><summary>記録の内容</summary><div class="scope-note">${esc(h.note)}</div></details>`:''}</div>`;}
 function renderCRM(){
  if(!enabled())return false;selectors();const el=$('crm-scoped-overview'),legacy=$('crm-legacy-overview');if(legacy)legacy.hidden=true;if(!el)return true;el.hidden=false;
  if(!ready()){el.innerHTML=status();bind(el);return true;}
  if(!el.querySelector('[data-scope-search]')){
   el.innerHTML=`<div class="scope-tools"><label>学校・コーチを検索<input data-scope-search type="search"></label><label>連絡状況<select data-scope-filter><option value="all">すべて</option>${Object.entries(STATES).filter(([v])=>state.key==='legacy'?['unsent','reply','history'].includes(v):state.key==='all'?['unsent','reply','excluded','history'].includes(v):v!=='history').map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select></label><label class="scope-check"><input data-scope-favorite type="checkbox">お気に入り校のみ</label><button data-scope-refresh>表示を更新</button></div><p id="crm-scope-count"></p><div id="crm-scope-list"></div>`;
   el.querySelector('[data-scope-search]').value=state.search;el.querySelector('[data-scope-search]').oninput=e=>{state.search=e.target.value;renderCRMRows();};el.querySelector('[data-scope-filter]').value=state.filter;el.querySelector('[data-scope-favorite]').checked=state.favorite;el.querySelector('[data-scope-filter]').onchange=e=>{state.filter=e.target.value;renderCRMRows();};el.querySelector('[data-scope-favorite]').onchange=e=>{state.favorite=e.target.checked;renderCRMRows();};el.querySelector('[data-scope-refresh]').onclick=refresh;
  }
  renderCRMRows();return true;
 }
 function renderCRMRows(){
  const el=$('crm-scope-list');if(!el||!ready())return;const all=state.m.contactsFor(state.key);
  const cs=all.map(c=>({c,u:name(c),s:state.m.contactState(c,state.key)})).filter(r=>r.u&&(!state.favorite||r.u.fav)&&(state.filter==='all'||r.s.key===state.filter)&&(!state.search||[r.u.name,r.c.coach_name,r.c.coach_email].join(' ').toLowerCase().includes(state.search.toLowerCase()))).sort((a,b)=>a.u.name.localeCompare(b.u.name)||String(a.c.coach_role).localeCompare(String(b.c.coach_role)));
  $('crm-scope-count').textContent=`${label(state.key)}：${new Set(all.map(c=>c.university_id)).size}校・${all.length}コーチ ／ 表示 ${cs.length}名`;
  el.innerHTML=cs.map(({c,u,s})=>`<article class="scope-contact"><div><h3>${schoolTitle(u)}</h3><b>${esc(c.coach_role==='head_coach'?'HC':'AC')} · ${esc(c.coach_name)}</b><p>${esc(c.coach_email||'宛先未確認')}</p><span class="scope-badge">${esc(s.label)}</span>${s.reason?`<p class="warn">${esc(s.reason)}</p>`:''}<p>この活動の最終連絡：${esc(date(s.last))}</p>${state.m.defs.has(state.key)?`<p class="scope-stages">${s.stages.map(x=>esc(STAGES[x.stage])+': '+esc(x.label)).join(' ／ ')}</p>`:''}</div><button data-scope-contact="${esc(c.id)}">詳細</button></article>`).join('')||'<div class="crm-empty">この活動・条件に該当するコーチはありません。</div>';bind(el);
 }
 function renderReservations(){
  if(!enabled())return false;const old=$('crm-legacy-reservations'),el=$('crm-scoped-reservations');if(old)old.hidden=true;if(!el)return true;el.hidden=false;
  if(!ready()){el.innerHTML=status();bind(el);return true;}
  const tab=$('crm-tab-reservations');if(tab)tab.textContent='予約・送信記録';
  const qs=state.m.queue(state.key),plans=state.m.defs.has(state.key)?state.data.messages.filter(m=>m.campaign_id===state.key&&m.planned_at&&!qs.some(q=>q.stage===m.stage&&q.contact_ids.includes(m.contact_id)&&q.status!=='cancelled')):[];
  const seen=new Set(),uniquePlans=plans.filter(m=>{const c=state.data.contacts.find(c=>c.id===m.contact_id),key=[c?.university_id,email(c||{}),m.stage].join('|');if(seen.has(key))return false;seen.add(key);return true;});
  el.innerHTML=`<p>${esc(label(state.key))}：予約・送信記録 ${qs.length}件。日時案の保存は予約ではありません。</p>${qs.map(q=>{const cs=state.data.contacts.filter(c=>q.contact_ids.includes(c.id)),u=state.data.schools.find(u=>u.id===Number(q.university_id))||name(cs[0]);return `<article class="scope-contact"><div><h3>${u?schoolTitle(u):'学校'}</h3><span class="scope-badge">${esc(label(q.scope))}</span> ${esc(STAGES[q.stage]||q.stage)} · <b>${esc(QUEUE[q.status]||q.status)}</b><p>${esc(q.recipient_email||cs[0]?.coach_email||'')} · ${esc(cs.map(c=>c.coach_name).join(' / '))}</p><p>日時（日本時間）：${esc(date(q.scheduled_at||q.sent_at))}</p>${q.error_message?`<p class="warn">${esc(q.error_message)}</p>`:''}</div>${cs[0]?`<button data-scope-contact="${esc(cs[0].id)}">履歴・詳細</button>`:''}${q.kind==='campaign'&&['scheduled','processing','held'].includes(q.status)&&!q.transport_started_at?`<button data-scope-cancel="${esc(q.id)}">予約を停止</button>`:''}${q.kind==='followup'&&q.status==='scheduled'&&q.batch_id?`<button data-scope-old-cancel="${esc(q.batch_id)}">この従来予約を取消</button>`:''}</article>`;}).join('')||'<div class="crm-empty">この活動の予約・送信記録はありません。</div>'}${uniquePlans.length?`<h3>日時案（まだ予約されていません）</h3>${uniquePlans.map(m=>{const c=state.data.contacts.find(c=>c.id===m.contact_id);return `<p>${esc(name(c)?.name||'')} · ${esc(c?.coach_email||'')} · ${esc(STAGES[m.stage])} · ${esc(date(m.planned_at))}</p>`;}).join('')}`:''}${state.m.defs.has(state.key)?'<button data-scope-prep>この活動の送信準備・予約前チェックへ</button>':''}`;
  bind(el);el.querySelectorAll('[data-scope-cancel]').forEach(b=>b.onclick=()=>queueAction(b,'cancel',{delivery_id:b.dataset.scopeCancel}));el.querySelectorAll('[data-scope-old-cancel]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await state.a.cancelLegacy(b.dataset.scopeOldCancel);await refresh();}catch(e){alert(e.message);}finally{b.disabled=false;}});return true;
 }
 async function queueAction(button,action,payload){button.disabled=true;try{const {data,error}=await state.a.client().functions.invoke('recruiting-campaign-outreach',{body:{action,...payload}});if(error||!data?.ok)throw Error(data?.error||error?.message);await refresh();}catch(e){alert(e.message);}finally{button.disabled=false;}}
 function trackingHTML(ts){
  if(state.a.engagementRows)return state.a.engagementRows(ts);
  return ts.map(t=>{const c=state.data.contacts.find(c=>c.id===t.contact_id);return `<article class="scope-event"><b>${esc(name(c)?.name||'学校')} · ${esc(c?.coach_name||'')}</b><p>${esc(STAGES[t.stage]||({'reply':'個別返信','conversation_follow_up':'返信後のFollow-up'}[t.stage])||t.stage)} · ${esc(t.status==='sent'?'送信済み':t.status==='send_unknown'?'送信結果不明':'送信確認前')} · ${esc(date(t.sent_at))}</p><p>Profile：${esc(date(t.first_profile_at))} ／ YouTube：${esc(date(t.first_youtube_at))} ／ 開封の兆候：${esc(date(t.first_open_at))}</p></article>`;}).join('');
 }
 function renderInterest(){
  if(!enabled())return false;const old=$('crm-legacy-interest'),el=$('crm-scoped-interest');if(old)old.hidden=true;if(!el)return true;el.hidden=false;if(!ready()){el.innerHTML=status();bind(el);return true;}
  const all=state.m.scopedTracks(state.key),ts=all.filter(t=>!state.interestSchool||Number(t.university_id||state.data.contacts.find(c=>c.id===t.contact_id)?.university_id)===state.interestSchool),u=state.data.schools.find(u=>u.id===state.interestSchool);
  el.innerHTML=`<p><b>${esc(label(state.key))}${u?' ／ '+esc(u.name):''}</b>：計測メール ${ts.length}通。閲覧・動画への反応と採用への関心は別です。未検知は未読の証明ではありません。</p>${state.interestSchool?'<button id="scope-interest-clear">学校の絞り込みを解除</button>':''}<button data-scope-refresh>反応の記録を更新</button>${ts.length?trackingHTML(ts):'<div class="crm-empty">この活動・学校に紐付く計測メールはありません。</div>'}`;
  if($('scope-interest-clear'))$('scope-interest-clear').onclick=()=>{state.interestSchool=null;renderInterest();};bind(el);return true;
 }
 function openInterest(id){if(!enabled())return false;state.interestSchool=Number(id);setScope('all');if(!state.loading)refresh();return true;}
 function renderContactEngagement(){
  if(!enabled())return false;const el=$('crm-contact-engagement');if(!el)return true;
  if(!ready()){el.innerHTML=status();bind(el);return true;}
  const c=state.contact;if(!c){el.innerHTML='';return true;}
  const ts=state.m.scopedTracks(state.drawer).filter(t=>t.contact_id===c.id||((dataMessagesFor(t,c.id))||(email(c)&&Number(t.university_id)===Number(c.university_id)&&String(t.recipient_email||'').trim().toLowerCase()===email(c))));
  el.innerHTML=`<p><b>表示中：${esc(label(state.drawer))}</b> ／ ${esc(c.coach_name)}・同校の共有宛先</p>${ts.length?trackingHTML(ts):'<div class="crm-empty">この活動に紐付く、このコーチの計測メールはありません。</div>'}`;return true;
 }
 function dataMessagesFor(t,id){return state.data.messages.some(m=>m.contact_id===id&&m.tracking_id===t.id);}
 function setDrawer(key){if(state.m&&!['all','legacy',...state.m.defs.keys()].includes(key))return;state.drawer=key;renderDrawer();renderHistory(state.history);renderContactEngagement();}
 function onContact(c,area){state.contact=c;state.history=[];state.drawer=['outreach','crm'].includes(area)?state.key:'all';renderDrawer();renderContactEngagement();if(!state.m&&!state.loading)refresh();}
 function renderDrawer(){
  const el=$('crm-activity-context');if(!el||!enabled()||!state.contact)return;el.hidden=false;
  const overview=$('crm-drawer')?.querySelector('.coach-overview-facts');if(overview)overview.hidden=state.drawer!=='all';const replyTitle=$('crm-latest-reply-section')?.querySelector('h3');if(replyTitle)replyTitle.textContent='実際の返信元メール（全活動の最新記録）';
  el.innerHTML=`<label>このコーチの履歴・実績を表示する活動<select id="crm-drawer-scope">${options(state.drawer)}</select></label><p class="scope-caption">基本情報・記録の編集、返信原稿の宛先は実際のコーチ記録を使います。表示する活動を変えても送信先・元メールは変わりません。</p><div id="crm-drawer-activity-summary"></div>`;
  const select=$('crm-drawer-scope');select.disabled=!ready();select.value=state.drawer;select.onchange=e=>setDrawer(e.target.value);
  if(!ready()){$('crm-drawer-activity-summary').textContent=state.error||'活動別の記録を確認中…';return;}
  const s=state.m.contactState(state.contact,state.drawer);
  $('crm-drawer-activity-summary').innerHTML=`<b>${esc(label(state.drawer))}</b><p>${esc(s.label)} · 最終連絡 ${esc(date(s.last))}</p>${state.m.defs.has(state.drawer)?`<p>${s.stages.map(x=>esc(STAGES[x.stage])+': '+esc(x.label)).join('<br>')}</p><button id="crm-drawer-prep">この活動の送信準備を開く</button>`:''}`;
  if($('crm-drawer-prep'))$('crm-drawer-prep').onclick=()=>state.a.openPreparation(state.drawer,state.contact.id);
 }
 function renderHistory(history){
  state.history=history||[];if(!enabled())return false;if(state.m&&!state.loading&&state.history.some(h=>!state.data.histories.some(old=>old.id===h.id)))refresh();const el=$('crm-history-list');if(!el)return true;if(!ready()){el.innerHTML=status();bind(el);return true;}
  const hs=state.history.map(h=>({...h,scope:state.m.historyScope(h)})).filter(h=>state.drawer==='all'||h.scope===state.drawer);
  const summary=$('crm-history-summary');if(summary)summary.textContent=`連絡履歴：${label(state.drawer)}（${hs.length}件／全${history.length}件）`;
  el.innerHTML=`<p class="scope-caption">表示中：${esc(label(state.drawer))}。他の活動・共通記録は活動の切替で参照できます。</p>${hs.map(h=>eventHTML(h,false)).join('')||'<div class="crm-empty">この活動の連絡履歴はまだありません。</div>'}`;bind(el);return true;
 }
 function render(){if(!enabled())return;selectors();renderOutreach();renderCRM();renderReservations();renderInterest();renderContactEngagement();if(state.contact){renderDrawer();renderHistory(state.history);}}
 function setScope(key){state.key=key;state.search='';state.filter='all';state.favorite=false;const panel=$('crm-scoped-overview');if(panel)panel.innerHTML='';render();}
 async function refresh(){
  if(!enabled()||!state.a.client()||!state.a.owner())return;const request=++state.request,owner=state.a.owner();state.loading=true;state.error='';render();
  try{
   const keys=['campaigns','members','messages','deliveries','schoolStates','histories','records','tracking','initialJobs','followups','leads','issues'];
   const results=await Promise.all([rows('recruiting_campaigns'),rows('recruiting_campaign_contacts'),rows('recruiting_campaign_messages'),rows('recruiting_campaign_deliveries'),rows('recruiting_campaign_schools'),rows('recruiting_contact_history','id,contact_id,event_type,event_at,note,gmail_message_id,to_status,from_status'),rows('recruiting_activity_records'),rows('recruiting_email_tracking','id,contact_id,university_id,recipient_email,stage,is_test,status,sent_at,gmail_message_id,campaign_delivery_id,first_profile_at,first_youtube_at,first_open_at'),rows('recruiting_initial_email_jobs','id,campaign_key,university_id,contact_id,contact_ids,recipient_email,status,scheduled_at,sent_at,created_at,error_message,gmail_message_id'),rows('recruiting_followup_batch_items','id,batch_id,university_id,contact_id,recipient_email,status,scheduled_at,sent_at,created_at,error_message,expected_follow_up_count,mode,gmail_message_id'),rows('recruiting_inbound_leads','id,linked_contact_id,coach_email,lead_status'),rows('recruiting_campaign_issues','id,campaign_id,university_id,contact_ids,status,blocking,kind')]);
   if(request!==state.request||owner!==state.a.owner())return;
   state.data=Object.fromEntries(keys.map((key,i)=>[key,results[i]]));state.data.campaigns.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));state.data.contacts=state.a.contacts();state.data.schools=state.a.schools();state.m=model(state.data);
   if(state.key==='default'||!['all','legacy',...state.data.campaigns.map(p=>p.id)].includes(state.key))state.key=state.data.campaigns[0]?.id||'legacy';
  }catch(e){if(request===state.request){console.warn('Activity scope unavailable',e.message);state.error='活動の情報を取得できませんでした。ログイン状態を確認して更新してください。';}}finally{if(request===state.request){state.loading=false;render();}}
 }
 function configure(a){state.a=a;if(state.booted)return;state.booted=true;document.querySelectorAll('[data-correspondence-scope]').forEach(s=>s.onchange=e=>setScope(e.target.value));document.querySelectorAll('[data-scope-refresh]').forEach(b=>b.onclick=refresh);selectors();}
 function onArea(area){if(!enabled())return;if(['outreach','crm'].includes(area)){if(!state.loading)refresh();else render();}}
 function clear(){state.request++;state.data=null;state.m=null;state.key='default';state.interestSchool=null;state.contact=null;state.history=[];state.error='';state.loading=false;for(const id of ['outreach-school-list','crm-scoped-overview','crm-scoped-reservations','crm-scoped-interest','crm-activity-context']){const el=$(id);if(el)el.replaceChildren();}selectors();}
 root.CRMActivityUI={configure,refresh,onArea,renderOutreach,renderCRM,renderReservations,renderInterest,openInterest,renderContactEngagement,renderHistory,onContact,setDrawer,clear,render,scope:()=>state.key};
})(window);
