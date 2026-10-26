export const ENGAGEMENT_LABELS={4:"強い反応",3:"操作あり",2:"リンク反応",1:"参考情報のみ",0:"未検知",none:"計測対象なし"};
export function emailInterest(rows,signals,now=Date.now()){
 const valid=rows.filter(r=>r.status==="sent"),ids=new Set(valid.map(r=>r.id)),since=now-30*86400000;
 const recent=date=>date&&Date.parse(date)>=since&&Date.parse(date)<=now+60000;
 const events=signals.filter(e=>ids.has(e.tracking_id)&&recent(e.last_at||e.first_at));
 const evidence=[];let rank=valid.length?0:-1,latest=0;
 function add(value,label,date){rank=Math.max(rank,value);evidence.push(label);latest=Math.max(latest,Date.parse(date)||0);}
 for(const e of events){
  const slot=e.video_slot==="secondary"?"夏季映像":"メイン映像",date=e.last_at||e.first_at;
  if(e.event==="video_30s")add(4,slot+"：表示中に累計30秒再生",date);
  else if(e.event==="resume_click")add(4,"Resumeダウンロード操作",date);
  else if(e.event==="video_start")add(3,slot+"：再生開始",date);
  else if(e.event==="profile_active_15s")add(3,"操作後、Profileを15秒表示",date);
  else if(e.event==="profile_interaction")add(3,"Profileで操作あり",date);
  else if(e.event==="profile_youtube_click")add(3,slot+"：ProfileからYouTubeを開く操作",date);
 }
 for(const r of valid){
  if(recent(r.last_youtube_at||r.first_youtube_at))add(2,"メールからYouTubeリンク取得",r.last_youtube_at||r.first_youtube_at);
  if(recent(r.last_profile_at||r.first_profile_at))add(2,"Profileリンク取得",r.last_profile_at||r.first_profile_at);
  if(recent(r.last_open_at||r.first_open_at))add(1,"画像取得のみでは人の開封を確認できません",r.last_open_at||r.first_open_at);
 }
 return {rank,label:rank<0?ENGAGEMENT_LABELS.none:ENGAGEMENT_LABELS[rank],evidence:[...new Set(evidence)],latest,tracked:valid.length};
}
