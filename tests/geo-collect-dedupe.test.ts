// 第七轮批 3 守护：预算分池 / W7-1 rationale / W7-2 stale 保质期 / W7-8 哥飞指标日更 /
// W7-9 采集组（趋势周更/标杆站/外链反推/根词降频）/ W7-9.5 选题去重记忆 / origin 过滤。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { seoBudgetLeft, seoBudgetUsed, seoSpend } from "../core/seo-source";
import { judgeSeenTerm, termId } from "../core/seen-terms";
import { judgeUnjudgedTerms } from "../core/seen-extract";
import { isSerpStale, seenJudgeTick, SERP_STALE_DAYS } from "../core/seen-judge";
import { seoMetricsTick } from "../core/seo-gate";
import { trendsRisingTick, benchmarkSitesTick, linkProspectsTick, rootSlowdownReview, rootSlowdownOf, filterTrendWord } from "../core/gephei-collect";
import { nextRootBatch } from "../core/seen-dig";
import { tokenize, coverageOf, markCoveredVariants, coveredVariantDoc } from "../core/topic-dedupe";
import { querySeenTerms } from "../core/seen-terms";
import { generateOpportunities } from "../core/opportunity";
import { migrations } from "../core/store/migrations";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const enableSeo = (db: Store, budgets: { tier?: number; metrics?: number; collect?: number } = {}) =>
  db.put("config", "seoDataSource", { enabled: true, token: "test-token", builtinTierBudget: budgets.tier ?? 60, builtinMetricsBudget: budgets.metrics ?? 200, builtinCollectBudget: budgets.collect ?? 100, autoMetrics: true, autoCollect: true });

const mkTerm = (term: string, extra: Record<string, unknown> = {}) => ({
  id: termId(term), term, status: "rising", observations: 9,
  sources: ["hn-algolia"], relatedSearches: [], daysSeen: [],
  firstSeenAt: "2026-10-14T00:00:00Z", lastSeenAt: "2026-10-14T00:00:00Z",
  ...extra,
});

// ---- 预算分池 ----

test("预算分池：三池独立记账互不抢占（老大批3 拍板）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3pool-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db, { tier: 2, metrics: 5, collect: 3 });
    seoSpend(db, "tier", 2);
    assert.equal(seoBudgetLeft(db, "tier"), 0, "tier 池耗尽");
    assert.equal(seoBudgetLeft(db, "metrics"), 5, "metrics 池不受 tier 影响");
    assert.equal(seoBudgetLeft(db, "collect"), 3, "collect 池不受影响");
    seoSpend(db, "metrics", 1);
    assert.equal(seoBudgetUsed(db, "metrics"), 1);
    assert.equal(seoBudgetUsed(db, "tier"), 2);
    assert.equal(seoBudgetUsed(db, "collect"), 0, "未用池为零");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-1 rationale ----

test("判定 rationale（W7-1 增补）：回填判定判据落词库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3rat-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    db.put("seen-terms", "工具词", mkTerm("工具词"));
    db.put("seen-terms", "无判据词", mkTerm("无判据词"));
    const model = (async () => ({
      text: JSON.stringify([
        { term: "工具词", relevance: "strong", demandIntent: "tool", rationale: "命中 strong 的模型发布正例" },
        { term: "无判据词", relevance: "weak" },
      ]),
    })) as any;
    const judged = await judgeUnjudgedTerms(db, model);
    assert.equal(judged, 2);
    assert.equal(db.get<any>("seen-terms", "工具词").rationale, "命中 strong 的模型发布正例");
    assert.equal(db.get<any>("seen-terms", "无判据词").rationale, undefined, "模型未给不硬造");
    // judgeSeenTerm 直接写（提取路径同字段）
    db.put("seen-terms", "直接词", mkTerm("直接词"));
    judgeSeenTerm(db, "直接词", "strong", { demandIntent: "info", rationale: "教程类信号" });
    assert.equal(db.get<any>("seen-terms", "直接词").rationale, "教程类信号");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-2 stale ----

test("stale 保质期（W7-2 增补）：60 天回探针队列重测；payload 带 serpStale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3stale-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const fresh = new Date().toISOString();
    const staleAt = new Date(Date.now() - (SERP_STALE_DAYS + 5) * 86400000).toISOString();
    db.put("seen-terms", "新鲜词", mkTerm("新鲜词", { relevance: "strong", region: "global", serpDedicated: 0, serpCheckedAt: fresh }));
    db.put("seen-terms", "过期词", mkTerm("过期词", { relevance: "strong", region: "global", serpDedicated: 1, serpCheckedAt: staleAt }));
    assert.equal(isSerpStale({ serpCheckedAt: fresh }), false);
    assert.equal(isSerpStale({ serpCheckedAt: staleAt }), true, "超 60 天 stale");
    assert.equal(isSerpStale({}), false, "无观测时间不误判");
    // 队列：未查词 + stale 词入队；新鲜已查词不入队。mock fetch 快速跑一轮，stale 词应被重查刷新观测时间
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("searxng")) return new Response(JSON.stringify({ results: [{ url: "https://rival.vercel.app/", title: "R" }] }), { status: 200 });
      if (u.includes("suggestqueries.google.com")) return new Response('["q",[["x",0]]]', { status: 200 });
      if (u.includes("similarweb")) return new Response("{}", { status: 200 });
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    seenJudgeTick(db, fakeFetch, { backoffBaseMs: 1, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 250));
    const after = db!.get<any>("seen-terms", "过期词");
    assert.equal(typeof after.serpDedicated, "number", "stale 词保留重测能力");
    assert.ok(Date.parse(after.serpCheckedAt) > Date.parse(staleAt), "stale 词已重测刷新观测时间");
    const freshAfter = db!.get<any>("seen-terms", "新鲜词");
    assert.equal(freshAfter.serpCheckedAt, fresh, "新鲜词不重查");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-8 哥飞指标日更 ----

function mockGepheiFull(overrides: { volume?: number; kd?: number; cpc?: number } = {}) {
  const calls: string[] = [];
  const fakeFetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(u.replace("http://host.mock/api", ""));
    const body = JSON.parse(init?.body || "{}");
    const kw = (body.keywords || [])[0] || body.keyword || body.domain || "";
    if (u.includes("keyword_volume")) return new Response(JSON.stringify([{ keyword: kw, volume: overrides.volume ?? 880, cpc: overrides.cpc ?? 0.6 }]), { status: 200 });
    if (u.includes("bulk_keyword_difficulty")) return new Response(JSON.stringify([{ keyword: kw, difficulty: overrides.kd ?? 12 }]), { status: 200 });
    if (u.includes("keyword_difficulty")) return new Response(JSON.stringify([{ keyword: kw, difficulty: overrides.kd ?? 12 }]), { status: 200 });
    if (u.includes("search_intent")) return new Response(JSON.stringify([{ keyword: kw, intent: "commercial" }]), { status: 200 });
    if (u.includes("domain_availability")) return new Response(JSON.stringify({ data: [
      { domain: "zzmocktool.com", available: true }, { domain: "zzmocktool.io", available: true }, { domain: "zzmocktool.dev", available: false },
    ] }), { status: 200 });
    if (u.includes("trends_rising")) return new Response(JSON.stringify({ items: ["zz trend tool maker", "OpenAI trend thing", "ab"] }), { status: 200 });
    if (u.includes("site_keywords")) return new Response(JSON.stringify({ data: [
      { keyword: "gumroad alternative free", url: "https://gumroad.com/x", traffic: 5000, volume: 1200 },
      { keyword: "how to sell on gumroad", url: "https://gumroad.com/y", traffic: 900 },
    ] }), { status: 200 });
    if (u.includes("find_link_prospects")) return new Response(JSON.stringify({ data: [
      { domain: "indiehackers.com", dr: 80, traffic: 200000 },
      { domain: "somesite.net", dr: 30 },
    ] }), { status: 200 });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  return { fakeFetch, calls };
}

test("哥飞指标日更（W7-8）：批量补查落库+全门槛出标+域名清单+出卡触发；日闸；开关关零调用", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3daily-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const now = new Date().toISOString();
    db.put("seen-terms", termId("zz mock tool"), mkTerm("zz mock tool", { relevance: "strong", region: "global", serpDedicated: 0 }));
    // 开关关：零调用
    const { fakeFetch, calls } = mockGepheiFull();
    seoMetricsTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, 0, "开关关零调用");
    // 清闸键后开启
    db.del("meta", "seo-metrics-done:" + now.slice(0, 10));
    enableSeo(db, { metrics: 20 });
    seoMetricsTick(db, fakeFetch);
    // 轮询等待 fire-and-forget 批完成（tsx 动态 import 首次编译耗时不定）
    let seen: any;
    for (let i = 0; i < 40 && !db.get<any>("meta", "seo-metrics-done:" + now.slice(0, 10)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    seen = db.get<any>("seen-terms", "zzmocktool");
    assert.ok(seen, "日更批次完成键落盘");
    assert.equal(seen.monthlySearch, 880, "三指标落词库");
    assert.equal(seen.kd, 12);
    assert.equal(seen.intent, undefined, "批4②：意图不自动查（手动回传才落哥飞意图对照）");
    assert.ok(seen.gepheiFetchedAt, "时间戳");
    const seo = db.get<any>("seo-terms", "zz mock tool");
    assert.equal(seo.siteCandidate, true, "全门槛达标自动出标");
    assert.ok(String(seo.siteRationale).includes("全门槛达标"));
    assert.deepEqual(seo.domainSuggestions, ["zzmocktool.com", "zzmocktool.io"], "可注册域名清单落 doc");
    generateOpportunities(db, { source: "agent" });
    const card = db.list<any>("opportunities").find((o) => o.term === "zz mock tool" && o.dedupeKey?.startsWith("site:cand"));
    assert.ok(card, "出卡");
    assert.equal(card.seoMetrics?.valueScore, Math.round(880 * 0.6 / 12 * 10) / 10, "卡带价值分");
    assert.ok(Array.isArray(card.competitors), "卡带竞品档案结构");
    // 日闸：同日第二次不重跑
    const usedBefore = seoBudgetUsed(db, "metrics");
    seoMetricsTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seoBudgetUsed(db, "metrics"), usedBefore, "日闸幂等");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-9 采集组 ----

test("趋势周更（第十一步，周日）：trends_rising 注入 gephei-trends；过滤品牌/短词；根词降频随行", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3trend-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const sunday = new Date("2026-10-18T02:00:00Z"); // 周日
    const monday = new Date("2026-10-19T02:00:00Z");
    const { fakeFetch, calls } = mockGepheiFull();
    // 非周日零动作
    trendsRisingTick(db, fakeFetch, monday);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls.length, 0, "非周日不采集");
    // 周日：开关关也零调用
    trendsRisingTick(db, fakeFetch, sunday);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls.length, 0, "开关关零调用");
    enableSeo(db, { collect: 50 });
    trendsRisingTick(db, fakeFetch, sunday);
    await new Promise((r) => setTimeout(r, 150));
    const injected = db.list<any>("seen-terms").filter((t) => (t.sources || []).includes("gephei-trends"));
    assert.deepEqual(injected.map((t) => t.term).sort(), ["zz trend tool maker"], "英文/长度过滤+品牌过滤（OpenAI 词被滤、ab 过短）");
    assert.ok(injected.every((t) => t.status === "new"), "status=new");
    // 根词降频：零产出根词进名单，nextRootBatch 剔除
    const slow = rootSlowdownReview(db, sunday);
    assert.ok(slow.slowed.length > 0, "零产出根词进降频名单");
    const slowSet = rootSlowdownOf(db);
    const batch = nextRootBatch(undefined, 6, slowSet);
    assert.ok(batch.batch.every((r) => !slowSet.has(r)), "轮转剔除慢根");
    assert.equal(filterTrendWord("OpenAI trend thing"), undefined, "品牌过滤");
    assert.equal(filterTrendWord("ab"), undefined, "过短过滤");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("标杆站月更（第十二步）+ 外链反推（第十三步）：落库 benchmark-pages / link-prospects", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3bench-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db, { collect: 50 });
    const first = new Date("2026-10-01T02:00:00Z");
    const mid = new Date("2026-10-15T02:00:00Z");
    const { fakeFetch, calls } = mockGepheiFull();
    benchmarkSitesTick(db, fakeFetch, first);
    await new Promise((r) => setTimeout(r, 200));
    const sites = db.list<any>("benchmark-sites");
    assert.ok(sites.length >= 5, "种子标杆站就位");
    const pages = db.list<any>("benchmark-pages");
    assert.ok(pages.length >= 2, "页面数据落库");
    assert.ok(pages.every((p) => p.host && (p.keyword || p.url)), "页面字段完整");
    const gumroad = sites.find((s) => s.host === "gumroad.com");
    assert.ok(gumroad.lastAnalyzedAt, "分析时间戳");
    // 月闸：同月重跑不再采集
    const before = calls.length;
    benchmarkSitesTick(db, fakeFetch, new Date("2026-10-20T02:00:00Z"));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, before, "月闸幂等");
    // 外链反推（15 日）：市场快照（官方合同=卖链站挂牌榜单，按筛选器拉取）
    linkProspectsTick(db, fakeFetch, mid);
    await new Promise((r) => setTimeout(r, 150));
    const links = db.list<any>("link-prospects");
    assert.deepEqual(links.map((l) => l.host).sort(), ["indiehackers.com", "somesite.net"], "来源站落库");
    assert.equal(links.find((l) => l.host === "indiehackers.com")?.dr, 80, "DR 字段");
    assert.equal(links[0].fromTerm, "market-snapshot", "市场快照批次归属");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-9.5 选题去重记忆 ----

test("选题去重（W7-9.5）：核心词重合 ≥2/3 标已覆盖变体；不足不标；建簇口自动挂", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3dedup-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // P0-2：真实文档形狂用 decision（生产写入方字段），旧 fixture 用 status 与实现共享同一错误
    db.put("outlines", "out-1", { id: "out-1", title: "把会议纪要变成可核对的任务清单", decision: "approved", outline: ["检查负责人", "检查截止时间"], createdAt: "" });
    // 重合达标：中文贪心最长匹配——「会议纪要」+「任务清单」共享片段覆盖 ≥2/3
    const r = coverageOf("会议纪要转任务清单工具", { id: "out-1", title: "把会议纪要变成可核对的任务清单", text: "把会议纪要变成可核对的任务清单 检查负责人 检查截止时间" });
    assert.ok(r, "重合达标（中文片段覆盖）");
    assert.equal(r?.ratio >= 2 / 3, true);
    const cluster = { id: "clu-1", topic: "会议纪要转任务清单工具", coveredVariant: undefined };
    const rr = markCoveredVariants(db as any, cluster as any);
    assert.equal(rr.covered?.originId, "out-1", "标注指向原选题");
    // 建簇口语义：markCoveredVariants 纯计算，调用方合 coveredVariantDoc 后落库
    const c2 = { topic: "AI 会议纪要核对任务清单", coveredVariant: undefined };
    const r2 = markCoveredVariants(db as any, c2 as any);
    assert.ok(r2.covered, "clu-2 重合达标");
    const doc = { id: "clu-2", topic: c2.topic, coveredVariant: coveredVariantDoc(r2.covered!) };
    db.put("clusters", "clu-2", doc);
    const marked = db.get<any>("clusters", "clu-2");
    assert.equal(marked.coveredVariant?.originId, "out-1", "已覆盖变体指向原选题");
    assert.equal(marked.coveredVariant?.method, "keyword-2of3");
    // 重合不足不标
    const c3 = { topic: "宠物保险理赔攻略", coveredVariant: undefined };
    assert.equal(markCoveredVariants(db as any, c3 as any).covered, undefined, "无关簇不误标");
    // 已标注簇幂等跳过
    assert.equal(markCoveredVariants(db as any, marked).covered, undefined, "已有标注幂等保留首次");
    // 切词器：英文词元 + 中文整段
    assert.deepEqual(tokenize("会议纪要转任务清单"), ["会议纪要转任务清单"]);
    assert.ok(tokenize("the best AI meeting notes").includes("meeting"));
    assert.equal(coverageOf("meeting notes", { id: "x", title: "t", text: "AI meeting notes" })?.ratio, 1);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- origin 过滤 ----

test("词表来源层过滤（W7-10①）：origin=gephei/normal 下推 SQL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b3origin-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "常规词", mkTerm("常规词", { sources: ["hn-algolia"] }));
    db.put("seen-terms", "趋势词", mkTerm("趋势词", { sources: ["gephei-trends"] }));
    db.put("seen-terms", "拓词", mkTerm("拓词", { sources: ["gephei-ideas"] }));
    assert.equal(querySeenTerms(db.kv as any, { limit: 50, offset: 0, origin: "gephei" }).total, 2);
    assert.equal(querySeenTerms(db.kv as any, { limit: 50, offset: 0, origin: "normal" }).total, 1);
    assert.equal(querySeenTerms(db.kv as any, { limit: 50, offset: 0 }).total, 3);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- 迁移登记核对 ----

test("总纲：数据迁移已清除——迁移表不含 opportunity-form-v1 / r10-pipeline-v1（旧数据归档备查，不做变换）", () => {
  assert.ok(!migrations.find((m) => m.id === "opportunity-form-v1"), "form 归一迁移已随总纲移除");
  assert.ok(!migrations.find((m) => m.id === "r10-pipeline-v1"), "R10 调度关停迁移已随总纲移除");
});
