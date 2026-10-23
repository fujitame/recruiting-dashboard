const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
const shared=fs.readFileSync("supabase/functions/_shared/reapproach-draft.ts","utf8").replaceAll("export ",""),box={};
vm.runInNewContext(shared+";this.build=buildReapproachDraft;this.norm=normalizeResearch;this.plan=reapproachPlan;this.questions=SCHOOL_REAPPROACH_QUESTIONS",box);
const player={player_name:"Akihiro Fujikawa",current_school:"Harcum College",current_division:"NJCAA D1",expected_transfer:"Fall 2027",primary_position:"Wide Defender / Fullback",secondary_positions:"LM / LW",gpa:3.28,jersey_number:14,player_email:"athlete@example.com",highlight_video_1_id:"kG2G7fUz1SI"};
const outputs=[];
for(const id of Object.keys(box.questions).map(Number)){
 const research=[{id:100+id,fact_text:"[REAPPROACH_2026_11_COUNTS] Senior以上 16人／うちDF 4人。",confidence:"partial"}];
 const draft=box.build({school:{id,name:"Sample University"},contact:{coach_name:"Test Coach",contact_count:2,coach_response:""},player,research,updates:"New GPA 4.0 requires confirmation"});
 outputs.push(draft.body);
 assert(draft.body.includes(box.questions[id]));assert(draft.body.includes("3.28"));assert(!draft.body.includes("4.0"));assert(!draft.body.includes("16"));assert(!draft.body.includes("openings"));assert.equal(draft.research_used.length,0);assert(draft.checks_ja.some(x=>x.includes("New GPA")));
}
assert.equal(outputs.length,25);assert.equal(new Set(outputs).size,25);
const rows=[{id:1,fact_text:"[REAPPROACH_2026_11_COUNTS] Senior以上 10人／うちDF 4人。",confidence:"verified"},{id:2,fact_text:"[REAPPROACH_2026_11_side_play] verified fact",confidence:"verified"},{id:3,fact_text:"ordinary",confidence:"verified"}];
assert.deepEqual(Array.from(box.norm(rows).filter(x=>x.email_fact_allowed),x=>x.id),[2]);
const draft=box.build({school:{id:1,name:"UC Irvine"},contact:{coach_name:"Yossi Raz",contact_count:1},player,research:rows});
assert(draft.body.includes("Brady Treinen"));assert.deepEqual(Array.from(draft.research_used),[2]);assert.equal(box.plan(box.norm(rows)).vacancies_confirmed,false);
const noFact=box.build({school:{id:1,name:"UC Irvine"},contact:{coach_name:"Yossi Raz",contact_count:1},player,research:rows.map(x=>({...x,confidence:"partial"}))});
assert(!noFact.body.includes("Brady Treinen"));
const reply=box.build({school:{id:18,name:"Cal State San Marcos"},contact:{coach_name:"Ron Pulvers",contact_count:2,coach_response:"private content not to copy"},player,research:rows});
assert(reply.body.includes("earlier reply"));assert(!reply.body.includes("private content"));assert(reply.body.includes("athletic aid process"));
const ui=fs.readFileSync("index.html","utf8");assert(!ui.includes("invoke('recruiting-ai-reapproach-draft'"));assert(!ui.includes("messages/send"));assert(ui.includes("loadCrmSchoolReapproach(c)"));assert(ui.includes(shared.trim()));
const helper=ui.slice(ui.indexOf("function crmResearchUrl"),ui.indexOf("async function loadCrmSchoolReapproach"));
const safe={URL};vm.runInNewContext(helper+";this.safe=crmResearchUrl;this.text=crmResearchText",safe);
assert.equal(safe.safe("javascript:alert(1)"),"");assert.equal(safe.safe("https://example.edu/"),"https://example.edu/");
assert(safe.text("[REAPPROACH_2026_11_COUNTS] Test").startsWith("Test"));
console.log("25 school-specific drafts, confirmed-fact gating, count caveats, live player data, reply handling, notes, URL safety and separate draft-only UI passed");
