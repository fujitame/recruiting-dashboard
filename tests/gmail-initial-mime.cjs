const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
const shared=fs.readFileSync('supabase/functions/_shared/followup-batch-gmail.ts','utf8');
const helpers=shared.slice(shared.indexOf('function decodeBase64Url')).replace(/^export /gm,'');
const source=fs.readFileSync('supabase/functions/recruiting-gmail-initial-send/index.ts','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default','globalThis.endpoint =');
function sentPlain(mime){const content=mime.split('\r\n\r\n').slice(1).join('\r\n\r\n');const plain=/multipart\/alternative/.test(mime)?content.split('\r\n\r\n')[1].split('\r\n--')[0]:content;return Buffer.from(plain.trim(),'base64').toString('utf8');}
async function run(options={}){
 const sends=[],writes=[];
 const contact={id:'contact',owner_user_id:'owner',university_id:1,coach_email:'coach@example.com',contact_status:options.alreadySent?'contacted':'not_contacted',follow_up_count:0,contact_count:0};
 const db={from:table=>{let operation='select',payload;const q={select:()=>q,eq:()=>q,contains:()=>q,in:()=>q,limit:()=>q,update:p=>{operation='update';payload=p;return q;},insert:p=>{operation='insert';payload=p;return q;},single:async()=>{if(operation==='update'){writes.push({table,payload});return options.crmFailure?{data:null,error:{message:'fixture CRM failure'}}:{data:{...contact,...payload},error:null};}return {data:contact,error:null};},then:fn=>{writes.push({table,payload});return Promise.resolve({data:table==='recruiting_initial_email_jobs'?[]:null,error:null}).then(fn);}};return q;}};
 const c={prepareEmailTracking:async a=>({id:'tracking',plain:a.body,html:'<p>Tracked</p>'}),recordEmailTrackingResult:async()=>true,crypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,encodeURIComponent,unescape,Response,URLSearchParams,Date,console:{...console,warn:()=>{},error:()=>{}},Deno:{env:{get:k=>k==='GMAIL_ACCOUNT'?'fujiakihiro8@gmail.com':'fixture'}},withSupabase:(settings,handler)=>handler,syncContactThreadLabels:async()=>{if(options.labelFailure)throw new Error('fixture label failure');},fetch:async(url,init)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture'});
  if(url.endsWith('/messages/send')){sends.push(JSON.parse(init.body));return Response.json({id:'sent',threadId:'thread'});}
  const mime=Buffer.from(sends[0].raw,'base64url').toString('utf8'),body=sentPlain(mime);
  return Response.json({id:'sent',payload:{mimeType:'text/plain',body:{data:Buffer.from(options.missingBody?'':body).toString('base64url')}}});
 }};
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(helpers+'\n'+source),c);
 const body=options.empty?' ':'Dear Coach,\n\nMy profile.\nUTF-8確認 ⚽\n\nAkihiro';
 const r=await c.endpoint.fetch(new Request('https://fixture',{method:'POST',body:JSON.stringify({contact_id:'contact',subject:'Initial 日本語',body})}),{supabase:db});
 return {response:await r.json(),status:r.status,sends,writes,body};
}
(async()=>{
 const r=await run();assert.equal(r.status,200,JSON.stringify(r.response));assert.equal(r.response.body_verified,true);assert.equal(r.sends.length,1);
 const mime=Buffer.from(r.sends[0].raw,'base64url').toString('utf8');assert(!mime.includes('In-Reply-To:'));assert(!r.sends[0].threadId);
 assert.equal(sentPlain(mime),r.body);
 const update=r.writes.find(w=>w.table==='recruiting_contacts').payload;assert.equal(update.follow_up_count,0);assert.equal(update.contact_status,'contacted');assert.equal(update.auto_follow_up_enabled,true);
 const missing=await run({missingBody:true});assert.equal(missing.response.body_verified,false);assert.equal(missing.sends.length,1);assert.equal(missing.response.contact.auto_follow_up_enabled,false);assert.equal(missing.response.contact.follow_up_date,null);
 const recordFailure=await run({crmFailure:true});assert.equal(recordFailure.status,200);assert.equal(recordFailure.response.ok,false);assert.equal(recordFailure.response.sent,true);assert.equal(recordFailure.response.gmail_message_id,'sent');assert.equal(recordFailure.sends.length,1);
 for(const options of [{empty:true},{alreadySent:true}])assert.equal((await run(options)).sends.length,0);
 assert.equal((await run({labelFailure:true})).response.ok,true);
 console.log('PASS: actual initial endpoint MIME, UTF-8, body readback, stage 0, empty/already-sent refusal, no automatic Follow-up after unverified body, accepted-send response after CRM failure. Gmail/auth mocked.');
})().catch(error=>{console.error(error);process.exitCode=1});
