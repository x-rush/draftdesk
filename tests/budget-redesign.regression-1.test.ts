import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {runJob} from "../core/pipeline";
import {planSchema,reviewSchema,type Artifact,type Plan} from "../core/schema";
import {AppError,Store} from "../core/store";
import {defaultPlans} from "../core/defaults";
import {topic,evidence} from "./fixtures";

// 回归：研究流水线最坏需要 3 阶段 × 2 次模型调用 = 6 次；旧上限（4 次 / 200k token）
// 会在修复轮中途撞墙，把已付费的任务变成失败。

test("plan schema accepts worst-case budgets and still rejects runaway values",()=>{
 const base={...defaultPlans[0]};
 assert.equal(planSchema.safeParse({...base,maxModelCalls:8,maxTokens:400000}).success,true);
 assert.equal(planSchema.safeParse({...base,maxModelCalls:12,maxTokens:1000000}).success,true);
 assert.equal(planSchema.safeParse({...base,maxModelCalls:13}).success,false);
 assert.equal(planSchema.safeParse({...base,maxTokens:1000001}).success,false);
});

test("stored plans are migrated once to a budget that completes all stages",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-budget-migrate-"));
 try{
  const old:Plan={...defaultPlans[0],maxModelCalls:4,maxTokens:200000};
  {
   const db=new Store(dir);
   db.put("plans",old.id,{...old});
   // 清除一次性迁移标记，模拟升级前（旧预算 + 标记未写入）的存量库
   db.db.prepare("DELETE FROM documents WHERE collection='meta' AND id='job-budget-v2'").run();
   db.close();
  }
  const db=new Store(dir);
  try{
   const migrated=db.get<Plan>("plans",old.id)!;
   assert.equal(migrated.maxModelCalls,8);
   assert.equal(migrated.maxTokens,400000);
   // 幂等：再次打开不再变化
   const again=new Store(dir);
   try{assert.equal(again.get<Plan>("plans",old.id)!.maxModelCalls,8);}
   finally{again.close();}
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("review schema accepts an empty note instead of failing the contract",()=>{
 assert.equal(reviewSchema.safeParse({reviews:[{index:0,verdict:"pass",issues:[],note:""}]}).success,true);
 assert.equal(reviewSchema.safeParse({reviews:[{index:0,verdict:"pass",issues:[]}]}).success,true);
 assert.equal(reviewSchema.safeParse({reviews:[{index:0,verdict:"pass",issues:[],note:123}]}).success,false);
});

test("budget exhaustion at review keeps the paid drafts as private unreviewed artifacts",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-review-budget-"));
 const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only-no-network"});
  for(const item of evidence)db.put("evidence",item.id,item);
  const job=db.enqueue("daily-editorial",evidence.map(item=>item.id))!;
  db.claim();
  let calls=0;
  await runJob(db,job,{structured:(async()=>{
   calls++;
   if(calls===1)return {clusters:[{label:"AI 更新",summary:"官方变化",evidenceIds:topic.evidenceIds,contradictions:[],missing:[]}],excluded:[]};
   if(calls===2)return {items:[topic],rejected:[]};
   throw new AppError("任务达到模型调用或 token 预算上限；已有证据仍保留。");
  }) as any});
  const finished=db.get<any>("jobs",job.id)!;
  assert.equal(finished.state,"completed");
  assert.equal(finished.outcome,"produced");
  const saved=db.list<Artifact>("artifacts")[0];
  assert.equal(saved.quality,"review");
  assert.equal(saved.visibility,"private");
  assert.ok(saved.issues.some(issue=>issue.includes("缺少审稿结果")));
  assert.ok(saved.issues.some(issue=>issue.includes("预算")));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("non-budget review failures still fail the job instead of hiding them",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-review-contract-"));
 const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only-no-network"});
  for(const item of evidence)db.put("evidence",item.id,item);
  const job=db.enqueue("daily-editorial",evidence.map(item=>item.id))!;
  db.claim();
  let calls=0;
  await runJob(db,job,{structured:(async()=>{
   calls++;
   if(calls===1)return {clusters:[{label:"AI 更新",summary:"官方变化",evidenceIds:topic.evidenceIds,contradictions:[],missing:[]}],excluded:[]};
   if(calls===2)return {items:[topic],rejected:[]};
   throw new AppError("模型输出连续两次未满足数据合同：reviews.0.note。未将不完整结果入库。");
  }) as any});
  const finished=db.get<any>("jobs",job.id)!;
  assert.equal(finished.state,"failed");
  assert.ok(finished.error!.includes("数据合同"));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
