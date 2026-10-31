// 第七轮批 4 守护：付费接口双重门控（autoMetrics/autoCollect）+ 月池 + obs≥5 +
// search_intent 内置化 + newWordsTick + 手动回传（解析/落库/卡点亮/intentConflict）+ 深链常量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { seoBudgetLeft, seoBudgetUsed, seoSpend, parseManualGephei, gepheiToolLinks } from "../core/seo-source";
import { seoMetricsTick } from "../core/seo-gate";
import { benchmarkSitesTick, linkProspectsTick, newWordsTick, applyManualGephei } from "../core/gephei-collect";
import { nextRootBatch } from "../core/seen-dig";
import { buildRelevanceRubric } from "../core/seen-extract";
import { termId } from "../core/seen-terms";
import { writeAgentOpportunity } from "../core/opportunity";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const enableSeo = (db: Store, extra: Record<string, unknown> = {}) =>
  db.put("config", "seoDataSource", { enabled: true, token: "test-token", builtinTierBudget: 60, builtinMetricsBudget: 30, builtinCollectBudget: 100, autoMetrics: false, autoCollect: false, ...extra });

const mkStrong = (db: Store, term: string, obs: number, extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  db.put("seen-terms", termId(term), { id: termId(term), term, status: "rising", observations: obs, sources: ["hn"], relatedSearches: [], daysSeen: [now.slice(0, 10)], firstSeenAt: now, lastSeenAt: now, relevance: "strong", region: "global", serpDedicated: 0, createdAt: now, updatedAt: now, ...extra });
};

function mockGepheiFull(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fakeFetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(u.replace("https://seo.web.cafe/api/v1", ""));
    const body = JSON.parse(init?.body || "{}");
    const kw = (body.keywords || [])[0] || body.keyword || body.domain || body.target || "";
    if (u.includes("keyword_volume")) return new Response(JSON.stringify({ ok: true, data: [{ keyword: kw, volume: overrides.volume ?? 880, cpc: overrides.cpc ?? 0.6 }] }), { status: 200 });
    if (u.includes("bulk_keyword_difficulty") || u.includes("keyword_difficulty")) return new Response(JSON.stringify({ ok: true, data: [{ keyword: kw, difficulty: overrides.kd ?? 12 }] }), { status: 200 });
    if (u.includes("search_intent")) return new Response(JSON.stringify({ ok: true, data: [{ keyword: kw, intent: "commercial" }] }), { status: 200 });
    if (u.includes("keywords/batches?page=") || u.endsWith("/keywords/batches")) {
      const page = u.includes("page=") ? "" : "";
      void page;
      return new Response(JSON.stringify({ ok: true, data: { batches: [{ id: "2026-10-14T0838", keyword_count: 3 }] } }), { status: 200 });
    }
    if (u.includes("keywords/batches/")) return new Response(JSON.stringify({ ok: true, data: { keywords: [
      { keyword: "zz trend tool maker", kind: "new", verdict: "maybe" },
      { keyword: "OpenAI thing", kind: "new" },
      { keyword: "ab", kind: "new" },
    ] } }), { status: 200 });
    if (u.includes("site_keywords")) return new Response(JSON.stringify({ ok: true, data: [{ keyword: "gumroad alt", url: "https://gumroad.com/x", traffic: 5000 }] }), { status: 200 });
    if (u.includes("find_link_prospects")) return new Response(JSON.stringify({ ok: true, data: [{ domain: "indiehackers.com", dr: 80 }] }), { status: 200 });
    if (u.includes("domain_availability")) return new Response(JSON.stringify({ data: [{ domain: "zzmocktool.com", available: true }] }), { status: 200 });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  return { fakeFetch, calls };
}

// ---- ① 双重门控 + 月池 + obs≥5 ----

test("双重门控（W7-11①）：autoMetrics 关=tick 零调用；开=恢复且按 obs≥5 过滤；metrics 月池跨日累计", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b4gate-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const { fakeFetch, calls } = mockGepheiFull();
    // 开关开但未授权 autoMetrics（默认关）→ 零调用
    enableSeo(db);
    mkStrong(db!, "zzb4 en target", 9);
    mkStrong(db!, "zzb4 weak obs", 2);
    seoMetricsTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, 0, "autoMetrics 关=零调用");
    // 勾选授权 → 自动查恢复，obs≥5 过滤（观测不足词不查）
    enableSeo(db, { autoMetrics: true });
    db.del("meta", "seo-metrics-done:" + new Date().toISOString().slice(0, 10));
    seoMetricsTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 200));
    const seen = db.get<any>("seen-terms", termId("zzb4 en target"));
    assert.equal(seen?.monthlySearch, 880, "授权后自动查落库");
    assert.equal(db.get<any>("seen-terms", termId("zzb4 weak obs"))?.monthlySearch, undefined, "obs<5 不查");
    assert.ok(calls.some((u) => u.includes("keyword_volume")), "三指标调用");
    assert.ok(!calls.some((u) => u.includes("search_intent")), "search_intent 永久内置 AI（批4②不自动查）");
    // 月池：不同日期同月累计（在 tick 已消耗基础上 +20；次月重置）
    const usedBefore = seoBudgetUsed(db, "metrics");
    seoSpend(db, "metrics", 10, new Date("2026-10-05T00:00:00Z"));
    seoSpend(db, "metrics", 10, new Date("2026-10-25T00:00:00Z"));
    assert.equal(seoBudgetUsed(db, "metrics", new Date("2026-10-20T00:00:00Z")), usedBefore + 20, "同月跨日累计");
    assert.equal(seoBudgetLeft(db, "metrics", new Date("2026-10-20T00:00:00Z")), Math.max(0, 30 - usedBefore - 20), "月池 30 扣减");
    assert.equal(seoBudgetUsed(db, "metrics", new Date("2026-11-01T00:00:00Z")), 0, "次月重置");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- ⑤ autoCollect 门控 ----

test("autoCollect 门控（W7-11⑤）：标杆站/外链反推需勾选授权", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b4coll-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const first = new Date("2026-10-01T02:00:00Z"); // 周四
    const { fakeFetch, calls } = mockGepheiFull();
    enableSeo(db, { collect: 10 });
    benchmarkSitesTick(db, fakeFetch, first);
    linkProspectsTick(db, fakeFetch, first);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, 0, "autoCollect 关=零调用");
    enableSeo(db, { autoCollect: true });
    benchmarkSitesTick(db, fakeFetch, first);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(calls.some((u) => u.includes("site_keywords")), "授权后标杆站采集");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- ③ newWordsTick ----

test("新词发现批次（W7-11③）：latest 批注入 gephei-newwords；免费接口不占 collect 池；品牌/短词过滤", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b4nw-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db);
    const { fakeFetch, calls } = mockGepheiFull();
    const now = new Date("2026-10-14T10:00:00Z");
    newWordsTick(db, fakeFetch, now);
    for (let i = 0; i < 30 && !db.get<any>("meta", "geo-newwords-done:" + now.toISOString().slice(0, 10)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const injected = db.list<any>("seen-terms").filter((t) => (t.sources || []).includes("gephei-newwords"));
    assert.deepEqual(injected.map((t) => t.term).sort(), ["zz trend tool maker"], "过滤品牌（OpenAI）/过短（ab）");
    assert.ok(injected.every((t) => (t.seed || "").startsWith("gephei-newwords:")), "seed=批次血缘");
    assert.equal(seoBudgetUsed(db, "collect"), 0, "免费接口不占 collect 池");
    assert.ok(calls.some((u) => u.includes("keywords/batches")), "batches 调用");
    // 批次幂等：同批再跑不重复注入（done 键已带批次标记）
    const before = db.list<any>("seen-terms").length;
    newWordsTick(db, fakeFetch, now);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(db.list<any>("seen-terms").length, before, "同批幂等");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- ④② 手动回传 ----

test("手动回传解析（W7-11④）：JSON/文本双模式", () => {
  const jsonMode = parseManualGephei('[{"keyword":"ai agent","volume":880,"kd":12,"cpc":0.6,"intent":"commercial"}]');
  assert.equal(jsonMode.mode, "json");
  assert.deepEqual(jsonMode.items[0], { term: "ai agent", monthlySearch: 880, kd: 12, cpc: 0.6, intent: "commercial" });
  const textMode = parseManualGephei("ai agent\t880\t12\t0.6\n第二词 | 500 | 20 | 0.3");
  assert.equal(textMode.mode, "text");
  assert.equal(textMode.items.length, 2);
  assert.deepEqual(textMode.items[1], { term: "第二词", monthlySearch: 500, kd: 20, cpc: 0.3 });
  assert.equal(parseManualGephei("").items.length, 0);
});

test("手动回传落库（W7-11④）：✋manual-gephei 落指标字段+seo-terms 同步+卡点亮+intentConflict+最近记录", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b4manual-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 已出标词（站群卡在库）
    const now = new Date().toISOString();
    db.put("seen-terms", termId("已标回传词"), { id: termId("已标回传词"), term: "已标回传词", status: "sustained", observations: 9, sources: ["hn"], relatedSearches: [], daysSeen: [], firstSeenAt: now, lastSeenAt: now, relevance: "strong", region: "global", serpDedicated: 0, intent: "informational", createdAt: now, updatedAt: now });
    db.put("seo-terms", "已标回传词", { id: "已标回传词", term: "已标回传词", siteCandidate: true, siteCandidateBy: "builtin-gate-v1", siteRationale: "降级门槛达标" });
    // R10.40：卡片唯一写口=agent（回传点亮 agent 卡的价值面板）
    writeAgentOpportunity(db, { title: "已标回传词", oneLiner: "站群候选（siteCandidate 标注）", form: "site-group", term: "已标回传词" });
    const cardBefore = db.list<any>("opportunities").find((o) => o.term === "已标回传词");
    assert.ok(cardBefore, "agent 卡在库");
    // 手动回传（JSON，带 intent 与内置 informational 冲突）
    const r = applyManualGephei(db, '[{"keyword":"已标回传词","volume":880,"kd":12,"cpc":0.6,"intent":"commercial"}]');
    assert.equal(r.applied, 1);
    assert.equal(r.cardsLit, 1, "站群卡价值面板点亮");
    assert.equal(r.intentConflicts, 1, "意图冲突标记");
    const seen = db.get<any>("seen-terms", termId("已标回传词"));
    assert.equal(seen.monthlySearch, 880);
    assert.ok(seen.manualAt, "manualAt 落库");
    assert.ok((seen.sources || []).includes("manual-gephei"), "✋来源");
    assert.ok(seen.gepheiFetchedAt, "复用新鲜度通道（价值分可算）");
    assert.deepEqual(seen.intentConflict && { manual: seen.intentConflict.manual, builtin: seen.intentConflict.builtin }, { manual: "commercial", builtin: "informational" });
    // seo-terms 同步 + 卡面
    const seo = db.get<any>("seo-terms", "已标回传词");
    assert.equal(seo.monthlySearch, 880);
    const card = db.list<any>("opportunities").find((o) => o.term === "已标回传词");
    assert.equal(card?.seoMetrics?.valueScore, Math.round(880 * 0.6 / 12 * 10) / 10);
    assert.equal(card.valueUnverified, undefined, "徽章熄灭");
    // ✋ 幂等：已有手动数据的词不覆盖
    const r2 = applyManualGephei(db, '[{"keyword":"已标回传词","volume":1,"kd":99,"cpc":0.01}]');
    assert.equal(r2.applied, 0, "✋权重最高不覆盖");
    assert.equal(db.get<any>("seen-terms", termId("已标回传词")).monthlySearch, 880);
    // 新词回传（词不在库）
    applyManualGephei(db, "新回传词\t500\t20\t0.3");
    assert.ok(db.get<any>("seen-terms", termId("新回传词")), "新词直接创建");
    // 最近记录
    const rec = db.get<any>("meta", "manual-gephei-recent");
    assert.ok(Array.isArray(rec) && rec.length >= 2 && rec[0].applied >= 1, "最近回传记录（cap 3）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- ① 深链常量 ----

test("深链常量（W7-11①⑥）：实测路径 /kd/ /ideas/ /serp/ /sitekw/ /traffic/ /worth/ /dr/，kw 预填", () => {
  const links = gepheiToolLinks("ai agent");
  assert.equal(links.length, 7);
  assert.equal(links[0].url, "https://seo.web.cafe/kd/?kw=ai%20agent");
  assert.equal(links[1].url, "https://seo.web.cafe/ideas/?kw=ai%20agent");
  assert.equal(links[2].url, "https://seo.web.cafe/serp/?kw=ai%20agent");
  assert.ok(links.every((l) => l.url.startsWith("https://seo.web.cafe/") && !l.url.includes("/tools/")), "禁止臆造 /tools/ 路径");
});

// ---- ⑦ prompt 瘦身（参照句）----

test("判定 prompt 含 SKILL.md 参照句（W7-11⑦），标尺本体保留", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b4prompt-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const rubric = buildRelevanceRubric(db);
    assert.ok(rubric.includes("skills/seo-methodology/SKILL.md"), "方法论参照句");
    assert.ok(rubric.includes("relevance 三档标准"), "标尺本体不减");
    assert.ok(rubric.includes("strong："), "三档标准保留");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- 根词降频回归（批4 门控不影响既有轮转）----

test("根词轮转回归：慢根剔除后批次仍产词", () => {
  const slow = new Set(["generator"]);
  const { batch } = nextRootBatch(undefined, 6, slow);
  assert.ok(!batch.includes("generator"), "慢根剔除");
  assert.equal(batch.length, 6);
});
