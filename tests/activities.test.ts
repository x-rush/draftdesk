import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import path from "node:path";
import {structured} from "../core/model";
import {runJob} from "../core/pipeline";
import {Store} from "../core/store";import {artifactSchema,researchBatchSchema,planSchema} from "../core/schema";
import {activityStatus,activityIssues,type Activity} from "../core/activities";
import {qualityIssues} from "../core/quality";
import {activitySourceType,searchWeb} from "../core/sources";
import {queryPlan} from "../core/research-policy";import {defaultPlans} from "../core/defaults";
import {topic,evidence} from "./fixtures";
export const activity:Activity={...topic,kind:"activity",title:"AI工作流创作挑战",details:{platform:"哔哩哔哩",activityUrl:evidence[0].url,startsAt:"2026-09-01T00:00:00+08:00",endsAt:"2026-09-30T23:59:59+08:00",dateText:"2026年9月1日至9月30日征稿",dateQuote:"2026年9月1日至9月30日征稿",access:"public",eligibility:"面向所有原创创作者",rewards:"优秀作品获得流量推荐，不保证获得",requirements:["原创AI工作流教程"],fit:"suitable",fitReason:"适合独立开发与工作流教程",directions:[1,2,3].map(i=>({title:`内容方向${i}`,angle:"用具体任务比较改造前后的步骤",format:"录屏教程",outline:["说明问题","展示流程与限制"],ruleFit:"原创教程符合主题",effort:"需要录屏与验证时间"}))}};
test("活动合同强制3–5个方向并限制研究输出类型",()=>{assert.ok(artifactSchema.safeParse(activity).success);assert.equal(artifactSchema.safeParse({...activity,details:{...activity.details,directions:[]}}).success,false);assert.equal(researchBatchSchema("activities",4).safeParse({items:[topic],rejected:[]}).success,false);});
test("活动时间不猜年份，过期、将开始、进行中、缺失分别处理",()=>{const at=Date.parse("2026-09-24T00:00:00Z");assert.equal(activityStatus(activity,at),"ongoing");assert.equal(activityStatus(activity,Date.parse("2026-10-01")),"ended");assert.equal(activityStatus(activity,Date.parse("2026-08-01")),"upcoming");assert.equal(activityStatus({...activity,details:{...activity.details,dateQuote:"9月征稿"}},at),"unknown");assert.equal(activityStatus({...activity,details:{...activity.details,endsAt:null}},at),"unknown");});
test("已结束和年份不明的活动不能通过质量检查",()=>{assert.ok(activityIssues({...activity,details:{...activity.details,startsAt:"2025-09-01T00:00:00+08:00",endsAt:"2025-09-30T23:59:59+08:00",dateQuote:"2025年9月征稿"}},evidence).some(x=>x.includes("已结束")));assert.ok(activityIssues({...activity,details:{...activity.details,dateQuote:"9月征稿"}},evidence).some(x=>x.includes("时间尚未核实")));});
test("登录可见的官方单条规则经核对后可以推荐，无需伪造第二来源",()=>{const source={...evidence[0],id:"ev-creator-rules",url:"https://fe.xiaohongshu.com/ditto/vincent/activity-rules",excerpt:"AI工作流活动：2027年9月1日至2027年9月30日征稿。面向原创图文创作者，符合主题可报名。",publishedAt:undefined};const a:Activity={...activity,evidenceIds:[source.id],claims:[{statement:"2027年9月征稿",type:"fact",evidenceIds:[source.id],quote:"2027年9月1日至2027年9月30日征稿"}],details:{...activity.details,platform:"小红书",activityUrl:source.url,startsAt:"2027-09-01T00:00:00+08:00",endsAt:"2027-09-30T23:59:59+08:00",dateQuote:"2027年9月1日至2027年9月30日征稿",access:"login_required",directions:activity.details.directions.map((d,i)=>({...d,angle:`第${i+1}种具体任务`,outline:[`任务${i+1}`,"展示流程与限制"]}))}};assert.deepEqual(qualityIssues(a,[source]),[]);assert.ok(activityIssues({...a,details:{...a.details,activityUrl:"https://creator.xiaohongshu.com/new/events"}},[{...source,url:"https://creator.xiaohongshu.com/new/events"}]).some(x=>x.includes("单条直达链接")));});
test("活动链接和时间原文必须有证据，平台用户视频不自动认定官方规则",()=>{const issues=activityIssues({...activity,details:{...activity.details,activityUrl:"https://example.com/invented"}},evidence);assert.ok(issues.some(x=>x.includes("活动地址")));assert.ok(issues.some(x=>x.includes("原文锚点")));assert.equal(activitySourceType("https://www.douyin.com/video/123"),"other");assert.equal(activitySourceType("https://activity.douyin.com/rules"),"official");});
test("老库保留活动策略；默认可看待验证，推荐筛选仍只显示通过检查",()=>{const dir=mkdtempSync(path.join(tmpdir(),"dd-activity-"));let db=new Store(dir);try{const plan=defaultPlans.find(p=>p.kind==="activities")!;assert.equal(queryPlan(plan,6).slice(0,4).length,4);assert.equal(plan.scheduleEnabled,false);db.put("plans",plan.id,{...plan,name:"我的活动雷达"});db.saveArtifact(activity,"activity-test","review",[]);db.close();db=new Store(dir);assert.equal((db.get<any>("plans",plan.id)).name,"我的活动雷达");assert.equal((db.snapshot(new URLSearchParams("page=1&view=activities&activityPlatform=小红书&activityTime=all")) as any).artifacts.length,0);assert.equal((db.snapshot(new URLSearchParams("page=1&view=activities&activityPlatform=哔哩哔哩&activityTime=all")) as any).artifacts.length,1);assert.equal((db.snapshot(new URLSearchParams("page=1&view=activities&activityPlatform=哔哩哔哩&activityTime=all&quality=ready")) as any).artifacts.length,0);assert.equal((db.snapshot(new URLSearchParams("page=1&view=activities&activityPlatform=哔哩哔哩&activityTime=all&quality=review")) as any).artifacts.length,1);}finally{db.close();rmSync(dir,{recursive:true,force:true});}});

test("全部默认策略符合配置合同",()=>{for(const p of defaultPlans)assert.ok(planSchema.safeParse(p).success,p.id);});

test("活动证据经整理、专项分析、审核后进入活动列表（模拟模型）",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-activity-flow-")),db=new Store(dir);
 try{db.put("config","main",{...db.config(),apiKey:"test-only-no-network"});for(const e of evidence)db.put("evidence",e.id,e);const j=db.enqueue("creator-activities",evidence.map(e=>e.id))!;db.claim();let calls=0;
 await runJob(db,j,{structured:(async()=>{calls++;return calls===1?{clusters:[{label:"AI活动",summary:"活动规则",evidenceIds:activity.evidenceIds,contradictions:[],missing:[]}],excluded:[]}:calls===2?{items:[activity],rejected:[]}:{reviews:[{index:0,verdict:"pass",issues:[],note:"测试样本"}]};}) as any});
 assert.equal(db.get<any>("jobs",j.id).state,"completed");assert.equal(calls,3);const a=(db.snapshot(new URLSearchParams("page=1&view=activities&activityTime=all&quality=review")) as any).artifacts[0];assert.equal(a.kind,"activity");assert.equal(a.details.directions.length,3);assert.equal(a.visibility,"private");assert.equal(a.quality,"review");
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("按活动平台限定搜索域名，并丢弃搜索引擎混入的跨平台结果",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-activity-search-")),db=new Store(dir),original=globalThis.fetch;
 try{db.put("config","main",{...db.config(),tavilyKey:"test-only"});let requested:string[]=[];
 globalThis.fetch=(async(_url,options)=>{requested=JSON.parse(String(options?.body)).include_domains;return new Response(JSON.stringify({results:[{title:"B站活动",url:"https://www.bilibili.com/blackboard/test.html",content:"其他平台活动"},{title:"抖音活动",url:"https://activity.douyin.com/rules",content:"AI创作活动规则"}]}),{status:200});}) as typeof fetch;
 const found=await searchWeb(db,defaultPlans.find(p=>p.kind==="activities")!,"抖音 AI 创作活动",new AbortController().signal);assert.deepEqual(requested,["douyin.com","douyinstatic.com"]);assert.equal(found.length,1);assert.match(found[0].url,/activity.douyin/);
 }finally{globalThis.fetch=original;db.close();rmSync(dir,{recursive:true,force:true});}
});

test("活动模型短编号精确还原，未知引用仍拒绝",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-activity-alias-")),db=new Store(dir);
 try{db.put("config","main",{...db.config(),apiKey:"test-only"});const j=db.enqueue("creator-activities")!;
 const short=JSON.parse(JSON.stringify(activity).replaceAll("ev-one","ref_1").replaceAll("ev-two","ref_2"));
 const request=(async(_db:any,messages:any)=>{assert.equal(JSON.parse(messages[1].content).evidence[0].id,"ref_1");return {text:JSON.stringify({items:[short],rejected:[]}),usage:0,reservation:0};}) as any;
 const result=await structured(db,j,"test",{evidence},researchBatchSchema("activities",4,evidence.map(e=>e.id)),new AbortController().signal,request);assert.deepEqual(result.items[0].evidenceIds,activity.evidenceIds);
 const bad={...short,evidenceIds:["ref_999"]};await assert.rejects(()=>structured(db,j,"test",{evidence},researchBatchSchema("activities",4,evidence.map(e=>e.id)),new AbortController().signal,(async()=>({text:JSON.stringify({items:[bad],rejected:[]}),usage:0,reservation:0})) as any),/未满足数据合同/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
