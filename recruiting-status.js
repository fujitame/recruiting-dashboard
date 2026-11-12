'use strict';
(function(root){
 const contactLabels=Object.freeze({not_contacted:'未連絡',draft_ready:'未連絡',deferred:'宛先・情報要確認',contacted:'送信済・返信待',follow_up_due:'要Follow-up',responded:'返信あり',no_response:'返信なし（Follow-up完了）',not_a_fit:'対象外',closed:'対応終了',partial:'一部コーチ未連絡',unverified:'未確認'});
 const progress=Object.freeze({unset:'未設定',unknown:'未確認',conversation:'やり取り中',camp_candidate:'IDキャンプ候補',camp:'IDキャンプ招待',camp_scheduled:'IDキャンプ予定',camp_attended:'IDキャンプ参加済',meeting:'個別面談',terms:'条件提示',offer_candidate:'オファー検討中',offer:'オファー受領',not_interested:'関心なし',declined:'辞退・対象外'});
 const pipelineKeys=Object.freeze({none:'unset',id_camp_candidate:'camp_candidate',id_camp_scheduled:'camp_scheduled',id_camp_attended:'camp_attended',offer_candidate:'offer_candidate',offer_received:'offer'});
 const campaignKeys=Object.freeze({unknown:'unknown',conversation:'conversation',camp:'camp',meeting:'meeting',terms:'terms',offer:'offer',not_interested:'not_interested',declined:'declined'});
 const labels=keys=>Object.freeze(Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,progress[value]])));
 function schoolContactState(rows,{available=true,isDeferred=()=>false}={}){
  const result=(state,priority=false)=>({state,label:contactLabels[state],priority});
  if(!available||!rows.length)return result('unverified');
  const state=c=>c.contact_status==='draft_ready'?'not_contacted':c.contact_status;
  if(rows.every(c=>state(c)==='closed'))return result('closed');
  if(rows.every(c=>['closed','not_a_fit'].includes(state(c))))return result('not_a_fit');
  if(rows.some(c=>state(c)==='responded'||String(c.coach_response||'').trim()))return result('responded',rows.some(c=>state(c)==='responded'&&c.interest_level==='high'));
  const uncontacted=rows.some(c=>state(c)==='not_contacted'&&!isDeferred(c));
  if(uncontacted&&rows.some(c=>['contacted','follow_up_due','no_response'].includes(state(c))))return result('partial');
  if(rows.some(c=>state(c)==='follow_up_due'))return result('follow_up_due');
  if(rows.some(c=>state(c)==='contacted'))return result('contacted');
  if(rows.some(c=>state(c)==='no_response'))return result('no_response');
  if(uncontacted)return result('not_contacted');
  if(rows.some(c=>state(c)==='not_contacted'&&isDeferred(c)))return result('deferred');
  return result('unverified');
 }
 root.RecruitingStatus=Object.freeze({contactLabels,pipelineLabels:labels(pipelineKeys),campaignLabels:labels(campaignKeys),schoolContactState});
})(window);
