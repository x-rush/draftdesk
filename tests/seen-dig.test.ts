// 热词掘金 v3 引擎 A 守护：展开计划形状、联想响应解析、频控调度器、
// 入库统计与幂等、tick 触发语义（手动优先/闸门每日一次/完成键幂等）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { collectSeeds, expansionQueries, parseSuggestPayload, Limiter, runSuggestExpansion, seenDiggingTick } from "../core/seen-dig";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function seedTerm(db: Store, term: string, status: string, opts: { offTopic?: boolean; lastSeenAt?: string } = {}) {
  db.put("seen-terms", term.toLowerCase(), {
    id: term.toLowerCase(), term, status, observations: 2, sources: ["rss"], relatedSearches: [],
    firstSeenAt: new Date().toISOString(), lastSeenAt: opts.lastSeenAt ?? new Date().toISOString(),
    daysSeen: [], offTopic: opts.offTopic,
  });
}

test("展开计划：字母 a-z + 8 个中文后缀 × 双语，共 68 条", () => {
  const plan = expansionQueries("notion");
  assert.equal(plan.length, 68);
  assert.deepEqual(plan[0], { q: "notion a", hl: "zh-CN" });
  assert.ok(plan.some((x) => x.q === "notion教程" && x.hl === "zh-CN"));
  assert.ok(plan.some((x) => x.q === "notion z" && x.hl === "en"));
  assert.equal(new Set(plan.map((x) => x.q + "|" + x.hl)).size, 68);
});

test("联想响应解析：chrome/firefox/g 三种形状", () => {
  assert.deepEqual(parseSuggestPayload('["seed",[["a",0],["b",0]]]'), ["a", "b"]);
  assert.deepEqual(parseSuggestPayload('["seed",["x","y"]]'), ["x", "y"]);
  assert.deepEqual(parseSuggestPayload('{"g":[{"q":"m"},{"q":"n"}]}'), ["m", "n"]);
  assert.deepEqual(parseSuggestPayload("not json at all"), []);
});

test("频控调度器：并发不超上限、相邻派发有间隔", async () => {
  let active = 0, maxActive = 0, lastStart = 0, minGap = Infinity;
  const tasks = Array.from({ length: 8 }, (_, i) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    const now = Date.now();
    if (lastStart) minGap = Math.min(minGap, now - lastStart);
    lastStart = now;
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return i;
  });
  const results = await new Limiter(25, 2).run(tasks);
  assert.deepEqual(results.sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(maxActive <= 2, `并发超限：${maxActive}`);
  assert.ok(minGap >= 20, `派发间隔不足：${minGap}ms`);
});

test("引擎 A 首跑：新词带 seed 入库，二跑只推进 observations；失败请求静默跳过", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-run-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "notion", "rising");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      if (calls % 7 === 0) throw new Error("boom");
      return new Response(JSON.stringify(["seed", [["notion 替代", 0], ["notion 教程", 0], ["notion 怎么用", 0]]]), { status: 200 });
    }) as unknown as typeof fetch;
    const stats = await runSuggestExpansion(db, fakeFetch, { intervalMs: 1 });
    assert.equal(stats.seeds, 1);
    assert.ok(stats.requests <= 700);
    assert.ok(stats.failed > 0, "应有失败请求被静默计数");
    assert.equal(stats.newTerms, 3);
    for (const term of ["notion 替代", "notion 教程", "notion 怎么用"]) {
      const doc = db.get<any>("seen-terms", term.toLowerCase());
      assert.equal(doc.seed, "notion");
      assert.equal(doc.status, "new");
      assert.equal(doc.producedBy, "suggest-expansion/1.0.0");
    }
    assert.equal(db.get<any>("seen-terms", "notion 教程").intent, "informational");
    const again = await runSuggestExpansion(db, fakeFetch, { intervalMs: 1 });
    assert.equal(again.newTerms, 0);
    assert.equal(again.updated, 3);
    assert.equal(db.get<any>("seen-terms", "notion 教程").observations, 2);
  } finally { cleanup(dir); }
});

test("种子收集：rising/sustained 优先、圈外排除、24h 新词补位、上限 10", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-seed-"));
  try {
    const db = new Store(dir);
    for (let i = 0; i < 8; i++) seedTerm(db, `rising${i}`, "rising");
    seedTerm(db, "圈外词", "rising", { offTopic: true });
    seedTerm(db, "archived词", "sustained");
    db.put("seen-terms", "archived词", { id: "archived词", term: "archived词", status: "archived", observations: 5, sources: [], relatedSearches: [], firstSeenAt: "", lastSeenAt: new Date().toISOString(), daysSeen: [] });
    seedTerm(db, "昨天的新词", "new", { lastSeenAt: new Date(Date.now() - 25 * 3600000).toISOString() });
    seedTerm(db, "今天的新词", "new");
    const seeds = collectSeeds(db);
    assert.equal(seeds.length, 9);
    assert.ok(seeds.every((s) => s.term !== "圈外词" && s.term !== "archived词"));
    assert.ok(seeds.some((s) => s.term === "今天的新词"), "24h 新词应补位");
    assert.ok(!seeds.some((s) => s.term === "昨天的新词"), "超 24h 新词不补位");
  } finally { cleanup(dir); }
});

test("tick：手动标记立即触发；完成键当日幂等；无标记无闸门不触发", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-tick-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "notion", "rising");
    const fakeFetch = (async () => new Response(JSON.stringify(["seed", [["notion tools", 0]]]), { status: 200 })) as unknown as typeof fetch;
    seenDiggingTick(db, fakeFetch, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.get("seen-terms", "notion tools"), undefined, "无手动标记且无闸门不应触发");
    db.put("meta", "seen-dig-manual", { date: new Date().toISOString().slice(0, 10), at: new Date().toISOString() });
    seenDiggingTick(db, fakeFetch, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(db.get("seen-terms", "notion tools"), "手动标记应触发挖掘");
    const done = db.get<any>("meta", "seen-dig-done:" + new Date().toISOString().slice(0, 10));
    assert.ok(done, "完成键应写入");
    db.put("meta", "seen-dig-manual", { date: new Date().toISOString().slice(0, 10), at: new Date().toISOString() });
    db.put("meta", "seen-terms-gate", { date: new Date().toISOString().slice(0, 10), at: new Date().toISOString() });
    seedTerm(db, "another", "rising");
    seenDiggingTick(db, fakeFetch, { intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.get("seen-terms", "another tools"), undefined, "完成键当日应幂等跳过");
  } finally { cleanup(dir); }
});
