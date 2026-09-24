import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

test("浏览器采集器在模型前剔除过期活动和不匹配关键词",async()=>{
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
 assert.equal(stored.draftdeskActivityRun.bundle.items.map((x:any)=>x.title).join(","),"AI视频创作激励");
});
