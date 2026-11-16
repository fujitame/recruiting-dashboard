// Gmail send pacing is enforced in Postgres; this controller never retries transport.
export function gmailResponseError(response, data, context='Gmail request failed') {
 const detail=data?.error;
 const error=new Error(context+': Gmail HTTP '+response.status+': '+(detail?.message||data?.error_description||String(detail||'Request rejected')));
 error.gmailStatus=Number(response.status);
 error.gmailReasons=(detail?.errors||[]).map(value=>String(value.reason||''));
 error.gmailRetryAfter=response.headers?.get?.('retry-after')||null;
 return error;
}
export function isGmailGlobalStop(error) {
 const status=Number(error?.gmailStatus);
 return [401,403,429].includes(status)||/rate.?limit|quota.?exceeded|daily.?limit|too many requests|user.?rate|mail sending|invalid_grant|oauth.*(?:failed|not configured)|gmail account mismatch/i.test(String(error?.message||error));
}
export async function runPacedCampaignBatch({gate,claim,deliver,sleep,now=Date.now,maxDeliveries=2,budgetMs=90000}) {
 const deadline=now()+budgetMs,results=[];
 for(let i=0;i<maxDeliveries;i++){
  if(now()>=deadline)break;
  let state=await gate();
  if(!state.allowed)return {deliveries:results,stopped:state.reason||'account_paused'};
  const wait=Math.max(0,Math.ceil(Number(state.wait_ms)||0));
  if(wait){
   if(now()+wait+25>=deadline)break;
   await sleep(wait+25);
   state=await gate();
   if(!state.allowed)return {deliveries:results,stopped:state.reason||'account_paused'};
  }
  const item=await claim();if(!item)break;
  const status=await deliver(item,deadline);results.push({id:item.id,status});
  if(status==='send_unknown'||status==='paused')return {deliveries:results,stopped:status};
 }
 return {deliveries:results};
}
