import test from "node:test";
import assert from "node:assert/strict";
import {matchesResearchTerm,relevanceReason} from "../core/discovery";
import {defaultPlans} from "../core/defaults";
import type {EvidenceInput} from "../core/schema";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Store} from "../core/store";
import type {DiscoveryRecord} from "../core/discovery";

const plan=defaultPlans.find(p=>p.id==="trend-radar")!;
const item=(title:string):EvidenceInput=>({title,url:"https://www.douyin.com/hot/42",excerpt:title,collectedAt:new Date().toISOString(),sourceType:"trend",region:"CN",language:"zh",contentLevel:"headline"});

test("相近表达进入同一研究方向，英文 AI 不误命中普通单词",()=>{
 assert.equal(matchesResearchTerm("一个氛围编程实测", "Vibe Coding"),true);
 assert.equal(matchesResearchTerm("VibeCoding for creators", "Vibe Coding"),true);
 assert.equal(matchesResearchTerm("文生视频制作", "AI视频"),true);
 assert.equal(matchesResearchTerm("Chair design", "AI"),false);
 assert.equal(matchesResearchTerm("AI 创作工具", "AI"),true);
});

test("筛选理由区分未命中、排除词与通过，供线索池回看",()=>{
 assert.equal(relevanceReason(item("氛围编程活动"),plan),null);
 assert.equal(relevanceReason(item("普通娱乐节目"),plan),"未命中内容方向词");
 assert.equal(relevanceReason(item("AI 日常随笔"),{...plan,keywords:["大模型"]}),"未命中热词关键词");
 assert.equal(relevanceReason(item("AI 股价预测"),{...plan,excludeKeywords:["股价"]}),"命中排除词");
});

test("线索覆盖只显示保留期内且与指定任务对应的记录",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-discovery-"));
 const db=new Store(dir);
 try{
  const record=(jobId:string,at:string):DiscoveryRecord=>({jobId,at,planName:"研究",sources:[],candidates:[],limit:5});
  db.put("discovery","old",record("old",new Date(Date.now()-15*86400000).toISOString()));
  db.put("discovery","fresh",record("fresh",new Date().toISOString()));
  assert.equal((db.snapshot() as any).discovery.length,1);
  assert.equal((db.snapshot(new URLSearchParams("page=1&jobId=fresh")) as any).discovery.jobId,"fresh");
  assert.equal((db.snapshot(new URLSearchParams("page=1&jobId=old")) as any).discovery,null);
  assert.equal((db.snapshot(new URLSearchParams("page=1&jobId=unknown")) as any).discovery,null);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
