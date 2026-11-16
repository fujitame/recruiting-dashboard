'use strict';
(function(root){
 const cache=new Map(),hour=3600000;
 function formatter(zone){if(!zone)throw Error('学校のタイムゾーンを確認できません。');if(!cache.has(zone))cache.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));return cache.get(zone);}
 function parts(instant,zone){const date=new Date(instant);if(!Number.isFinite(date.getTime()))throw Error('日時を確認してください。');return Object.fromEntries(formatter(zone).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
 function utc(p){const d=new Date(0);d.setUTCFullYear(p.year,p.month-1,p.day);d.setUTCHours(p.hour,p.minute,p.second||0,0);return d.getTime();}
 const same=(a,b)=>['year','month','day','hour','minute','second'].every(k=>(a[k]||0)===(b[k]||0));
 const pad=n=>String(n).padStart(2,'0');
 function localInput(instant,zone){if(!instant)return '';const p=parts(instant,zone);return p.year+'-'+pad(p.month)+'-'+pad(p.day)+'T'+pad(p.hour)+':'+pad(p.minute);}
 function toUtc(input,zone){
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input||'');if(!m)throw Error('学校現地の日付と時刻を入力してください。');
  const p={year:+m[1],month:+m[2],day:+m[3],hour:+m[4],minute:+m[5],second:0},nominal=utc(p);
  if(!same(parts(nominal,'UTC'),p))throw Error('有効な日付・時刻を入力してください。');
  const offsets=new Set();for(let delta=-48;delta<=48;delta+=6){const t=nominal+delta*hour;offsets.add(utc(parts(t,zone))-t);}
  const matches=[...offsets].map(offset=>nominal-offset).filter(t=>same(parts(t,zone),p));
  if(matches.length===0)throw Error('夏時間の切替により存在しない現地時刻です。別の時刻を選んでください。');
  if(matches.length!==1)throw Error('夏時間の切替で2回現れる現地時刻です。別の時刻を選んでください。');
  return new Date(matches[0]).toISOString();
 }
 function offsetLabel(instant,zone){const ms=new Date(instant).getTime(),minutes=Math.round((utc(parts(ms,zone))-Math.floor(ms/1000)*1000)/60000);return 'GMT'+(minutes>=0?'+':'−')+pad(Math.floor(Math.abs(minutes)/60))+':'+pad(Math.abs(minutes)%60);}
 function display(instant,zone){if(!instant)return '未設定';return localInput(instant,zone).replace('T',' ')+'（'+offsetLabel(instant,zone)+'）';}
 const api={parts,localInput,toUtc,offsetLabel,display};if(typeof module==='object'&&module.exports)module.exports=api;else root.RecruitingScheduleTime=api;
})(typeof window!=='undefined'?window:this);
