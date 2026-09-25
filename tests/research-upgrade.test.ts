import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { plan, evidence, topic } from "./fixtures";
import { queryPlan, rankEvidence, supplementQueries, decisionOf } from "../core/research-policy";
import { metricComparison, type MetricSnapshot, type ResearchEvent } from "../core/history";
import { evaluateOutput } from "../core/evaluation";
import { runJob } from "../core/pipeline";
import type { Job, Artifact } from "../core/schema";
async function fixture(fn:(db:Store)=>unknown) {const dir=mkdtempSync(path.join(tmpdir(),"dd-upgrade-"));const db=new Store(dir);db.put("config","main",{...db.config(),apiKey:"isolated-test-key"});try{await fn(db)}finally{db.close();rmSync(dir,{recursive:true,force:true})}}
const input = (n:number, extra:object={}) => {const {id,provenance,fingerprint,...rest}=evidence[0];return {...rest,title:"同一工具发布",url:`https://example.com/update-${n}`,excerpt:"同一公告明确开放功能并说明限制。".repeat(15),...extra};};
test("四种检索分别覆盖官方、问题、指标和人物身份，且受查询数量限制",()=>{
  for(const [kind,term] of [["editorial","官方"],["opportunity","求助"],["trends","指数"],["people","本人"]] as const){const q=queryPlan({...plan,kind,keywords:["测试工具"]},2);assert.equal(q.length,2);assert.match(q[0].query,new RegExp(term));assert.notEqual(q[0].purpose,q[1].purpose)}
  assert.deepEqual(queryPlan({...plan,keywords:[]}),[]);assert.deepEqual(queryPlan(plan,0),[]);
  assert.equal(rankEvidence([...evidence].reverse(),{...plan,kind:"editorial"})[0].sourceType,"official");
  assert.equal(rankEvidence(evidence,{...plan,kind:"opportunity"})[0].sourceType,"community");
  assert.equal(supplementQueries([{label:"工具",missing:["价格未知","价格未知","地区限制"]}],"editorial",2).length,2);
});
test("转载同事件合并；再次采集不生成新修订；真实正文变化留下更新",async()=>fixture(db=>{
  const a=db.addEvidence(input(1),"test");db.addEvidence(input(2),"test");db.addEvidence(input(1,{collectedAt:"2026-09-23T00:00:00Z"}),"test");
  let events=db.list<ResearchEvent>("events");assert.equal(events.length,1);assert.equal(events[0].revisions.length,2);assert.equal(events[0].revisions[1].change,"duplicate");
  db.addEvidence(input(1,{excerpt:"收费条件已变更：只有付费版允许导出。"}),"test");events=db.list<ResearchEvent>("events");assert.equal(events[0].revisions.at(-1)?.change,"update");assert.ok(events[0].evidenceIds.includes(a.id));
}));
test("无正文且标题不同的页面不会合并为同事件",async()=>fixture(db=>{
  db.addEvidence(input(1,{title:"甲工具",excerpt:""}),"test");db.addEvidence(input(2,{title:"乙工具",excerpt:""}),"test");assert.equal(db.list("events").length,2);
}));
test("历史按来源地域口径隔离；分桶和未知周期不计算增速",async()=>fixture(db=>{
  for(const [period,value] of [["2026-09-21T00:00:00Z","100"],["2026-09-22T00:00:00Z","150"]]) db.addEvidence(input(1,{metric:{name:"搜索量",unit:"次",period,value,cadence:"day"}}),"test");
  const all=db.list<MetricSnapshot>("metrics");const latest=all.find(m=>m.value==="150")!;assert.equal(metricComparison(all,latest).percent,50);
  db.addEvidence(input(1,{metric:{name:"搜索量",unit:"次",period:latest.period,value:"150",cadence:"day"}}),"test");assert.equal(db.list("metrics").length,2);
  db.addEvidence(input(1,{region:"美国",metric:{name:"搜索量",unit:"次",period:latest.period,value:"150",cadence:"day"}}),"test");
  const us=db.list<MetricSnapshot>("metrics").find(m=>m.region==="美国")!;assert.equal(metricComparison(db.list("metrics"),us).percent,null);
  assert.equal(metricComparison(all,{...latest,numeric:null,value:"10K+"}).percent,null);
  assert.equal(metricComparison(all,{...latest,cadence:undefined}).percent,null);
  assert.equal(metricComparison(all,{...latest,period:"2026-09-24T00:00:00Z"}).percent,null);
}));
test("已否决和待验证分开且不能公开；旧版 reject 记录兼容",async()=>fixture(db=>{
  const a=db.saveArtifact(topic,"test","review",["审稿建议：reject"]);assert.equal(a.quality,"rejected");assert.equal(decisionOf({...a,quality:"review"}),"rejected");
  assert.throws(()=>db.updateArtifact({id:a.id,revision:a.revision,visibility:"public"}));
}));
test("正常空结果是无推荐，来源失败仍为错误",async()=>fixture(async db=>{
  db.put("plans",plan.id,plan);const job=db.enqueue(plan.id)!;
  await runJob(db,job,{collect:async()=>({evidence:[],warnings:[],searches:0}),structured:(async()=>{throw Error("不应调用")}) as any});
  assert.equal(db.get<Job>("jobs",job.id)?.state,"completed");assert.equal(db.get<Job>("jobs",job.id)?.outcome,"no-findings");
}));
test("严格热词模式无原始指标时保留证据，跳过所有模型调用",async()=>fixture(async db=>{
  const p={...plan,kind:"trends" as const,requireMetrics:true};db.put("plans",p.id,p);
  const e=db.addEvidence(input(1),"test"),job=db.enqueue(p.id)!;let calls=0;
  await runJob(db,job,{collect:async()=>({evidence:[e],warnings:[],searches:1}),structured:(async()=>{calls++;throw Error("不应调用模型")}) as any});
  const result=db.get<Job>("jobs",job.id)!;
  assert.equal(calls,0);assert.equal(result.state,"completed");assert.equal(result.outcome,"no-findings");assert.deepEqual(result.evidenceIds,[e.id]);
}));
test("固定证据无新增则跨任务跳过，保留更新资料",async()=>fixture(async db=>{
  db.put("plans",plan.id,plan);const a=db.addEvidence(input(1),"test");const first=db.enqueue(plan.id)!;db.patchJob(first.id,{state:"completed",evidenceIds:[a.id]});
  const b=db.addEvidence(input(2),"test");const next=db.enqueue(plan.id)!;let calls=0;
  await runJob(db,next,{collect:async()=>({evidence:[b],warnings:[],searches:0}),structured:(async()=>{calls++;throw Error("不应调用")}) as any});
  assert.equal(calls,0);assert.equal(db.get<Job>("jobs",next.id)?.outcome,"no-findings");
}));
test("补证共用总查询预算，失败被记录且缺口写入产物",async()=>fixture(async db=>{
  const p={...plan,maxQueries:2,maxEvidence:8,sourceIds:["web-test"]};db.put("plans",p.id,p);db.put("sources","web-test",{id:"web-test",type:"web",enabled:true});
  db.put("config","main",{...db.config(),tavilyKey:"test-only"});const saved=db.addEvidence(input(1),"test");const job=db.enqueue(p.id)!;let stage=0,searches=0;
  const draft={...topic,evidenceIds:[saved.id],claims:topic.claims.map(c=>({...c,evidenceIds:c.evidenceIds.length?[saved.id]:[]}))};
  await runJob(db,job,{collect:async()=>({evidence:[saved],warnings:[],searches:1}),search:async()=>{searches++;throw Error("offline failure")},
    structured:(async()=>{stage++;return stage===1?{clusters:[{label:"工具",summary:"更新",evidenceIds:[saved.id],contradictions:[],missing:["价格未知","地区限制"]}],excluded:[]}:stage===2?{items:[draft],rejected:[]}:{reviews:[{index:0,verdict:"revise",issues:[],note:"需补证"}]}}) as any});
  assert.equal(searches,1);assert.equal(db.get<Job>("jobs",job.id)?.searchCount,2);assert.equal(db.get<Job>("jobs",job.id)?.state,"completed");
  assert.ok(db.list<Artifact>("artifacts")[0].unknowns.some(s=>s.includes("补证搜索失败")));
  assert.equal(db.list<any>("job-verification")[0].length,2);
}));
test("一个事件的待核实问题不会混入另一事件的产物",async()=>fixture(async db=>{
  const p={...plan,maxQueries:0};db.put("plans",p.id,p);
  const a=db.addEvidence(input(1,{title:"产品甲更新"}),"test");
  const b=db.addEvidence(input(2,{title:"产品乙更新"}),"test");
  const job=db.enqueue(p.id,[a.id,b.id])!;
  let stage=0;
  const draft=(id:string,title:string)=>({...topic,title,evidenceIds:[id],claims:[]});
  await runJob(db,job,{structured:(async()=>{
    stage++;
    if(stage===1)return {clusters:[
      {label:"产品甲",summary:"甲更新",evidenceIds:[a.id],contradictions:[],missing:["甲价格未知"]},
      {label:"产品乙",summary:"乙更新",evidenceIds:[b.id],contradictions:[],missing:["乙地区限制"]},
    ],excluded:[]};
    if(stage===2)return {items:[draft(a.id,"甲选题"),draft(b.id,"乙选题")],rejected:[]};
    return {reviews:[{index:0,verdict:"revise",issues:[],note:"待核实"},{index:1,verdict:"revise",issues:[],note:"待核实"}]};
  }) as any});
  const artifacts=db.list<Artifact>("artifacts");
  assert.equal(db.get<Job>("jobs",job.id)?.state,"completed");
  const first=artifacts.find(x=>x.title==="甲选题")!,second=artifacts.find(x=>x.title==="乙选题")!;
  assert.ok(first.unknowns.some(x=>x.includes("甲价格未知")));
  assert.ok(!first.unknowns.some(x=>x.includes("乙地区限制")));
  assert.ok(second.unknowns.some(x=>x.includes("乙地区限制")));
  assert.ok(!second.unknowns.some(x=>x.includes("甲价格未知")));
}));
test("固定评测区分引用存在、引文匹配与待人工评价，空输出不满分",()=>{
  const baseline=evaluateOutput([topic],evidence);assert.equal(baseline.referenceValidity,1);assert.equal(baseline.semanticQuality,null);
  const forged=structuredClone(topic);forged.claims[0].quote="证据中没有这句话";assert.equal(evaluateOutput([forged],evidence).exactQuoteMatch,0);
  assert.equal(evaluateOutput([],evidence).referenceValidity,null);
});

test("整理员漏报需求缺口时仍定向补查，材料检查进入审稿且不能被pass绕过",async()=>fixture(async db=>{
  const p={...plan,kind:"opportunity" as const,sourceIds:["web-test"],maxQueries:2,maxEvidence:8};
  db.put("plans",p.id,p);db.put("sources","web-test",{type:"web",enabled:true});
  db.put("config","main",{...db.config(),tavilyKey:"isolated-test-key"});
  const e=db.addEvidence(input(1),"test");const job=db.enqueue(p.id)!;let calls=0,queries=0;
  const idea={...topic,kind:"idea",evidenceIds:[e.id],claims:[{statement:"假设",type:"hypothesis",evidenceIds:[]}],details:{job:"整理任务",trigger:"会议后",frequency:"未知",alternatives:["表格"],differentiation:"核对任务",mvp:["导入","核对"],nonGoals:[],willingnessToPay:"未知",experiment:"人工代办",successCriteria:"复用",stopCriteria:"无需要"}};
  await runJob(db,job,{collect:async()=>({evidence:[e],warnings:[],searches:1}),search:async(_db,_p,q)=>{queries++;assert.match(q,/用户问题/);return []},structured:(async(_db:any,_job:any,_skill:any,context:any)=>{
    calls++;
    if(calls===1)return {clusters:[{label:"工具",summary:"更新",evidenceIds:[e.id],contradictions:[],missing:[]}],excluded:[]};
    if(calls===2){assert.ok(context.materialGaps.length);return {items:[idea],rejected:[]}}
    assert.ok(context.evidenceChecks[0].checks.some((c:any)=>c.key==="problem"&&c.status==="missing"));
    return {reviews:[{index:0,verdict:"pass",issues:[],note:"模拟审稿误判"}]};
  }) as any});
  assert.equal(queries,1);assert.equal(calls,3);
  assert.equal(db.get<Job>("jobs",job.id)?.state,"completed");
  assert.equal(db.list<Artifact>("artifacts")[0].quality,"review");
}));
test("空聚类和空产物均正常结束，不继续花费审稿调用",async()=>{
  for(const emptyStage of [1,2]) await fixture(async db=>{
    db.put("plans",plan.id,plan);const e=db.addEvidence(input(1),"test");const job=db.enqueue(plan.id)!;let calls=0;
    await runJob(db,job,{collect:async()=>({evidence:[e],warnings:[],searches:0}),structured:(async()=>{
      calls++;if(calls===1)return {clusters:emptyStage===1?[]:[{label:"更新",summary:"具体更新",evidenceIds:[e.id],contradictions:[],missing:[]}],excluded:[]};
      return {items:[],rejected:[{reason:"没有具体个人价值",evidenceIds:[e.id]}]};
    }) as any});
    assert.equal(calls,emptyStage);assert.equal(db.get<Job>("jobs",job.id)?.outcome,"no-findings");
  });
});
test("补证结果进入分析和审稿；保留证据重试不额外搜索",async()=>{
  for(const external of [false,true]) await fixture(async db=>{
    const p={...plan,sourceIds:["web-test"],maxQueries:2,maxEvidence:8};db.put("plans",p.id,p);db.put("sources","web-test",{type:"web",enabled:true});
    db.put("config","main",{...db.config(),tavilyKey:"test-only"});const e=db.addEvidence(input(1),"test");const job=db.enqueue(plan.id,external?[e.id]:[])!;let calls=0,searches=0;
    await runJob(db,job,{collect:async()=>({evidence:[e],warnings:[],searches:1}),search:async()=>{searches++;return [input(3,{title:"官方收费页面",excerpt:"基础套餐不含导出。"})]},structured:(async(_db:any,_job:any,_skill:any,context:any)=>{
      calls++;if(calls===1)return {clusters:[{label:"工具",summary:"更新",evidenceIds:[e.id],missing:["免费范围"],contradictions:[]}],excluded:[]};
      assert.equal(context.evidence.length,external?1:2);assert.ok(context.verification.length);
      return {items:[],rejected:[]};
    }) as any});assert.equal(searches,external?0:1);assert.equal(calls,2);
  });
});
