import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

test("扩展按当前官方平台显示对应采集结果，避免下载其他平台的文件",async()=>{
 const elements:any={};
 for(const id of ["pageState","platformPill","pageStatus","runStatus","downloadBatch","auto","keywords","maxPages","scan","read","save","status","candidates","title","url","text"])
  elements[id]={textContent:"",disabled:false,value:"",className:""};
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

test("创作者中心首页可直接发起打开活动页并采集",async()=>{
 const elements:any={};
 for(const id of ["pageState","platformPill","pageStatus","runStatus","downloadBatch","auto","keywords","maxPages","scan","read","save","status","candidates","title","url","text"])
  elements[id]={textContent:"",disabled:false,value:"",className:""};
 elements.keywords.value="AI,Vibe Coding";elements.maxPages.value="2";
 const sent:any[]=[];
 const chrome={tabs:{query:async()=>[{id:7,url:"https://creator.douyin.com/creator-micro/home"}]},storage:{local:{get:async()=>({draftdeskActivityRuns:{}})}},runtime:{sendMessage:async(message:any)=>{sent.push(message);return {ok:true};}}};
 const code=readFileSync(new URL("../public/activity-collector/popup.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,document:{getElementById:(id:string)=>elements[id]},URL,setInterval:()=>{}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.match(elements.auto.textContent,/打开抖音活动页并采集/);
 await elements.auto.onclick();
 assert.equal(sent[0].type,"draftdesk:start-collection");
 assert.equal(sent[0].tabId,7);
 assert.deepEqual([...sent[0].config.keywords],["AI","Vibe Coding"]);
 assert.match(elements.pageStatus.textContent,/创作者中心/);
});

test("后台从四个平台首页导航到官方活动页后才启动采集",async()=>{
 const cases:[string,string,string][]=[
  ["哔哩哔哩","https://member.bilibili.com/platform/home","https://www.bilibili.com/blackboard/activity-list.html?page=1"],
  ["抖音","https://creator.douyin.com/creator-micro/home","https://creator.douyin.com/creator-micro/creative-guidance/calendar"],
  ["快手","https://cp.kuaishou.com/home","https://cp.kuaishou.com/creative/activity-calendar"],
  ["小红书","https://creator.xiaohongshu.com/new/home","https://creator.xiaohongshu.com/new/events"],
 ];
 for(const [platform,home,target] of cases){
  let listener:any,url=home,injected=false,sent=false;
  const saved:any={};
  const chrome={
   tabs:{onCreated:{addListener:()=>{}},get:async()=>({url,status:"complete"}),update:async(_id:number,options:any)=>{url=options.url;return {url};},sendMessage:async()=>{sent=true;return {ok:true};}},
   storage:{local:{get:async()=>saved,set:async(value:any)=>Object.assign(saved,value)}},
   scripting:{executeScript:async(options:any)=>{if(options.files){injected=true;return [];}return [{result:true}];}},
   runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}},
  };
  const code=readFileSync(new URL("../public/activity-collector/background.js",import.meta.url),"utf8");
  runInNewContext(code,{chrome,URL,Map,crypto,Date,setTimeout:(fn:any)=>setTimeout(fn,0),clearTimeout,Error,Number});
  const response:any=await new Promise(resolve=>listener({type:"draftdesk:start-collection",tabId:8,platform,config:{keywords:["AI"],maxPages:1,maxItems:10}},{},resolve));
  assert.equal(response.ok,true,`${platform}: ${response.error}`);
  assert.equal(url,target);
  assert.equal(injected,true);
  assert.equal(sent,true);
  assert.equal(saved.draftdeskActivityRuns[platform].state,"running");
 }
});

test("跳转到登录页时明确提示重新登录且不会读取其他页面",async()=>{
 let listener:any,url="https://creator.xiaohongshu.com/new/home",injected=false;
 const saved:any={};
 const chrome={tabs:{onCreated:{addListener:()=>{}},get:async()=>({url,status:"complete"}),update:async()=>{url="https://creator.xiaohongshu.com/login";return {url};}},storage:{local:{get:async()=>saved,set:async(value:any)=>Object.assign(saved,value)}},scripting:{executeScript:async()=>{injected=true;return [{result:true}];}},runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}}};
 const code=readFileSync(new URL("../public/activity-collector/background.js",import.meta.url),"utf8");
 runInNewContext(code,{chrome,URL,Map,crypto,Date,setTimeout:(fn:any)=>setTimeout(fn,0),clearTimeout,Error,Number});
 const response:any=await new Promise(resolve=>listener({type:"draftdesk:start-collection",tabId:8,platform:"小红书",config:{keywords:["AI"],maxPages:1,maxItems:10}},{},resolve));
 assert.equal(response.ok,false);
 assert.match(response.error,/登录/);
 assert.equal(saved.draftdeskActivityRuns.小红书.state,"failed");
 assert.equal(injected,false);
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
