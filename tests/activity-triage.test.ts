import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Store} from "../core/store";
import {triageActivityBatches} from "../core/activity-triage";

test("原始活动包长期保留，AI 初筛只整理相关线索且重复请求不重复计费",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-triage-")),db=new Store(dir);
 try{
  const item={platform:"小红书",title:"国风小工具，点开直接玩！",url:"https://fe.xiaohongshu.com/ditto/vincent/example",text:"国风vibecoding 活动时间 09-14 至 09-30",dateText:"09-14 至 09-30",completeness:"summary",capturedAt:"2026-09-25T17:55:17Z"};
  const other={...item,title:"美食征集",text:"本周美食分享",url:"https://creator.xiaohongshu.com/new/events"};
  const bundle={schemaVersion:"draftdesk.activity-batch.v1",platform:"小红书",keywords:["vibecoding"],items:[item,other],warnings:[]};
  db.put("activity-batches","batch-1",{id:"batch-1",receivedAt:"2026-09-25T18:00:00Z",bundle});
  let calls=0;
  const request=(async(_db:Store,messages:any)=>{
   calls++;
   const input=JSON.parse(messages[1].content);
   assert.equal(input.items.length,1);
   assert.equal(input.items[0].ref,"item_1");
   return {text:JSON.stringify({items:[{ref:"item_1",relevance:"high",reason:"与用户的 Vibe Coding 创作方向吻合",missing:["官方规则正文和年份"],directions:[{title:"国风工具制作过程",angle:"记录从设计到实现的过程",verify:"核对活动征稿范围、期限和参与资格"}]}]}),usage:321,reservation:500};
  }) as any;
  const first=await triageActivityBatches(db,["batch-1"],["vibecoding"],new AbortController().signal,request);
  assert.equal(first.selectedCount,1);
  assert.equal(first.items[0].url,item.url);
  assert.equal(first.items[0].dateText,item.dateText);
  assert.match(first.items[0].reason,/原始摘录包含「vibecoding」/);
  assert.ok(first.items[0].missing.some(x=>x.includes("截止年份")));
  assert.ok(first.items[0].missing.some(x=>x.includes("官方活动规则正文")));
  assert.equal(db.get<any>("activity-batches","batch-1").bundle.items.length,2);
  assert.equal((await triageActivityBatches(db,["batch-1"],["vibecoding"],new AbortController().signal,request)).cached,true);
  assert.equal(calls,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("AI 初筛不得引用采集包以外的条目",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-triage-invalid-")),db=new Store(dir);
 try{
  db.put("activity-batches","batch-1",{id:"batch-1",receivedAt:"2026-09-25T18:00:00Z",bundle:{schemaVersion:"draftdesk.activity-batch.v1",platform:"小红书",keywords:["AI"],items:[{platform:"小红书",title:"AI 创作活动",url:"https://creator.xiaohongshu.com/new/events",text:"AI创作活动",dateText:"09-14 至 09-30",completeness:"summary",capturedAt:"2026-09-25T17:55:17Z"}],warnings:[]}});
  const request=(async()=>({text:JSON.stringify({items:[{ref:"invented",relevance:"high",reason:"没有依据的活动",missing:["官方规则"],directions:[]}]}),usage:10,reservation:100})) as any;
  await assert.rejects(()=>triageActivityBatches(db,["batch-1"],["AI"],new AbortController().signal,request),/没有逐条对应/);
  assert.equal(db.list("activity-triage").length,0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
