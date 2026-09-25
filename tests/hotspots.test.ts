import test from "node:test";
import assert from "node:assert/strict";
import {hotspotFeed} from "../core/hotspots";
import type {DiscoveryRecord} from "../core/discovery";
import {Store} from "../core/store";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

const at="2026-09-25T01:00:00.000Z";
const record=(jobId:string,candidates:DiscoveryRecord["candidates"]):DiscoveryRecord=>({jobId,at,planName:jobId,mode:"analysis",limit:10,sources:[],candidates});
test("热点列表合并重复链接、保留被筛除条目，并在筛选后分页",()=>{
 const records=[record("资讯",[{url:"https://example.com/a?utm_source=x",title:"AI 视频新工具",sourceId:"s1",sourceName:"平台榜",status:"filtered",reason:"未命中策略",observedAt:"2026-09-25T00:00:00Z"},{url:"https://example.com/b",title:"Vibe Coding 活动",sourceId:"s2",sourceName:"创作者榜",status:"watch",reason:"待观察",observedAt:at}]),record("热词",[{url:"https://example.com/a",title:"AI 视频新工具",sourceId:"s1",sourceName:"平台榜",status:"selected",reason:"进入分析",observedAt:at}])];
 const all=hotspotFeed(records,new URLSearchParams(),1);
 assert.equal(all.total,2);assert.equal(all.pages,2);assert.equal(all.items[0].observations,2);assert.equal(all.items[0].status,"selected");
 assert.equal(hotspotFeed(records,new URLSearchParams("hotspotStatus=filtered")).total,0);
 assert.equal(hotspotFeed(records,new URLSearchParams("hotspotSource=s2&hotspotQ=Vibe")).total,1);
 assert.equal(hotspotFeed(records,new URLSearchParams("hotspotPage=2"),1).items.length,1);
});
test("独立热点快照进入热点列表，不覆盖每日发现最近一次研究",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-hotspots-")),db=new Store(dir);
 try{
  const research=record("研究",[{url:"https://example.com/ai",title:"AI 实测",sourceId:"s1",sourceName:"平台榜",status:"selected",reason:"已入模",observedAt:new Date().toISOString()}]);
  research.at=new Date(Date.now()-60000).toISOString();
  const snapshot=record("快照",[{url:"https://example.com/other",title:"其他热点",sourceId:"s1",sourceName:"平台榜",status:"watch",reason:"原始热点",observedAt:new Date().toISOString()}]);
  snapshot.at=new Date().toISOString();snapshot.mode="hotspot";
  db.put("discovery",research.jobId,research);db.put("discovery",snapshot.jobId,snapshot);
  const home=db.snapshot(new URLSearchParams("page=1&view=discover")) as any;
  const feed=db.snapshot(new URLSearchParams("page=1&view=hotspots")) as any;
  assert.equal(home.discovery.jobId,"研究");assert.equal(feed.hotspots.total,2);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test("后续原始快照不抹掉入模状态，失败来源仍可被筛选",()=>{
 const selected=record("研究",[{url:"https://example.com/item",title:"AI 工具",sourceId:"original",sourceName:"原平台",status:"selected",reason:"进入分析",observedAt:"2026-09-25T00:00:00Z"}]);
 const snapshot=record("快照",[{url:"https://example.com/item",title:"AI 工具",sourceId:"mirror",sourceName:"聚合榜",status:"watch",reason:"原始热点",observedAt:"2026-09-25T01:00:00Z"}]);
 snapshot.sources=[{sourceId:"mirror",sourceName:"聚合榜",status:"failed",raw:0,matched:0,selected:0,error:"上游超时"}];
 const feed=hotspotFeed([snapshot,selected],new URLSearchParams("hotspotSource=original&hotspotStatus=selected"));
 assert.equal(feed.total,1);assert.equal(feed.items[0].reason,"进入分析");
 assert.deepEqual(feed.items[0].sourceIds,["mirror","original"]);
 assert.equal(feed.sourceHealth[0].error,"上游超时");
});
