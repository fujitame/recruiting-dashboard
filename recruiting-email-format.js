'use strict';
(function(root){
function escapeEmail(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderRecruitingEmail(body){
 const linked=text=>{let out='',last=0;for(const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)){out+=escapeEmail(text.slice(last,m.index));const url=m[0],label=url.includes('/functions/v1/recruiting-email-events?event=profile')?'View Recruiting Profile':url.includes('/functions/v1/recruiting-email-events?event=youtube')?'Watch Highlights on YouTube':url;out+='<a href="'+escapeEmail(url)+'" style="font-weight:400;color:#145ea8">'+escapeEmail(label)+'</a>';last=m.index+url.length;}return out+escapeEmail(text.slice(last));};
 const content=String(body??'').split('\n').map(line=>{
  const label=/^(▶ (?:Highlights|Profile & résumé):)(.*)$/.exec(line);
  if(label)return '<strong>'+escapeEmail(label[1])+'</strong>'+linked(label[2]);
  if(!/https?:\/\//.test(line)&&(/\| NJCAA Division I \| Pennsylvania, USA$/.test(line)||/^FB \/ WB \/ LM \| Fall \d{4} Transfer \| Harcum GPA: \d+(?:\.\d+)?$/.test(line)))return '<strong>'+escapeEmail(line)+'</strong>';
  return linked(line);
 }).join('\n');
 return '<div style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#202124">'+content+'</div>';
}
function campaignReviewState(message,review){if(!message?.subject?.trim()||!message?.body?.trim())return 'empty';if(!review?.body_ja?.trim()||!review?.subject_ja?.trim())return 'translation_missing';if(review.source_subject!==message.subject||review.source_body!==message.body)return 'stale';return review.reviewed?'reviewed':'draft';}
root.RecruitingEmailFormat={render:renderRecruitingEmail,reviewState:campaignReviewState};
})(typeof window!=='undefined'?window:globalThis);
