import test from "node:test";
import assert from "node:assert/strict";
import { loadSkill, skillCatalog } from "../core/skills";
import { skillBundle } from "../core/skill-bundle";
import { evidenceContext } from "../core/research-context";
import { evidence } from "./fixtures";
import { cases } from "../evals/cases";
import { evidenceSchema } from "../core/schema";
import { qualityIssues } from "../core/quality";
import { topic } from "./fixtures";

test("任务实际加载专项参考，版本来自文件且下载包包含同一规程", () => {
  const archive = skillBundle().toString("utf8");
  for (const s of skillCatalog) {
    const skill = loadSkill(s.id);
    assert.match(skill.version, /^\d+\.\d+\.\d+$/);
    assert.equal(skill.digest.length, 12);
    for (const ref of skill.references) {
      assert.ok(skill.content.includes(`参考规程 ${ref}`));
      assert.ok(archive.includes(`skills/${s.id}/${ref}`));
    }
  }
  assert.throws(() => loadSkill("../config"));
});

test("长材料保留首尾限制并显式标记省略，短材料原样保存", () => {
  const excerpt = "公开预告。" + "介绍".repeat(3000) + "仅企业套餐，个人版不开放。";
  const result = evidenceContext([{...evidence[0], excerpt}], 1000)[0];
  assert.equal(result.truncated, true);
  assert.ok(result.excerpt.startsWith("公开预告。"));
  assert.ok(result.excerpt.endsWith("仅企业套餐，个人版不开放。"));
  assert.ok(result.excerpt.includes("中段省略"));
  assert.equal(result.originalChars, excerpt.length);
  assert.equal(evidenceContext(evidence)[0].excerpt, evidence[0].excerpt);
});

test("评测案例具有合法独立材料和人工标准，没有把未评测写成成功", () => {
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(c.criteria.length >= 3);
    loadSkill(c.skill);
    for (const {provenance, fingerprint, ...e} of c.evidence) evidenceSchema.parse(e);
  }
});

test("单一官方公告可以支撑公告事实，但不会自动免除体验推断和引用校验", () => {
  const news = { ...topic, kind: "news" as const, evidenceIds: [evidence[0].id], claims: [topic.claims[0]], details: {whatChanged: "新增导出字段", availability: "见公告，免费范围未知", limitations: ["未独立实测"]} };
  assert.ok(!qualityIssues(news, evidence).some(s => s.includes("一个来源")));
  assert.ok(qualityIssues({...news, claims: topic.claims}, evidence).some(s => s.includes("一个来源")));
  assert.ok(qualityIssues({...news, claims: [{...topic.claims[0], quote: "并不存在的原话"}]}, evidence).some(s => s.includes("原话")));
});
