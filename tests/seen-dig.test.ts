// 热词掘金 v3 引擎 A 守护：展开计划形状、联想响应解析、频控调度器、
// 入库统计与幂等、tick 触发语义（手动优先/闸门每日一次/完成键幂等）。
import test from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { collectSeeds, expansionQueries, providerQueries, parseSuggestPayload, parseJsonpSuggest, parseAmazonPayload, parseBiliPayload, parsePaa, parseRelatedRising, Limiter, runPaa, runProviderExpansion, runSuggestExpansion, runTrendsRising, seenDiggingTick, SUGGEST_PROVIDERS } from "../core/seen-dig";
import { termId } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function seedTerm(db: Store, term: string, status: string, opts: { offTopic?: boolean; relevance?: string; lastSeenAt?: string } = {}) {
  db.put("seen-terms", term.toLowerCase(), {
    id: term.toLowerCase(), term, status, observations: 2, sources: ["rss"], relatedSearches: [],
    firstSeenAt: new Date().toISOString(), lastSeenAt: opts.lastSeenAt ?? new Date().toISOString(),
    daysSeen: [], offTopic: opts.offTopic,
    // 显式传 relevance: undefined 表示「未判定」，不传默认 strong
    relevance: "relevance" in opts ? opts.relevance : "strong",
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
      const doc = db.get<any>("seen-terms", termId(term));
      assert.equal(doc.seed, "notion");
      assert.equal(doc.status, "new");
      assert.equal(doc.producedBy, "suggest-expansion/1.0.0");
    }
    assert.equal(db.get<any>("seen-terms", termId("notion 教程")).intent, "informational");
    const again = await runSuggestExpansion(db, fakeFetch, { intervalMs: 1 });
    assert.equal(again.newTerms, 0);
    assert.equal(again.updated, 3);
    assert.equal(db.get<any>("seen-terms", termId("notion 教程")).observations, 2);
  } finally { cleanup(dir); }
});

test("种子收集：rising/sustained 优先、圈外排除、24h 新词补位、上限 10", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-seed-"));
  try {
    const db = new Store(dir);
    for (let i = 0; i < 8; i++) seedTerm(db, `rising${i}`, "rising");
    seedTerm(db, "圈外词", "rising", { offTopic: true });
    seedTerm(db, "archived词", "sustained");
    db.put("seen-terms", "archived词", { id: "archived词", term: "archived词", status: "archived", observations: 5, sources: [], relatedSearches: [], firstSeenAt: "", lastSeenAt: new Date().toISOString(), daysSeen: [], relevance: "strong" });
    seedTerm(db, "昨天的新词", "new", { lastSeenAt: new Date(Date.now() - 25 * 3600000).toISOString() });
    seedTerm(db, "今天的新词", "new");
    const seeds = collectSeeds(db);
    assert.equal(seeds.length, 9);
    assert.ok(seeds.every((s) => s.term !== "圈外词" && s.term !== "archived词"));
    assert.ok(seeds.some((s) => s.term === "今天的新词"), "24h 新词应补位");
    assert.ok(!seeds.some((s) => s.term === "昨天的新词"), "超 24h 新词不补位");
  } finally { cleanup(dir); }
});

test("三档闸（清洗批①）：只有 relevance=strong 可回流种子池，off/weak/未判定全挡", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-gate-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "强相关词", "rising");
    seedTerm(db, "误标圈外词", "rising", { offTopic: false, relevance: "off" });
    seedTerm(db, "弱相关词", "rising", { relevance: "weak" });
    seedTerm(db, "未判定词", "rising", { relevance: undefined });
    seedTerm(db, "强相关新词", "new");
    const seeds = collectSeeds(db);
    assert.deepEqual(seeds.map((s) => s.term).sort(), ["强相关新词", "强相关词"].sort());
    // PAA 引擎同一道闸：rising 且 strong 才发起 SERP 请求（5 个 rising 中只应打 1 个）
    seedTerm(db, "弱相关词2", "rising", { relevance: "weak" });
    let paaCalls = 0;
    const stats = await runPaa(db, (async () => { paaCalls++; throw new Error("boom"); }) as unknown as typeof fetch);
    assert.equal(stats.rising, 1);
    assert.equal(paaCalls, 1, "PAA 只对 strong 词发起请求");
    assert.equal(stats.skipped, 1);
  } finally { cleanup(dir); }
});

test("tick：手动标记立即触发；完成键当日幂等；无标记无闸门不触发", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-tick-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "notion", "rising");
    const fakeFetch = (async () => new Response(JSON.stringify(["seed", [["notion tools", 0]]]), { status: 200 })) as unknown as typeof fetch;
    seenDiggingTick(db, fakeFetch, { intervalMs: 1, providerIntervalMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.get("seen-terms", termId("notion tools")), undefined, "无手动标记且无闸门不应触发");
    db.put("meta", "seen-dig-manual", { date: shanghaiDayOf(), at: new Date().toISOString() });
    seenDiggingTick(db, fakeFetch, { intervalMs: 1, providerIntervalMs: 1 });
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok(db.get("seen-terms", termId("notion tools")), "手动标记应触发挖掘");
    const done = db.get<any>("meta", "seen-dig-done:" + shanghaiDayOf());
    assert.ok(done, "完成键应写入");
    db.put("meta", "seen-dig-manual", { date: shanghaiDayOf(), at: new Date().toISOString() });
    db.put("meta", "seen-terms-gate", { date: shanghaiDayOf(), at: new Date().toISOString() });
    seedTerm(db, "another", "rising");
    seenDiggingTick(db, fakeFetch, { intervalMs: 1, providerIntervalMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.get("seen-terms", termId("another tools")), undefined, "完成键当日应幂等跳过");
  } finally { cleanup(dir); }
});

const PAA_HTML = `<html><body><div><h3>搜索结果标题不应出现</h3></div>
<h3>People also ask</h3><div><h3><span>notion 怎么导出 pdf 文件</span></h3></div>
<div><h3>notion 是免费的吗还是收费</h3></div><h3><b>notion 和语雀哪个更好用些</b></h3></body></html>`;

test("PAA 解析：只取标记后的 h3 问题，去标签、去重、8-120 字", () => {
  assert.deepEqual(parsePaa(PAA_HTML), ["notion 怎么导出 pdf 文件", "notion 是免费的吗还是收费", "notion 和语雀哪个更好用些"]);
  assert.deepEqual(parsePaa("<html>没有标记</html>"), []);
});

test("引擎 B：rising 词查 PAA，问题词入库 intent=question；被封静默跳过", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-paa-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "notion", "rising");
    seedTerm(db, "obsidian", "rising");
    let call = 0;
    const fakeFetch = (async (url: any) => {
      call++;
      if (String(url).includes("q=obsidian")) return new Response("unusual traffic detected", { status: 429 });
      return new Response(PAA_HTML, { status: 200 });
    }) as unknown as typeof fetch;
    const stats = await runPaa(db, fakeFetch);
    assert.equal(stats.rising, 2);
    assert.equal(stats.questions, 3);
    assert.equal(stats.skipped, 1);
    const q = db.get<any>("seen-terms", termId("notion 怎么导出 pdf 文件"));
    assert.equal(q.seed, "notion");
    assert.equal(q.intent, "question");
    assert.deepEqual(q.sources, ["paa"]);
  } finally { cleanup(dir); }
});

test("引擎 C：explore 换 token 后取 Rising 列表，入库带 seed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-trends-"));
  try {
    const db = new Store(dir);
    for (const s of db.list<any>("sources").filter((x) => x.type === "trends" && x.id !== "trends-us"))
      db.put("sources", s.id, { ...s, enabled: false });
    db.put("sources", "trends-us", { id: "trends-us", name: "Trends US", type: "trends", region: "US", enabled: true, sourceType: "trend", note: "" });
    const RSS = "<rss><channel><title>Daily Search Trends</title><item><title>AI Notebook</title></item><item><title>Local LLM</title></item></channel></rss>";
    const EXPLORE = ")]}',\n" + JSON.stringify({ widgets: [
      { id: "TIMESERIES", token: "bad" },
      { id: "RELATED_QUERIES", token: "tok-1", request: { restriction: { geo: "US" } } },
    ] });
    const RELATED = ")]}',\n" + JSON.stringify({ default: { rankedList: [
      { rankedKeyword: [{ query: { query: "top 关键词不应出现" } }] },
      { rankedKeyword: [{ query: { query: "ai notebook free" }, value: 5000, formattedValue: "Breakout" }, { query: { query: "local llm 工具" }, value: 250, formattedValue: "+250%" }] },
    ] } });
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("widgetdata/relatedsearches")) {
        assert.ok(u.includes("token=tok-1"), "relatedsearches 必须携带 explore 换来的 token");
        return new Response(RELATED, { status: 200 });
      }
      if (u.includes("api/explore")) return new Response(EXPLORE, { status: 200 });
      if (u.includes("trending/rss")) return new Response(RSS, { status: 200 });
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    const stats = await runTrendsRising(db, fakeFetch);
    assert.equal(stats.keywords, 2);
    assert.equal(stats.rising, 2);
    const doc = db.get<any>("seen-terms", termId("ai notebook free"));
    assert.equal(doc.seed, "AI Notebook");
    assert.equal(doc.status, "new");
    assert.deepEqual(doc.sources, ["trends-rising"]);
    assert.equal(db.get("seen-terms", termId("top 关键词不应出现")), undefined, "Top 列表不入库");
  } finally { cleanup(dir); }
});

test("扩展联想（海外定位批 4）：展开计划、三种响应解析", () => {
  assert.equal(providerQueries("notion", "amazon").length, 26);
  assert.equal(providerQueries("notion", "yt").length, 32);
  assert.equal(providerQueries("notion", "cn").length, 34);
  assert.ok(providerQueries("notion", "yt").includes("notion how to"));
  assert.ok(providerQueries("notion", "cn").includes("notion替代"));
  // YouTube JSONP 与裸 JSON 双形状
  assert.deepEqual(parseJsonpSuggest('window.google.ac.h(["q",[["ai tools",0]]]);'), ["ai tools"]);
  assert.deepEqual(parseJsonpSuggest('["q",[["ai tools",0]]]'), ["ai tools"]);
  assert.deepEqual(parseAmazonPayload('{"suggestions":[{"value":"ai notebook"}]}'), ["ai notebook"]);
  assert.deepEqual(parseBiliPayload('{"code":0,"result":[{"term":"ai 短剧"}]}'), ["ai 短剧"]);
  assert.deepEqual(parseBiliPayload("bad json"), []);
});

test("扩展联想：region 种子分流（global 词只喂 YouTube/Amazon，cn 词只喂百度/B站），入库带来源", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-dig-prov-"));
  try {
    const db = new Store(dir);
    seedTerm(db, "global词", "rising", { relevance: "strong" });
    seedTerm(db, "global词", "rising");  // region 缺失按 global 兜底
    db.put("seen-terms", "global词", { id: "global词", term: "global词", status: "rising", observations: 2, sources: ["rss"], relatedSearches: [], daysSeen: [], firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), relevance: "strong", region: "global" });
    db.put("seen-terms", "中文词", { id: "中文词", term: "中文词", status: "rising", observations: 2, sources: ["weibo-hotsearch"], relatedSearches: [], daysSeen: [], firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), relevance: "strong", region: "cn" });
    const yt = SUGGEST_PROVIDERS.find((p) => p.id === "youtube-suggest")!;
    const baidu = SUGGEST_PROVIDERS.find((p) => p.id === "baidu-suggest")!;
    const seen = { yt: new Set<string>(), baidu: new Set<string>() };
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("ds=yt")) {
        seen.yt.add(decodeURIComponent(u.match(/q=([^&]+)/)![1]));
        return new Response('window.google.ac.h(["q",[["yt 新词",0]]]);', { status: 200 });
      }
      if (u.includes("sugrec")) {
        seen.baidu.add(decodeURIComponent(u.match(/wd=([^&]+)/)![1]));
        return new Response(JSON.stringify({ g: [{ q: "百度新词" }] }), { status: 200 });
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    const ytStats = await runProviderExpansion(db, yt, fakeFetch, { intervalMs: 1 });
    const baiduStats = await runProviderExpansion(db, baidu, fakeFetch, { intervalMs: 1 });
    assert.ok(ytStats.newTerms >= 1);
    assert.ok(baiduStats.newTerms >= 1);
    assert.ok([...seen.yt].every((q) => !q.includes("中文词")), "YouTube 不得展开 cn 种子");
    assert.ok([...seen.baidu].every((q) => !q.includes("global词")), "百度不得展开 global 种子");
    const ytDoc = db.get<any>("seen-terms", termId("yt 新词"));
    assert.equal(ytDoc.source, undefined);
    assert.deepEqual(ytDoc.sources, ["youtube-suggest"]);
    assert.equal(ytDoc.region, "global");
    assert.equal(ytDoc.seed, "global词");
    const bdDoc = db.get<any>("seen-terms", termId("百度新词"));
    assert.deepEqual(bdDoc.sources, ["baidu-suggest"]);
    assert.equal(bdDoc.region, "cn");
  } finally { cleanup(dir); }
});

test("词根探针（批 2b）：轮转批次 + 联想入库 seed=词根 + cursor 推进 + 体量上限", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-rootprobe-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    let calls = 0;
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("suggestqueries.google.com")) {
        calls++;
        const q = decodeURIComponent(u.match(/q=([^&]+)/)?.[1] || "");
        return new Response(JSON.stringify([q, [[`${q} free`, 0], [`${q} online`, 0], [`best ${q}`, 0], [`${q} app`, 0]]]), { status: 200 });
      }
      throw new Error("unexpected " + u.slice(0, 60));
    }) as unknown as typeof fetch;
    const { runRootProbe, nextRootBatch, TOOL_ROOTS, AI_ROOTS } = await import("../core/seen-dig");
    assert.equal(TOOL_ROOTS.length, 34, "34 个工具词根");
    assert.ok(AI_ROOTS.length >= 5, "AI 词根若干");
    const first = nextRootBatch(undefined, 6);
    assert.equal(first.batch.length, 6, "首批 6 词根");
    assert.equal(first.wrap, false);
    const s = await runRootProbe(db, fakeFetch, { perDay: 6, intervalMs: 0 });
    assert.equal(s.requests, 6);
    assert.equal(s.newTerms, 24, "6 词根 × 前 4 条联想（mock 每根 4 条）");
    const term = db.get<any>("seen-terms", "generatorfree");
    assert.ok(term, "联想词入库（termId 去空格）");
    assert.equal(term.seed, "generator", "seed=词根血缘");
    assert.equal(term.sources[0], "root-probe");
    assert.equal(term.region, "global", "root-probe 源判 global");
    const cursor = db.get<any>("meta", "root-probe-cursor");
    assert.equal(cursor.roots.length, 6, "cursor 推进 6 词根");
    const second = nextRootBatch(cursor, 6);
    assert.equal(second.batch.length, 6);
    assert.ok(!second.batch.some((r: string) => cursor.roots.includes(r)), "轮转不重复");
    // 全部拉完后 wrap 重置
    const db2cursor = { roots: [...TOOL_ROOTS, ...AI_ROOTS] };
    const wrapped = nextRootBatch(db2cursor, 6);
    assert.equal(wrapped.wrap, true, "全拉完重置");
    assert.equal(wrapped.batch[0], TOOL_ROOTS[0]);
  } finally {
    db?.close();
    cleanup(dir);
  }
});
