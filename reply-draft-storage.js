'use strict';
const CRM_REPLY_DRAFT_TEXT_FIELDS=['direction','subject','body','translation','translationSubject','translatedBody','translatedSubject','origin','cc','replyMessageId','replyGmailMessageId'];
function replyDraftPayload(s,c=crmCurrentContact){
 const value={};for(const key of CRM_REPLY_DRAFT_TEXT_FIELDS)value[key]=String(s[key]||'');
 value.agency=s.agency===true;value.analysis=s.analysis&&typeof s.analysis==='object'?s.analysis:null;
 value.rationale=String(s.rationale||'');value.requestedItems=String(s.requestedItems||'');
 value.stageSuggestion=crmAiStageSuggestionFor.get(c?.id)||null;return value;
}
function replyDraftSnapshot(value){const order=x=>Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;return JSON.stringify(order(value));}
function replyDraftHasContent(value){return Boolean(value.direction.trim()||value.subject.trim()||value.body.trim()||value.analysis);}
async function replyDraftSourceKey(c,s){
 const input=JSON.stringify([c.id,s.sourceAnchor||'',s.source]);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
 return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
}
function replyDraftContextCurrent(c,s){return crmCurrentContact?.id===c.id&&String(crmCurrentContact.coach_response||'')===s.source&&crmReplySourceAnchor(crmCurrentContact)===s.sourceAnchor&&crmReplyWorkspaceStates.get(c.id)===s;}
function updateReplyDraftStorageUi(c=crmCurrentContact){
 if(!c||crmCurrentContact?.id!==c.id||String(c.coach_response||'')!==String(crmCurrentContact.coach_response||'')||String(c.gmail_thread_id||'')!==String(crmCurrentContact.gmail_thread_id||''))return;const s=replyWorkspace(crmCurrentContact),active=crmCanComposeCoachReply(crmCurrentContact);
 const save=document.getElementById('crm-save-reply-draft'),restore=document.getElementById('crm-restore-reply-draft'),status=document.getElementById('crm-reply-draft-storage-status');
 if(save)save.disabled=!active||Boolean(s.busy||s.draftStorageBusy||s.draftStorageLoading)||!replyDraftHasContent(replyDraftPayload(s,c));
 if(restore)restore.disabled=!active||Boolean(s.busy||s.draftStorageBusy||s.draftStorageLoading)||(!s.savedDraftRecord&&!s.draftStorageLoadError);
 if(restore)restore.textContent=s.draftStorageLoadError?'保存済みを再確認':'保存済みを復元';
 if(status)status.textContent=s.draftStorageBusy?'下書きを保存中…':s.draftStorageLoading?'保存済みの下書きを確認中…':s.draftStorageNotice||(s.draftDirty?'変更は未保存です。「下書きを保存」で残せます。':s.draftSavedAt?'保存済み：'+new Date(s.draftSavedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'保存すると、再読み込み後もこの返信の下書きを復元できます。');
 const panel=document.getElementById('crm-ai-reply-panel');if(panel&&active&&(s.draftStorageNotice||s.draftDirty||s.draftSavedAt))panel.hidden=false;
}
function markReplyDraftEdited(c=crmCurrentContact){
 if(!c||crmCurrentContact?.id!==c.id)return;const s=replyWorkspace(c);s.draftDirty=true;s.draftStorageNotice='';updateReplyDraftStorageUi(c);
}
async function saveCrmReplyDraft(){
 const c=crmCurrentContact;if(!c||!crmCanComposeCoachReply(c))return;
 const s=replyWorkspace(c);if(s.busy||s.draftStorageBusy||s.draftStorageLoading||s.sent)return;
 captureCrmReplyWorkspace();const payload=replyDraftPayload(s,c);if(!replyDraftHasContent(payload))return;
 if(s.draftRemotePending&&!confirm('保存済みの下書きがあります。現在の編集内容で更新しますか？'))return;
 s.draftStorageBusy=true;s.draftStorageNotice='';updateReplyDraftStorageUi(c);
 try{
  const sourceKey=await replyDraftSourceKey(c,s);
  const {data,error}=await supabaseClient.rpc('save_recruiting_reply_draft',{p_contact_id:c.id,p_source_key:sourceKey,p_draft:payload,p_expected_revision:s.savedDraftKey===sourceKey?Number(s.savedDraftRevision||0):0});
  if(error)throw error;const row=Array.isArray(data)?data[0]:data;if(!row)throw new Error('保存結果を確認できませんでした。');
  s.savedDraftKey=sourceKey;s.savedDraftRevision=row.revision;s.draftSavedAt=row.updated_at;s.savedDraftRecord={draft:payload,revision:row.revision,updated_at:row.updated_at};s.draftRemotePending=false;
  if(replyDraftContextCurrent(c,s))captureCrmReplyWorkspace();
  s.draftDirty=replyDraftSnapshot(replyDraftPayload(s,c))!==replyDraftSnapshot(payload);
  s.draftStorageNotice=s.draftDirty?'下書きを保存しました。その後の変更は未保存です。':'下書きを保存しました。再読み込み後も復元できます。';
 }catch(error){s.draftStorageNotice=error?.code==='40001'?'別の画面で下書きが更新されています。編集内容は残しています。「保存済みを復元」で最新の保存内容を確認してください。':'下書きを保存できませんでした：'+(error?.message||'接続を確認してください。');}
 finally{s.draftStorageBusy=false;updateReplyDraftStorageUi(c);}
}
async function loadCrmReplyDraft(c=crmCurrentContact,force=false){
 if(!c||crmCurrentContact?.id!==c.id||!crmCanComposeCoachReply(c))return;
 const s=replyWorkspace(c);if(s.busy||s.draftStorageBusy||s.sent)return;
 captureCrmReplyWorkspace();const localBefore=replyDraftSnapshot(replyDraftPayload(s,c));
 const request=(s.draftStorageRequest||0)+1;s.draftStorageRequest=request;s.draftStorageLoading=true;s.draftStorageLoadError=false;s.draftStorageNotice='';updateReplyDraftStorageUi(c);
 const active=()=>replyDraftContextCurrent(c,s)&&s.draftStorageRequest===request;
 try{
  const sourceKey=await replyDraftSourceKey(c,s);
  const {data,error}=await supabaseClient.from('recruiting_reply_drafts').select('draft,revision,updated_at').eq('owner_user_id',DASHBOARD_OWNER_ID).eq('contact_id',c.id).eq('source_key',sourceKey).maybeSingle();
  if(error)throw error;if(!active())return;
  s.savedDraftKey=sourceKey;s.savedDraftRevision=data?.revision||0;s.savedDraftRecord=data||null;
  if(!data){s.draftStorageNotice='このコーチの現在の返信には、保存済みの下書きはありません。';return;}
  s.draftSavedAt=data.updated_at;
  captureCrmReplyWorkspace();const localNow=replyDraftPayload(s,c),remote=data.draft||{};
  const changed=localBefore!==replyDraftSnapshot(localNow)||s.busy||s.sent;
  if(!force&&(changed||(replyDraftHasContent(localNow)&&replyDraftSnapshot(localNow)!==replyDraftSnapshot(remote)))){s.draftRemotePending=true;s.draftStorageNotice='保存済みの下書きがあります。現在の入力は保っています。必要なら「保存済みを復元」を押してください。';return;}
  if(force&&replyDraftHasContent(localNow)&&replyDraftSnapshot(localNow)!==replyDraftSnapshot(remote)&&!confirm('現在の編集内容を、保存済みの下書きに置き換えますか？'))return;
  if(s.busy||s.sent)return;
  for(const key of CRM_REPLY_DRAFT_TEXT_FIELDS)s[key]=String(remote[key]||'');
  s.origin=s.origin==='ai'?'ai':'manual';s.agency=remote.agency===true;s.analysis=remote.analysis&&typeof remote.analysis==='object'?remote.analysis:null;
  s.rationale=String(remote.rationale||'');s.requestedItems=String(remote.requestedItems||'');s.draftDirty=false;s.draftRemotePending=false;
  const proposal=remote.stageSuggestion;
  if(proposal&&Object.prototype.hasOwnProperty.call(RECRUITING_STAGE_LABELS,proposal.stage)&&proposal.stage!=='none'){crmAiStageSuggestionFor.set(c.id,proposal);crmAiStageDecisionFor.set(c.id,'pending');}
  else{crmAiStageSuggestionFor.delete(c.id);crmAiStageDecisionFor.set(c.id,'none');}
  s.draftStorageNotice='保存済みの下書きを復元しました。送信前の確認は、あらためて行ってください。';
  restoreReplyWorkspace(c);const checked=document.getElementById('gmail-reply-reviewed');if(checked)checked.checked=false;
  renderCrmAiStageSuggestion(c);
 }catch(error){if(active()){s.draftStorageLoadError=true;s.draftStorageNotice='保存済みの下書きを確認できませんでした：'+(error?.message||'接続を確認してください。');}}
 finally{if(s.draftStorageRequest===request)s.draftStorageLoading=false;updateReplyDraftStorageUi(c);}
}
