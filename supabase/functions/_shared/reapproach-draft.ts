export function normalizeResearch(rows) {
 return (rows||[]).filter(r=>String(r.fact_text||"").startsWith("[REAPPROACH_2026_11")).map(r=>({
  id:Number(r.id),fact:String(r.fact_text||"").slice(0,4000),notes:String(r.personalization_note||"").slice(0,5000),
  source_url:String(r.source_url||""),confidence:r.confidence,checked_at:r.verified_at,
  email_fact_allowed:r.confidence==="verified"&&!String(r.fact_text).includes("_COUNTS]")
 }));
}
export function reapproachPlan(research) {
 const counts=research.find(r=>r.fact.includes("_COUNTS]"));
 const match=counts?.fact.match(/Senior以上\s*(\d+)人／うちDF\s*(\d+)人/);
 const seniors=match?Number(match[1]):null,defenders=match?Number(match[2]):null;
 return {reported_seniors:seniors,reported_senior_defenders:defenders,
  counts_are_unverified_planning_data:true,vacancies_confirmed:false,
  focus:research.some(r=>r.fact.includes("coach_reply_followthrough"))?"Continue the actual coach exchange: film evaluation, desired role and confirmed financial requirements.":
   research.some(r=>r.fact.includes("reapproach_connection"))?"Use the historical evaluation only within its original scope, then ask about current Fall 2027 wide roles.":
   defenders===0?"Ask about evaluation criteria, competition and development/entry route for wide players without inferring vacancies or no opportunity.":
   defenders>=3?"Ask what wide-defender/fullback/wing-back qualities are sought for Fall 2027 without asserting departures or available spots.":
   "Ask about the specific role and evaluation process for a wide defender who can also play left midfield."};
}
export const SCHOOL_REAPPROACH_QUESTIONS={"1":"How would you evaluate a fullback's attacking support and crossing alongside his defensive responsibilities for Fall 2027?","2":"What would you want to see from a transfer wide defender in ball circulation, decision-making under pressure and one-on-one defending?","3":"Which defensive and build-up qualities would you prioritize when evaluating a junior-college transfer for a wide role?","4":"How would you assess a wide defender who can also contribute on the left side of midfield within your Fall 2027 plans?","5":"What would be the appropriate route for a junior-college fullback to be evaluated for your Fall 2027 recruiting class?","6":"What responsibilities would a transfer fullback need to demonstrate in defensive organization, pressing and support of the attack?","7":"What would you need to see from my junior-college film to evaluate my readiness for your wide defensive roles?","13":"How would you assess a transfer wide player's positional discipline and ability to handle the physical demands of your program?","14":"When reviewing a defender, which qualities help you distinguish a fit for a wide role from one for a central role?","16":"How could I best demonstrate my suitability for a wide defensive role, and what would be the next step in your transfer evaluation process?","17":"Which defensive qualities and wide attacking actions would you prioritize when reviewing a transfer fullback's film?","18":"Could you share your assessment of my film and the role you would evaluate me for, and clarify the athletic aid process and financial information you would need?","52":"What level of physical and tactical readiness would you expect from a transfer fullback seeking to compete in your program?","107":"How would you evaluate a fullback's ability to deliver from wide areas while maintaining his defensive positioning?","108":"Would you be willing to evaluate my film specifically for fullback or wing-back responsibilities, including one-on-one defending and support in wide areas?","109":"Which qualities would help a transfer wide defender contribute to your team, and would left-midfield versatility be relevant to your evaluation?","110":"What development priorities would you set for a junior-college player aiming to contribute on both sides of the ball in a wide role?","111":"Would the ability to cover both outside back and midfield be relevant to your Fall 2027 evaluation, and what would you want to see on film?","112":"How would you evaluate a wide defender separately from a centre back, and what would demonstrate readiness to contribute in Fall 2027?","115":"How are you evaluating transfer players for wide defensive roles for Fall 2027, and what should I confirm about the academic transfer process?","119":"Would versatility between fullback and left midfield be useful in your evaluation, and which qualities would you want my film to demonstrate?","121":"What would be the best evaluation and development route for a transfer seeking to compete for a wide defensive or midfield role?","122":"Would you evaluate me primarily as a fullback, wing-back or left midfielder, and which match actions would help you make that assessment?","123":"How would you weigh defensive reliability against overlapping support and crossing when evaluating a transfer fullback?","126":"Which qualities would you prioritize in a wide defender's transition defending and support of play down the flank?"};
export function buildReapproachDraft({school,contact,player,research,updates=""}){
 const rows=normalizeResearch(research),plan=reapproachPlan(rows);
 if(!rows.length)throw new Error("学校別の再アプローチResearchが未登録です。");
 if(!player?.player_name||!player?.current_school)throw new Error("選手マスターを確認してください。");
 const name=String(contact.coach_name||"Coach").replace(/\\/g,"").trim().split(/\s+/).pop();
 const question=SCHOOL_REAPPROACH_QUESTIONS[school.id]||plan.focus;
 const hasReply=Boolean(String(contact.coach_response||"").trim()),hasContact=Number(contact.contact_count||0)>0;
 const opening=hasReply?"Thank you for your earlier reply. I would like to continue our conversation about transferring to "+school.name+" for "+player.expected_transfer+".":
  hasContact?"I am getting back in touch about transferring to "+school.name+" for "+player.expected_transfer+".":
  "My name is "+player.player_name+", a Japanese student-athlete at "+player.current_school+". I am interested in transferring to "+school.name+" for "+player.expected_transfer+".";
 const examples=[
 {tag:"_side_play]",school:1,text:"Your match report against San Diego described Brady Treinen attacking from the left and delivering a cross, which caught my attention as a wide player."},
 {tag:"_side_play]",school:107,text:"I noticed the match report describing Ty Kerns delivering a cross from the right against Cal State Dominguez Hills, which interested me as a fullback."},
 {tag:"_outside_back_kinoshita]",school:111,text:"Kaz Kinoshita's official biography describes experience in both midfield and outside-back roles, which stood out to me as a player comfortable in wide positions."}
 ];
 const used=[],connections=[];
 for(const x of examples){const fact=rows.find(r=>r.email_fact_allowed&&r.fact.includes(x.tag)&&Number(school.id)===x.school);if(fact){connections.push(x.text);used.push(fact.id);}}
 const overview="I currently play at "+player.current_school+" ("+player.current_division+"). My primary position is "+player.primary_position+(player.secondary_positions?", and I can also play "+player.secondary_positions:"")+".";
 const gpa=player.gpa!=null?" My current recorded GPA is "+player.gpa+".":"";
 const body=["Dear Coach "+name+",",opening,overview+gpa,...connections,question,"I would appreciate your review of my profile and guidance on the appropriate next step. Thank you for your time.",
 "Recruiting profile and resume: https://fujitame.github.io/profile/"];
 const video=String(player.highlight_video_1_id||"");if(/^[A-Za-z0-9_-]{11}$/.test(video))body.push("Highlights: https://www.youtube.com/watch?v="+video);
 body.push("Best regards,\n"+player.player_name+"\n"+player.current_school+" Men's Soccer #"+player.jersey_number+"\n"+player.player_email);
 const checks=["11月の送信前に公式Roster・残存資格・既存下級生・加入予定を再確認。","Senior／DF／Senior Day人数を卒業・募集・奨学金の空き人数に換算しない。","監督の最新のメールと依頼事項を確認し、今回の件名・文面・送信方法を見直す。","GPA・役割・映像・編入時期が選手マスターの最新情報と一致するか確認。"];
 if(hasReply)checks.push("返信原文を再読し、未回答の質問・未提出の資料があれば先に対応する。");
 if(String(updates).trim())checks.push("入力した新情報は確認待ちとして保持しています。裏付けを確認し、必要な内容を本文へ追記する："+String(updates).trim());
 if(Number(school.id)===18)checks.push("予算確認の返信を奨学金提示と同一視せず、役割・映像評価・費用条件を具体化する。");
 if(Number(school.id)===2)checks.push("Chris Volkの既存評価は原文と範囲を再確認してから必要に応じて追記する。");
 return {subject:player.expected_transfer+" Transfer — "+player.player_name+" | "+school.name,
 body:body.join("\n\n"),school_focus_ja:used.length?"確認済みの学校別具体例と、役割を確かめる質問を組み合わせました。":"学年集計を内部の検討材料にし、この学校向けの役割・評価基準の質問を用意しました。",
 rationale_ja:"提供集計：Senior以上 "+(plan.reported_seniors??"未確認")+"人／うちDF "+(plan.reported_senior_defenders??"未確認")+"人。募集枠は未確認です。",
 checks_ja:checks,research_used:used,draft_only:true};
}
