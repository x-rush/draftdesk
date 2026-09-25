import test from "node:test";
import assert from "node:assert/strict";
import { qualityIssues } from "../core/quality";
import { evidence, topic } from "./fixtures";
import { researchBatchSchema, researchClusterSchema } from "../core/schema";
import { safeResearchError } from "../core/errors";
import { z } from "zod";
import { structured as generateStructured } from "../core/model";

test("资讯漏 details 可修复，连续缺失则拒绝，不用默认值掩盖", async () => {
  const { details: _details, ...common } = topic;
  const missing = {items:[{...common,kind:"news"}],rejected:[]};
  const repaired = {items:[{...common,kind:"news",details:{whatChanged:"支持导出负责人字段",availability:"本轮未核实可用范围",limitations:["套餐条件待核实"]}}],rejected:[]};
  const contract = researchBatchSchema("editorial", 2, evidence.map(e=>e.id));
  for (const recover of [true,false]) {
    const logs:any[]=[];let calls=0;
    const db={put:(...args:any[])=>logs.push(args),step:()=>{}} as any;
    const request=(async (_db:any,messages:any[])=>{
      calls++;
      if(calls===2){assert.match(messages.at(-1).content,/items.0.details/);assert.match(messages.at(-1).content,/不能因为摘要已有内容就省略/);}
      return {text:JSON.stringify(calls===2&&recover?repaired:missing),usage:0,reservation:0};
    }) as any;
    const result=generateStructured(db,{id:"test"} as any,"editorial",{evidence},contract,new AbortController().signal,request);
    if(recover) assert.deepEqual(await result,contract.parse(repaired));
    else await assert.rejects(result,/连续两次未满足数据合同/);
    assert.equal(calls,2);
    assert.ok(logs.every(entry=>entry[0]==="job-validation"));
  }
});

test("平台钩子中的虚构第一人称实测不能通过检查", () => {
  const draft = structuredClone(topic);
  draft.details.platforms[0].hook = "我们用实际素材跑了一遍，实测报告出炉。";
  assert.ok(qualityIssues(draft, evidence).some((s) => s.includes("实测")));
});

test("未操作过产品时平台标题不能包装成已完成实测",()=>{
 const draft=structuredClone(topic);
 draft.details.platforms[0].titles[0]="AI 新功能实测：三个避坑技巧";
 assert.ok(qualityIssues(draft,evidence).some(s=>s.includes("平台标题")));
 draft.details.platforms[0].titles[0]="如何实测 AI 新功能：一份验证计划";
 assert.ok(!qualityIssues(draft,evidence).some(s=>s.includes("平台标题")));
});

test("跨域转载同一内容不算独立交叉证据", () => {
  const excerpt = "产品发布了新的自动剪辑功能，支持字幕纠错和素材整理，但价格与灰度范围尚未说明。".repeat(8);
  const syndicated = evidence.map((e) => ({ ...e, excerpt }));
  assert.ok(qualityIssues(topic, syndicated).some((s) => s.includes("转载")));
});

test("未来验证计划与来源归属清晰的引述不被当成已完成实测", () => {
  const draft = structuredClone(topic);
  draft.details.platforms[0].hook = "尚未实测：计划用同一份素材对照测试。";
  assert.equal(qualityIssues(draft, evidence).length, 0);
});

test("专项 Schema 在生成与修复阶段拒绝错类型和超数量", () => {
  assert.throws(() => researchBatchSchema("trends", 2).parse({ items: [topic], rejected: [] }));
  assert.throws(() => researchBatchSchema("editorial", 1).parse({ items: [topic, topic], rejected: [] }));
  assert.equal(researchBatchSchema("editorial", 1).parse({ items: [topic], rejected: [] }).items.length, 1);
});
test("异常不把供应商响应或密钥写入运行记录", () => {
  assert.ok(!safeResearchError(new SyntaxError('Unexpected token in sk-secret-response')).includes('sk-secret'));
  assert.ok(!safeResearchError(new Error('https://provider.invalid/?key=sk-secret')).includes('sk-secret'));
  assert.match(safeResearchError(new DOMException('timeout', 'TimeoutError')), /可能计费/);
});
test("引用范围进入结构修复，同时保持可发送的 JSON Schema", () => {
  const contract = researchBatchSchema("topic", 1, evidence.map((e) => e.id));
  assert.doesNotThrow(() => z.toJSONSchema(contract));
  const draft = structuredClone(topic);
  draft.evidenceIds = ["invented-id"];
  const result = contract.safeParse({ items: [draft], rejected: [] });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some((i) => i.path.join('.') === 'items.0.evidenceIds.0'));
});
test("排除理由可以没有关联证据，但产物仍必须引用证据", () => {
  const result = researchBatchSchema("topic", 1).parse({ items: [topic], rejected: [{reason:"当前材料不支持该方向"}] });
  assert.deepEqual(result.rejected[0].evidenceIds, []);
  assert.throws(() => researchBatchSchema("topic", 1).parse({ items: [{...topic,evidenceIds:[]}], rejected: [] }));
});
test("证据整理的错误ID也进入结构修复，而不是在付费调用后直接失败",()=>{
  const contract=researchClusterSchema(["ev-one"]);
  assert.doesNotThrow(()=>z.toJSONSchema(contract));
  const bad=contract.safeParse({clusters:[{label:"事件",summary:"摘要",evidenceIds:["1"],contradictions:[],missing:[]}],excluded:[]});
  assert.equal(bad.success,false);
  if(!bad.success)assert.equal(bad.error.issues[0].path.join('.'),'clusters.0.evidenceIds.0');
  assert.equal(contract.safeParse({clusters:[],excluded:[{evidenceId:"invented",reason:"无关"}]}).success,false);
  assert.equal(contract.safeParse({clusters:[],excluded:[{evidenceId:"ev-one",reason:"无关"}]}).success,true);
});
