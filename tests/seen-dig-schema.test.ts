// 热词掘金 v3 数据层守护：intent 规则判定、长尾判定、seed/intent 在三个
// 写入路径（merge/observe/observeSuggestion）中的保留与补判语义。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { classifyIntent, isLongTail, mergeSeenTerm, observeSeenTerm, observeSuggestion } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("intent 规则判定：四大意图与优先级（教程→对比→商业→疑问）", () => {
  assert.equal(classifyIntent("notion 怎么导出 pdf"), "informational");
  assert.equal(classifyIntent("剪映字幕教程"), "informational");
  assert.equal(classifyIntent("how to check"), "informational");
  assert.equal(classifyIntent("ChatGPT 替代"), "comparison");
  assert.equal(classifyIntent("notion vs obsidian"), "comparison");
  assert.equal(classifyIntent("剪映会员多少钱"), "commercial");
  assert.equal(classifyIntent("is notion free"), "commercial");
  assert.equal(classifyIntent("is notion down？"), "question");
  assert.equal(classifyIntent("which tool"), "question");
  assert.equal(classifyIntent("randomterm"), "informational");
});

test("intent 判定不吃英文子串：vscode 不触发 vs，freeguide 不触发 free", () => {
  assert.equal(classifyIntent("vscode settings"), "informational");
  assert.equal(classifyIntent("freeguide"), "informational");
});

test("长尾判定：≥3 词元为长尾，中文连写按 1 词元", () => {
  assert.equal(isLongTail("notion vs obsidian which"), true);
  assert.equal(isLongTail("notion tutorial"), false);
  assert.equal(isLongTail("剪映字幕教程"), false);
});

test("observeSuggestion：新词 status=new 带 seed 血缘与规则 intent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-"));
  try {
    const db = new Store(dir);
    const doc = observeSuggestion(db, "Notion 替代 Excel", "excel");
    assert.equal(doc.status, "new");
    assert.equal(doc.seed, "excel");
    assert.equal(doc.intent, "comparison");
    assert.equal(doc.observations, 1);
    assert.equal(doc.producedBy, "suggest-expansion/1.0.0");
    assert.deepEqual(db.get("seen-terms", doc.id).sources, ["suggest-expansion"]);
  } finally { cleanup(dir); }
});

test("observeSuggestion 幂等：已存在词只推进 lastSeenAt/observations，seed 首见保留", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-"));
  try {
    const db = new Store(dir);
    mergeSeenTerm(db, { term: "老词", status: "rising", sources: ["rss"] }, "agent:x");
    const before = db.get<any>("seen-terms", "老词");
    const doc = observeSuggestion(db, "老词", "seedB", { source: "paa", intent: "question" });
    assert.equal(doc.status, "rising");
    assert.equal(doc.observations, before.observations + 1);
    assert.equal(doc.seed, "seedB");
    assert.equal(doc.intent, "question");
    assert.ok(doc.sources.includes("rss") && doc.sources.includes("paa"));
    // 二次展开不同种子：seed 不被覆盖
    const again = observeSuggestion(db, "老词", "seedC");
    assert.equal(again.seed, "seedB");
  } finally { cleanup(dir); }
});

test("observeSeenTerm 自动补 intent；mergeSeenTerm 保留 seed/intent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-"));
  try {
    const db = new Store(dir);
    const doc = observeSeenTerm(db, "自动教程词");
    assert.equal(doc.intent, "informational");
    const up = mergeSeenTerm(db, { term: "自动教程词", status: "rising", seed: "源头", intent: "commercial" }, "agent:x");
    assert.equal(up.seed, "源头");
    assert.equal(up.intent, "commercial");
    const keep = mergeSeenTerm(db, { term: "自动教程词", status: "sustained" }, "agent:x");
    assert.equal(keep.seed, "源头");
    assert.equal(keep.intent, "commercial");
    assert.equal(keep.status, "sustained");
  } finally { cleanup(dir); }
});
