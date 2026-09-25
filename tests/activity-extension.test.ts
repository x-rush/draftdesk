import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

test("扩展按当前官方平台显示对应采集结果，避免下载其他平台的文件",async()=>{
 const elements:any={};
 for(const id of ["runStatus","downloadBatch","auto","keywords","maxPages","scan","read","save","status","candidates","title","url","text"])
  elements[id]={textContent:"",disabled:false,value:""};
 let current="https://creator.douyin.com/creator-micro/creative-guidance/calendar";
 let interval:()=>void=()=>{};
 const runs={抖音:{state:"completed",progress:"完成 2 条",bundle:{items:[1,2]}},哔哩哔哩:{state:"running",progress:"读取第 2 页"}};
 const chrome={tabs:{query:async()=>[{url:current}]},storage:{local:{get:async()=>({draftdeskActivityRuns:runs})}}};
 const code=readFileSync(new URL("../public/activity-collector/popup.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document:{getElementById:(id:string)=>elements[id]},URL,setInterval:(fn:()=>void)=>{interval=fn;}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.match(elements.runStatus.textContent,/抖音：完成 2 条/);
 assert.equal(elements.downloadBatch.disabled,false);
 current="https://www.bilibili.com/blackboard/activity-list.html";
 interval();await new Promise(resolve=>setTimeout(resolve,0));
 assert.match(elements.runStatus.textContent,/哔哩哔哩：读取第 2 页/);
 assert.equal(elements.downloadBatch.disabled,true);
 assert.equal(elements.auto.disabled,true);
});

test("扩展只读取当前小红书创作者页内匹配的官方规则 iframe",async()=>{
 let listener:any,calls=0;
 const expected="https://fe.xiaohongshu.com/ditto/vincent/event-123";
 const chrome={tabs:{onCreated:{addListener:()=>{}}},runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}},scripting:{executeScript:async()=>{calls++;return [{result:{url:"https://other.example/rules",text:"无关页面"}},{result:{url:expected,text:"活动规则："+"官方投稿规则与时间。".repeat(15)}}];}}};
 const code=readFileSync(new URL("../public/activity-collector/background.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,URL,Map,crypto,Date,setTimeout,clearTimeout,Error});
 const sender={tab:{id:3},url:"https://creator.xiaohongshu.com/new/events"};
 const response:any=await new Promise(resolve=>listener({type:"draftdesk:read-xhs-frame",url:expected},sender,resolve));
 assert.equal(response.ok,true);
 assert.equal(response.result.url,expected);
 assert.equal(calls,1);
 const blocked:any=await new Promise(resolve=>listener({type:"draftdesk:read-xhs-frame",url:"https://attacker.example/rules"},sender,resolve));
 assert.equal(blocked.ok,false);
 assert.equal(calls,1);
});
