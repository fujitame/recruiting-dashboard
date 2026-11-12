const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),{stripTypeScriptTypes}=require('node:module');
function mock({stage='initial',reply=false,laterOwn=false,closed=false,newLabel=false}={}){
 const calls=[],account='sender@example.edu',headers=from=>[{name:'From',value:from}];
 const messages=[{id:'delivery-mail',internalDate:'100',payload:{headers:headers(account)}}];if(reply)messages.push({id:'reply',internalDate:'200',payload:{headers:headers('coach@example.edu')}});if(laterOwn)messages.push({id:'human',internalDate:'300',payload:{headers:headers(account)}});
 const labels=['Recruiting','Recruiting/Waiting Coach','Recruiting/Needs Reply','Recruiting/Follow-up Due','Recruiting/No Response','Recruiting/Closed','Personal label','Recruiting/Campaigns/old_activity',...(!newLabel?['Recruiting/Campaigns/new_activity']:[])].map((name,i)=>({name,id:'L'+i}));
 const ctx={console,Deno:{env:{get:key=>key==='GMAIL_ACCOUNT'?account:'configured'}},GMAIL_ACCOUNT:account,emailAddress:s=>s.toLowerCase(),getHeader:(hs,n)=>hs.find(h=>h.name===n)?.value||'',gmailGetThread:async()=>({messages}),threadReplyFrom:()=>false};vm.createContext(ctx);
 vm.runInContext(fs.readFileSync('supabase/functions/_shared/campaign-reply-attribution.js','utf8').replace(/^export /mg,''),ctx);
 const src=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/recruiting-gmail-labels.ts','utf8')).replace(/^import [\s\S]*?;\s*$/mg,'').replace(/^export /mg,'');vm.runInContext(src,ctx);
 ctx.googleAccessToken=async()=> 'token';ctx.gmailRequest=async(path,token,init={})=>{calls.push({path,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});if(path==='labels'&&!init.method)return {labels};if(path==='labels')return {id:'new-campaign-label'};return {};};
 const db={from(table){const q={select(){return this},eq(){return this},in(){return this},order(){return this},limit(){return this},single:async()=>({data:{campaign_key:'new_activity'}}),then(fn){return Promise.resolve({data:table==='recruiting_campaign_deliveries'?[{stage,gmail_message_id:'delivery-mail'}]:[{contact_status:closed?'closed':'contacted',follow_up_count:2}]}).then(fn)}};return q;}};
 return {ctx,db,calls,labels,delivery:{id:'delivery',owner_user_id:'owner',campaign_id:'new',status:'sent',stage,contact_ids:['hc','ac'],gmail_message_id:'delivery-mail',gmail_thread_id:'thread'}};
}
(async()=>{
 for(const [opts,expected] of [[{},'Waiting Coach'],[{stage:'follow_up_2'},'No Response'],[{stage:'follow_up_2',reply:true},'Needs Reply'],[{stage:'follow_up_2',reply:true,laterOwn:true},'Waiting Coach'],[{closed:true},'Closed']]){
  const m=mock(opts);assert.equal(await m.ctx.syncCampaignDeliveryLabels(m.db,m.delivery),'Recruiting/'+expected);
  const message=m.calls.find(c=>c.path==='messages/delivery-mail/modify');assert.deepEqual(message.body.removeLabelIds,[]);assert.equal(message.body.addLabelIds.length,1);
  const thread=m.calls.find(c=>c.path==='threads/thread/modify');const protectedIds=m.labels.filter(l=>l.name==='Personal label'||l.name.includes('/Campaigns/')).map(l=>l.id);assert.ok(protectedIds.every(id=>!thread.body.removeLabelIds.includes(id)),'Unrelated and historical campaign labels must be preserved');
 }
 const m=mock({newLabel:true});await m.ctx.syncCampaignDeliveryLabels(m.db,m.delivery);assert.equal(m.calls.filter(c=>c.method==='POST'&&c.path==='labels').length,1);assert.ok(m.calls.every(c=>!c.path.includes('/send')));
 console.log('PASS: current-campaign label only on its message; unrelated/history labels retained; live reply overrides FU2; later human reply restores Waiting; old FU count ignored; label-only operations never send email');
})().catch(e=>{console.error(e);process.exitCode=1});
