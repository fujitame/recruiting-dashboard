const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),{stripTypeScriptTypes}=require('node:module');
const owner='47e7c1a9-a806-4f65-b5ed-2b9b124ef337';
(async()=>{
 for(const slug of ['recruiting-gmail-initial-send','recruiting-gmail-followup-send','recruiting-gmail-followup-batch-prepare','recruiting-gmail-followup-batch-schedule']){
  let network=0,writes=0;
  const contact={id:'coach',owner_user_id:owner,university_id:1,coach_email:'coach@example.edu',contact_status:'not_contacted',follow_up_count:0};
  const q={select(){return this},eq(){return this},contains(){return this},in(){return this},limit(){return this},single:async()=>({data:contact}),then:fn=>Promise.resolve({data:[]}).then(fn),insert(){writes++;throw Error('No legacy writes expected')},update(){writes++;throw Error('No legacy writes expected')}};
  const ctx={console,Response,Request,Date,Deno:{env:{get:()=> 'configured'}},withSupabase:(_options,fn)=>fn,batchMode:()=> 'production',fetch:async()=>{network++;throw Error('No Gmail request expected')},batchJson:(data,status=200)=>new Response(JSON.stringify(data),{status}),json:(data,status=200)=>new Response(JSON.stringify(data),{status})};
  vm.createContext(ctx);const src=stripTypeScriptTypes(fs.readFileSync('supabase/functions/'+slug+'/index.ts','utf8')).replace(/^import [\s\S]*?;\s*$/mg,'').replace(/^export default /mg,'const endpoint=').replace(/^export /mg,'');vm.runInContext(src,ctx);
  const handler=vm.runInContext('endpoint.fetch',ctx);
  const result=await handler(new Request('https://example.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contact_id:'coach',subject:'Subject',body:'Body',follow_up_number:1,test_mode:false})}),{supabase:{from:()=>q},jwtClaims:{sub:owner},userClaims:{sub:owner}});
  assert.equal(result.status,409,slug);assert.match((await result.json()).error,/活動状況・送信準備/);assert.equal(network,0);assert.equal(writes,0);
 }
 console.log('PASS: all four legacy production entrypoints redirect before Gmail or reservation writes; direct DB production scheduling separately blocked by migration');
})().catch(e=>{console.error(e);process.exitCode=1});
