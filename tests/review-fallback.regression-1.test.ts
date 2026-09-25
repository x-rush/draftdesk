import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {runJob} from "../core/pipeline";
import {reviewSchema,type Artifact} from "../core/schema";
import {Store} from "../core/store";
import {topic,evidence} from "./fixtures";

// Regression: a missing reviewer note failed the whole paid research run even
// though a draft existed. It must survive as private, explicitly unreviewed work.
test("review without a note preserves the draft but never marks it ready",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-review-note-"));
 const db=new Store(dir);
 try{
  assert.equal(reviewSchema.safeParse({reviews:[{index:0,verdict:"pass",issues:[]}]}).success,true);
  db.put("config","main",{...db.config(),apiKey:"test-only"});
  for(const item of evidence)db.put("evidence",item.id,item);
  const job=db.enqueue("daily-editorial",evidence.map(item=>item.id))!;
  db.claim();
  let calls=0;
  await runJob(db,job,{structured:(async()=>{
   calls++;
   if(calls===1)return {clusters:[{label:"AI 更新",summary:"官方变化",evidenceIds:topic.evidenceIds,contradictions:[],missing:[]}],excluded:[]};
   if(calls===2)return {items:[topic],rejected:[]};
   return {reviews:[{index:0,verdict:"pass",issues:[]}]};
  }) as any});
  assert.equal(db.get<any>("jobs",job.id)?.state,"completed");
  const saved=db.list<Artifact>("artifacts")[0];
  assert.equal(saved.quality,"review");
  assert.equal(saved.visibility,"private");
  assert.ok(saved.issues.some(issue=>issue.includes("审稿未提供判断依据")));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("specific reviewer issues can serve as the review explanation when note is omitted",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-review-issue-"));
 const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only-no-network"});
  for(const item of evidence)db.put("evidence",item.id,item);
  const job=db.enqueue("daily-editorial",evidence.map(item=>item.id))!;
  let calls=0;
  await runJob(db,job,{structured:(async()=>{
   calls++;
   if(calls===1)return {clusters:[{label:"AI 更新",summary:"官方变化",evidenceIds:topic.evidenceIds,contradictions:[],missing:[]}],excluded:[]};
   if(calls===2)return {items:[topic],rejected:[]};
   return {reviews:[{index:0,verdict:"revise",issues:["缺少当前价格原文"]}]};
  }) as any});
  const saved=db.list<Artifact>("artifacts")[0];
  assert.equal(saved.quality,"review");
  assert.equal(saved.reviewNote,"缺少当前价格原文");
  assert.ok(!saved.issues.some(issue=>issue.includes("审稿未提供判断依据")));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
