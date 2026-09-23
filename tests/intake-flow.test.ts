import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {Store} from "../core/store";
import {validateIntake} from "../core/intake-validation";
import {envelope,plan} from "./fixtures";
test("预检验证结构与引用，不把无效草稿当通过",()=>{
 const p=envelope();assert.equal(validateIntake(p).ok,true);
 const bad=structuredClone(p);bad.drafts[0].evidenceIds=["unknown-id"];assert.equal(validateIntake(bad).ok,false);
 assert.equal(validateIntake({}).ok,false);
});
test("收件任务关联幂等，只有失败/取消能明确重试，回执提供完整状态",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-intake-"));const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only"});db.put("plans",plan.id,plan);
  const receipt=db.intake(envelope(),"test");
  const first=db.enqueue(plan.id,[],undefined,receipt.id)!;
  assert.equal(db.enqueue(plan.id,[],undefined,receipt.id)?.id,first.id);
  db.patchJob(first.id,{state:"failed"});assert.equal(db.enqueue(plan.id,[],undefined,receipt.id)?.id,first.id);
  const retry=db.enqueue(plan.id,[],undefined,receipt.id,true)!;assert.notEqual(retry.id,first.id);
  assert.deepEqual(retry.evidenceIds,receipt.evidenceIds);db.patchJob(retry.id,{state:"completed"});
  assert.equal(db.enqueue(plan.id,[],undefined,receipt.id,true)?.id,retry.id);
  const row=db.snapshot().submissions.find(r=>r.id===receipt.id)!;assert.equal(row.jobs[0].state,"completed");assert.equal(row.jobs.length,2);
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
});
