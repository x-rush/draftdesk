import test from "node:test";
import assert from "node:assert/strict";
import { qualityIssues } from "../core/quality";
import { evidence, topic } from "./fixtures";
import { researchBatchSchema } from "../core/schema";
import { safeResearchError } from "../core/errors";
import { z } from "zod";

test("平台钩子中的虚构第一人称实测不能通过检查", () => {
  const draft = structuredClone(topic);
  draft.details.platforms[0].hook = "我们用实际素材跑了一遍，实测报告出炉。";
  assert.ok(qualityIssues(draft, evidence).some((s) => s.includes("实测")));
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
