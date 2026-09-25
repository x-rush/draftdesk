import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {activityBatchDecision} from "../core/activity-batch";

test("浏览器采集器保留排除项供核对，模型前剔除过期活动和不匹配关键词",async()=>{
 let dialog:any=null,listener:((message:any,sender:any,respond:(v:any)=>void)=>void)|undefined;
 const cards=[
  {textContent:"AI视频创作激励",text:"活动规则：2026年09月01日至2099年09月30日；创作者使用 AI 视频工具完成作品，标记指定话题并公开发布。",click(){dialog={innerText:this.text,querySelector:()=>({click(){dialog=null;}})};}},
  {textContent:"AI视频往年活动",text:"活动规则：2000年09月01日至2000年09月20日；创作者使用 AI 视频工具完成作品，标记指定话题并公开发布。",click(){dialog={innerText:this.text,querySelector:()=>({click(){dialog=null;}})};}},
  {textContent:"美食征稿",text:"活动规则：2026年09月01日至2099年09月30日；拍摄美食短片参加征稿，创作者必须使用对应话题并公开发布。",click(){dialog={innerText:this.text,querySelector:()=>({click(){dialog=null;}})};}},
 ];
 const stored:{draftdeskActivityRun?:any}={};
 const chrome={runtime:{onMessage:{addListener(fn:any){listener=fn;}},sendMessage:async()=>({})},storage:{local:{set:async(value:any)=>Object.assign(stored,value)}}};
 const document={body:{innerText:"2026年09月"},querySelector(selector:string){if(selector===".douyin-creator-common-calendar")return {innerText:"2026年09月"};if(selector==='[role="dialog"]')return dialog;return null;},querySelectorAll:()=>cards};
 const code=readFileSync(new URL("../public/activity-collector/auto.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document,location:{hostname:"creator.douyin.com",href:"https://creator.douyin.com/creator-micro/creative-guidance/calendar"},setTimeout,Date,URL,console});
 assert.ok(listener);
 listener!({type:"draftdesk:auto",config:{keywords:["AI视频"],maxPages:1,maxItems:20}},{},()=>{});
 for(let i=0;i<30 && stored.draftdeskActivityRun?.state!=="completed" && stored.draftdeskActivityRun?.state!=="failed";i++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(stored.draftdeskActivityRun?.state,"completed",stored.draftdeskActivityRun?.progress);
 const bundle=stored.draftdeskActivityRun.bundle;
 assert.equal(bundle.items.length,3);
 assert.equal(bundle.items.find((x:any)=>x.title==="AI视频往年活动")?.endsAt,"2000-09-20T15:59:59.000Z");
 assert.equal(activityBatchDecision(bundle.items[1],["AI视频"]).reason,"活动已过期");
 assert.equal(activityBatchDecision(bundle.items[2],["AI视频"]).reason,"未命中目标关键词");
});

test("B站采集读取浏览器已渲染卡片，不依赖空白服务端 HTML",async()=>{
 let listener:any;const stored:any={};
 const title="AI 视频创作者激励计划",url="https://www.bilibili.com/blackboard/era/abc.html";
 const anchor={textContent:title,getAttribute:()=>url,closest:()=>({querySelector:()=>({textContent:"【进行中】 2026-09-01 至 2099-09-30"})})};
 const chrome={runtime:{onMessage:{addListener(fn:any){listener=fn;}},sendMessage:async()=>({ok:true,result:{text:"活动规则：面向 AI 视频创作者，使用活动话题投稿视频，符合活动主题和公开发布要求后可参与创作激励。投稿时间与审核规则以官方页面为准。"}})},storage:{local:{set:async(value:any)=>Object.assign(stored,value)}}};
 const document={querySelectorAll:()=>[anchor],querySelector:()=>null};
 const code=readFileSync(new URL("../public/activity-collector/auto.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document,location:{hostname:"www.bilibili.com",origin:"https://www.bilibili.com"},setTimeout,Date,URL,console});
 listener({type:"draftdesk:auto",config:{keywords:["AI"],maxPages:1,maxItems:20}},{},()=>{});
 for(let i=0;i<30 && stored.draftdeskActivityRun?.state!=="completed" && stored.draftdeskActivityRun?.state!=="failed";i++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(stored.draftdeskActivityRun?.state,"completed",stored.draftdeskActivityRun?.progress);
 assert.equal(stored.draftdeskActivityRun.bundle.items[0].title,title);
 assert.equal(activityBatchDecision(stored.draftdeskActivityRun.bundle.items[0],["AI"]).eligible,true);
});

test("没有明确年份的小红书活动只作待核线索",async()=>{
 let listener:any;const stored:any={};
 const card={querySelector:(selector:string)=>({textContent:selector===".title"?"国风 vibecoding 小工具":selector===".desc"?"小工具征集":"09-14 至 09-30"}),click(){}};
 const chrome={runtime:{onMessage:{addListener(fn:any){listener=fn;}},sendMessage:async()=>({})},storage:{local:{set:async(value:any)=>Object.assign(stored,value)}}};
 const document={querySelectorAll:(selector:string)=>selector===".card-box"?[card]:[],querySelector:()=>null};
 const code=readFileSync(new URL("../public/activity-collector/auto.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document,location:{hostname:"creator.xiaohongshu.com",href:"https://creator.xiaohongshu.com/new/events"},setTimeout,Date,URL,console});
 listener({type:"draftdesk:auto",config:{keywords:["vibecoding"],maxPages:1,maxItems:20}},{},()=>{});
 for(let i=0;i<30 && stored.draftdeskActivityRun?.state!=="completed" && stored.draftdeskActivityRun?.state!=="failed";i++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(stored.draftdeskActivityRun?.state,"completed",stored.draftdeskActivityRun?.progress);
 assert.equal(stored.draftdeskActivityRun.bundle.items[0].endsAt,undefined);
 assert.equal(activityBatchDecision(stored.draftdeskActivityRun.bundle.items[0],["vibecoding"]).eligible,false);
});

test("抖音日历标题缺少年份时不使用电脑当前年份",async()=>{
 let listener:any,dialog:any=null;const stored:any={};
 const card={textContent:"AI视频活动",click(){dialog={innerText:"活动时间 09-01 至 09-30 AI视频创作激励活动，按活动话题投稿",querySelector:()=>({click(){dialog=null;}})};}};
 const chrome={runtime:{onMessage:{addListener(fn:any){listener=fn;}},sendMessage:async()=>({})},storage:{local:{set:async(value:any)=>Object.assign(stored,value)}}};
 const document={body:{innerText:"活动日历"},querySelector:(selector:string)=>selector===".douyin-creator-common-calendar"?{innerText:"活动日历"}:selector==='[role="dialog"]'?dialog:null,querySelectorAll:()=>[card]};
 const code=readFileSync(new URL("../public/activity-collector/auto.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document,location:{hostname:"creator.douyin.com",href:"https://creator.douyin.com/creator-micro/creative-guidance/calendar"},setTimeout,Date,URL,console});
 listener({type:"draftdesk:auto",config:{keywords:["AI视频"],maxPages:1,maxItems:20}},{},()=>{});
 for(let i=0;i<30 && stored.draftdeskActivityRun?.state!=="completed" && stored.draftdeskActivityRun?.state!=="failed";i++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(stored.draftdeskActivityRun?.state,"completed",stored.draftdeskActivityRun?.progress);
 assert.equal(stored.draftdeskActivityRun.bundle.items[0].endsAt,undefined);
});
