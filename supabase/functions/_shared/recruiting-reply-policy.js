export const REPLY_AGENCY_CC="recruit@withtyou-usa.com";
export function normalizeReplyCc(value,primary=""){
 if(value==null||value==="")return [];
 if(typeof value!=="string"&&!Array.isArray(value))throw new Error("CCはメールアドレスをカンマ区切りで入力してください。");
 const raw=Array.isArray(value)?value:[value];
 if(raw.some(v=>typeof v!=="string"||/[\r\n]/.test(v)))throw new Error("CCに改行や不正な値を含めることはできません。");
 if(raw.join(",").length>2000)throw new Error("CCが長すぎます。");
 const entries=raw.flatMap(v=>v.split(/[,;]/)).map(v=>v.trim()).filter(Boolean);
 if(entries.length>10)throw new Error("CCは10件以内で入力してください。");
 const valid=/^[a-zA-Z0-9.!#$%&'*+/=?^_{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/;
 if(entries.some(v=>!valid.test(v)||v.includes("..")))throw new Error("CCは表示名を付けず、メールアドレスのみ入力してください。");
 return [...new Set(entries.map(v=>v.toLowerCase()))].filter(v=>v!==String(primary).trim().toLowerCase());
}
export function recruitingReplySubject(subject){
 const clean=String(subject||"").replace(/[\r\n]/g," ").trim();
 return /^re\s*:/i.test(clean)?clean:"Re: "+(clean||"Recruiting — Akihiro Fujikawa");
}
export function manualRecruitingReply(coach,player){
 const name=String(coach||"").replace(/[\r\n]/g," ").trim().split(/\s+/).pop()||"Coach";
 const greeting=name==="Coach"?"Dear Coach,":"Dear Coach "+name+",";
 return greeting+"\n\n\n\nBest regards,\n"+String(player.name||"Akihiro Fujikawa")+"\n"+String(player.school||"Harcum College")+" | Men's Soccer\n"+String(player.email||"fujiakihiro8@gmail.com");
}
