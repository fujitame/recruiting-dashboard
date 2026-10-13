const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
const shared=fs.readFileSync('supabase/functions/_shared/followup-batch-gmail.ts','utf8');
const builder=shared.slice(shared.indexOf('function decodeBase64Url')).replace(/^export /gm,'');
const endpoint=fs.readFileSync('supabase/functions/recruiting-gmail-reply-send/index.ts','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default','globalThis.endpoint =');
async function run(options={}){
 const sent=[],labels=[];
 const contact={id:'contact',university_id:1,coach_email:'coach@example.com',coach_role:'head_coach',contact_status:options.status||'responded',gmail_thread_id:'thread'};
 const db={from:()=>{const q={select:()=>q,eq:()=>q,single:async()=>({data:contact,error:null})};return q;}};
 const c={crypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,encodeURIComponent,unescape,Response,URLSearchParams,console:{...console,warn:()=>{},error:()=>{}},Deno:{env:{get:k=>k==='GMAIL_ACCOUNT'?'fujiakihiro8@gmail.com':'fixture'}},withSupabase:(settings,handler)=>handler,syncRecruitingThreadLabels:async(...args)=>{if(options.labelFailure)throw new Error('fixture label error');labels.push(args);},fetch:async(url,init)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture'});
  if(url.endsWith('/messages/send')){sent.push(JSON.parse(init.body));return Response.json({id:'sent',threadId:'thread'});}
  if(url.includes('/messages/sent?')){const mime=Buffer.from(sent.at(-1).raw,'base64url').toString('utf8'),body=Buffer.from(mime.split('\r\n\r\n')[1].trim(),'base64').toString('utf8');return Response.json({id:'sent',payload:{mimeType:'text/plain',body:{data:Buffer.from(options.missingBody?'':body).toString('base64url')}}});}
  return Response.json({messages:[{internalDate:'1',payload:{headers:[{name:'From',value:options.otherSender?'other@example.com':'coach@example.com'},{name:'Message-ID',value:'<coach@example.com>'},{name:'References',value:'<older@example.com>'}]}}]});
 }};
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(builder+'\n'+endpoint),c);
 const body=options.empty?' ':'Thank you Coach,\n\n日本語 ⚽\n\nBest,\nAkihiro';
 const response=await c.endpoint.fetch(new Request('https://fixture',{method:'POST',body:JSON.stringify({contact_id:'contact',subject:'Reply 日本語',body})}),{supabase:db});
 return {response:await response.json(),status:response.status,sent,labels,body};
}
(async()=>{
 const r=await run();assert.equal(r.status,200,JSON.stringify(r.response));assert.equal(r.response.body_verified,true);assert.equal(r.sent.length,1);assert.equal(r.sent[0].threadId,'thread');
 const mime=Buffer.from(r.sent[0].raw,'base64url').toString('utf8'),at=mime.indexOf('\r\n\r\n');assert(at>0);
 assert.equal(Buffer.from(mime.slice(at+4).trim(),'base64').toString('utf8'),r.body);
 assert.match(mime,/In-Reply-To: <coach@example.com>/);assert.match(mime,/References: <older@example.com> <coach@example.com>/);
 assert.equal(r.labels[0][1],'Recruiting/Waiting Coach');
 for(const options of [{empty:true},{status:'contacted'},{otherSender:true}])assert.equal((await run(options)).sent.length,0);
 const failedLabel=await run({labelFailure:true});assert.equal(failedLabel.response.ok,true);assert.equal(failedLabel.sent.length,1);
 const missing=await run({missingBody:true});assert.equal(missing.response.ok,true);assert.equal(missing.response.body_verified,false);assert.equal(missing.sent.length,1);
 console.log('PASS: actual individual reply endpoint retains MIME separator, UTF-8 body, inbound threading, eligibility and successful-send handling after label failure. Gmail and auth adapter mocked.');
})().catch(error=>{console.error(error);process.exitCode=1});
