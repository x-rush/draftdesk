import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Store} from "../core/store";
import {topic} from "./fixtures";
test("分页覆盖全部记录、筛选先于分页、关联结果和全局状态不丢失",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-pages-")); const db=new Store(dir);
 try {
  for(let i=0;i<65;i++){
   db.put("artifacts",`a${i}`,{...topic,id:`a${i}`,title:`选题${i}`,summary:i===0?"唯一关键词":"摘要",quality:"ready",issues:[],saved:i===0,archived:false,jobId:`j${i}`});
   db.put("jobs",`j${i}`,{id:`j${i}`,state:i===0?"running":"completed",planId:`p${i}`,receiptId:`r${i}`,evidenceIds:[]});
   db.put("receipts",`r${i}`,{id:`r${i}`,evidenceIds:[],artifactIds:[`a${i}`]});
  }
  const page=(q:string)=>db.snapshot(new URLSearchParams("page=1&quality=all&"+q)) as any;
  const first=page("");assert.equal(first.artifacts.length,20);assert.equal(first.pagination.artifacts.total,65);
  const params=new URLSearchParams("page=4&jobsPage=4&receiptsPage=4&quality=all");
  const fourth=db.snapshot(params) as any;
  assert.equal(fourth.artifacts.length,5);assert.equal(fourth.jobs.length,5);assert.equal(fourth.submissions.length,5);
  assert.equal(new Set([...first.artifacts,...fourth.artifacts].map(a=>a.id)).size,25);
  assert.equal(first.stats.running,1);assert.ok(first.stats.activePlanIds.includes("p0"));
  assert.equal(page("q=唯一关键词").artifacts[0].id,"a0");assert.equal(page("view=library").pagination.artifacts.total,1);
  assert.equal(page("q=不存在").pagination.artifacts.pages,1);assert.equal(page("q=不存在").artifacts.length,0);
  const clamped=db.snapshot(new URLSearchParams("page=999&pageSize=20")) as any;assert.equal(clamped.pagination.artifacts.page,4);
  assert.equal(page("pageSize=0.5").pagination.artifacts.pageSize,20);
  assert.equal(page("pageSize=1000").pagination.artifacts.pageSize,100);
  const receipt=page("receiptsPage=4").submissions.find((r:any)=>r.id==="r0");assert.equal(receipt.jobs[0].id,"j0");assert.equal(receipt.artifacts[0].id,"a0");
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
