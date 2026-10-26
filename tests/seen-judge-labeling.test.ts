// 第七轮批 1 守护：W7-1 demandIntent 意图三分类 / W7-2 SERP 竞争观测结构化
// （serpTop10Home + serpTop3Tier）/ W7-4 siteGate 站群门槛 + 自动标注 / W7附 off 即归档。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { judgeSeenTerm, observeSeenTerm, termId } from "../core/seen-terms";
import { buildRelevanceRubric, judgeUnjudgedTerms, intentPolicySection } from "../core/seen-extract";
import { seenJudgeTick, trafficTierOf, top10HomeCount, maxTrafficTier } from "../core/seen-judge";
import {
  siteGateOf, DEFAULT_SITE_GATE, evalSiteGate, siteGateAutoMark, siteCandidateEligibleOf,
} from "../core/seo-gate";
import { migrations } from "../core/store/migrations";

const SW_PER_BATCH_BUDGET = 20;

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const mkTerm = (term: string, extra: Record<string, unknown> = {}) => ({
  id: termId(term), term, status: "rising", observations: 9,
  sources: ["hn-algolia"], relatedSearches: [], daysSeen: [],
  firstSeenAt: "2026-10-14T00:00:00Z", lastSeenAt: "2026-10-14T00:00:00Z",
  ...extra,
});

// ---- W7附 off 即归档 ----

test("off 即归档（W7附）：judgeSeenTerm 判 off 同步 archived + relevance-off-auto；归档词不可再判", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7off-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "圈外词", mkTerm("圈外词", { relevance: "weak" }));
    const doc = judgeSeenTerm(db, "圈外词", "off");
    assert.equal(doc?.status, "archived", "off 判定同步归档");
    assert.equal(doc?.archivedReason, "relevance-off-auto");
    assert.equal(doc?.offTopic, true);
    // 归档词头部守卫：strong/weak 都写不回去（回捞走人工）
    assert.equal(judgeSeenTerm(db, "圈外词", "strong"), undefined, "归档词不可再判");
    assert.equal(db.get<any>("seen-terms", "圈外词").relevance, "off");
    // strong 判定不归档，extras.demandIntent 只在 strong 落库
    db.put("seen-terms", "工具词", mkTerm("工具词"));
    const strong = judgeSeenTerm(db, "工具词", "strong", { demandIntent: "tool" });
    assert.equal(strong?.status, "rising", "strong 不归档");
    assert.equal(strong?.demandIntent, "tool");
    // 未传 extras 保留旧 demandIntent（同档 strong 早退无副作用）
    assert.equal(db.get<any>("seen-terms", "工具词").demandIntent, "tool");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("存量迁移 seen-off-archive-v1：已固化为 no-op 占位（R10.25-6）——归档职责在判定层「判 off 即 archived」", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7mig-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "存量off词", mkTerm("存量off词", { relevance: "off", offTopic: true }));
    db.put("seen-terms", "存量strong词", mkTerm("存量strong词", { relevance: "strong" }));
    const m = migrations.find((x) => x.id === "seen-off-archive-v1");
    assert.ok(m, "迁移号占位保留");
    m!.run({ kv: db.kv as any, directory: dir });
    // no-op 语义：迁移不再搬数据（活库存量已于 W7 附清偿；新 off 词由判定层直接落 archived）
    assert.notEqual(db.get<any>("seen-terms", "存量off词").status, "archived", "固化后迁移不触碰数据");
    assert.equal(db.get<any>("seen-terms", "存量strong词").status, "rising", "非 off 词不动");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-1 demandIntent 意图三分类 ----

test("intentPolicy 标尺（W7-1）：默认三分类拼入 rubric；persona.intentPolicy 覆盖；与 termPolicy 共存", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7intent-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 默认：内置三分类定义 + 输出规则
    const fallback = buildRelevanceRubric(db);
    assert.ok(fallback.includes("demandIntent 意图三分类"), "意图节拼入");
    assert.ok(fallback.includes("generator/converter/calculator"), "tool 词根族默认定义");
    assert.ok(fallback.includes("demandIntent 必填"), "输出规则");
    assert.equal(intentPolicySection(db).split("\n")[0], "## demandIntent 意图三分类（relevance=strong 的词必填 demandIntent）");
    // 自定义 intentPolicy 整节替换
    db.put("config", "persona", {
      intentPolicy: { tool: "能做成付费小工具的词", info: "纯科普", nav: "找官网" },
      termPolicy: { strongHint: "生财搞钱", weakHint: "沾边", offHint: "圈外" },
    });
    const customized = buildRelevanceRubric(db);
    assert.ok(customized.includes("能做成付费小工具的词"), "自定义 tool hint 覆盖");
    assert.ok(!customized.includes("generator/converter/calculator"), "内置 tool 定义被替换");
    assert.ok(customized.includes("生财搞钱"), "termPolicy 三档标准共存");
    assert.ok(customized.includes("demandIntent 意图三分类"), "意图节仍在");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("judgeUnjudgedTerms 产出 demandIntent（W7-1）：strong 落库 / weak 忽略 / tool 直通候选池", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7judge-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    db.put("seen-terms", "转换器词", mkTerm("转换器词"));
    db.put("seen-terms", "资讯词", mkTerm("资讯词"));
    const model = (async () => ({
      text: JSON.stringify([
        { term: "转换器词", relevance: "strong", demandIntent: "tool" },
        { term: "资讯词", relevance: "weak", demandIntent: "tool" }, // weak 的 intent 应被忽略
      ]),
    })) as any;
    const judged = await judgeUnjudgedTerms(db, model);
    assert.equal(judged, 2);
    assert.equal(db.get<any>("seen-terms", "转换器词").demandIntent, "tool", "strong 落 demandIntent");
    assert.equal(db.get<any>("seen-terms", "资讯词").demandIntent, undefined, "weak 忽略 demandIntent");
    // 意图通道：strong+tool 直通候选池（无需 SERP 数据）；info 不直通
    assert.equal(siteCandidateEligibleOf(db.get<any>("seen-terms", "转换器词")), true, "tool 型词直通");
    assert.equal(siteCandidateEligibleOf(db.get<any>("seen-terms", "资讯词")), false, "weak 不直通");
    assert.equal(
      siteCandidateEligibleOf({ region: "global", relevance: "strong", demandIntent: "info" }),
      false, "info 语义不直通",
    );
    // 非 global 一票否决；观测通道不受影响
    assert.equal(siteCandidateEligibleOf({ region: "cn", relevance: "strong", demandIntent: "tool" }), false);
    assert.equal(siteCandidateEligibleOf({ region: "global", observations: 5, sources: ["a", "b"] }), true, "观测通道保留");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-2 SERP 竞争观测结构化 ----

test("结构化观测原料：top10HomeCount / maxTrafficTier / trafficTierOf 缓存与预算", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7serp-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const hits = [
      { host: "a.com", url: "https://a.com/", title: "" },
      { host: "b.com", url: "https://b.com/blog/post-1", title: "" },
      { host: "c.com", url: "https://c.com/", title: "" },
    ];
    assert.equal(top10HomeCount(hits), 2, "首页 2 / 深页 1");
    assert.equal(top10HomeCount([]), 0);
    assert.equal(maxTrafficTier(["small", "large", undefined]), "large");
    assert.equal(maxTrafficTier([undefined, undefined]), undefined);
    // SW 缓存：成功档位落 web-traffic；失败也留档（当日不再重试）
    const traffic = new Map<string, number>([["big.com", 500000], ["mid.com", 50000], ["tiny.com", 300], ["dead.com", 0]]);
    let swCalls = 0;
    const fetchOk = (async (url: any) => {
      swCalls++;
      const domain = new URL(String(url)).searchParams.get("domain") || "";
      if (!traffic.has(domain)) return new Response("{}", { status: 200 }); // 无数据 → 失败档
      return new Response(JSON.stringify({ EstimatedMonthlyVisits: { "2026-10-01": traffic.get(domain) } }), { status: 200 });
    }) as unknown as typeof fetch;
    const budget = { left: SW_PER_BATCH_BUDGET };
    assert.equal(await trafficTierOf("big.com", db, fetchOk, budget), "large", ">10万 → large");
    assert.equal(await trafficTierOf("mid.com", db, fetchOk, budget), "mid", "1-10万 → mid");
    assert.equal(await trafficTierOf("tiny.com", db, fetchOk, budget), "small", "<1万 → small");
    assert.equal(await trafficTierOf("dead.com", db, fetchOk, budget), "none", "0 流量 → none");
    assert.equal(await trafficTierOf("unknown.com", db, fetchOk, budget), undefined, "无数据失败");
    const cachedCalls = swCalls;
    assert.equal(await trafficTierOf("big.com", db, fetchOk, budget), "large", "缓存命中");
    assert.equal(await trafficTierOf("unknown.com", db, fetchOk, budget), undefined, "失败当日不重试");
    assert.equal(swCalls, cachedCalls, "缓存/失败档不发新请求");
    assert.ok(db.get<any>("web-traffic", "big.com")?.tier, "成功档位入库");
    assert.ok(!db.get<any>("web-traffic", "unknown.com").tier, "失败档无 tier 字段");
    // 预算硬顶：预算耗尽后直接走缓存/undefined，不发请求
    const tightBudget = { left: 1 };
    const traffic2 = new Map<string, number>([["x1.com", 900000], ["x2.com", 900000]]);
    const fetch2 = (async (url: any) => {
      swCalls++;
      const domain = new URL(String(url)).searchParams.get("domain") || "";
      return new Response(JSON.stringify({ EstimatedMonthlyVisits: { "2026-10-01": traffic2.get(domain) } }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await trafficTierOf("x1.com", db, fetch2, tightBudget), "large");
    assert.equal(await trafficTierOf("x2.com", db, fetch2, tightBudget), undefined, "预算耗尽不探测");
    assert.equal(swCalls, cachedCalls + 1, "预算 1 → 只发 1 次");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("判定 tick 落结构化字段（W7-2）+ 批末 siteGate 自动标注（W7-4）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7tick-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "蓝海工具词", mkTerm("蓝海工具词", { relevance: "strong", region: "global" }));
    const FILTERED = JSON.stringify({ results: [
      { url: "https://rival-tool.vercel.app/", title: "Rival" },
    ] });
    const RAW = JSON.stringify({ results: [
      { url: "https://en.wikipedia.org/wiki/Tool", title: "Wiki" },
      { url: "https://github.com/some/repo", title: "Repo" },
      { url: "https://tinyblog.example.com/", title: "Blog" },
      { url: "https://news.example.com/post/1", title: "Deep" },
    ] });
    const trafficMap = new Map<string, number>([["en.wikipedia.org", 500000], ["github.com", 50000], ["tinyblog.example.com", 300]]);
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("searxng")) return new Response(u.includes("site%3A") ? FILTERED : RAW, { status: 200 });
      if (u.includes("suggestqueries.google.com")) return new Response('["q",[["蓝海工具词 free",0]]]', { status: 200 });
      if (u.includes("similarweb")) {
        const domain = new URL(u).searchParams.get("domain") || "";
        if (!trafficMap.has(domain)) return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ EstimatedMonthlyVisits: { "2026-10-01": trafficMap.get(domain) } }), { status: 200 });
      }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    seenJudgeTick(db, fakeFetch, { backoffBaseMs: 1, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const doc = db.get<any>("seen-terms", "蓝海工具词");
    assert.equal(doc.serpTop10Home, 1, "前 10 中首页 1 个（其余为 /wiki/x、/some/repo、/post/1 深页）");
    assert.equal(doc.serpTop3Tier, "large", "前 3 名最强档位 large");
    // siteGate 自动标注：strong + sd=1≤1 + global → 出标 builtin-gate-v1
    const seo = db.get<any>("seo-terms", "蓝海工具词");
    assert.ok(seo, "达标词应写入 seo-terms");
    assert.equal(seo.siteCandidate, true);
    assert.equal(seo.siteCandidateBy, "builtin-gate-v1");
    assert.ok(String(seo.siteRationale).includes("降级门槛"), "降级理由注明价值未验证");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-4 siteGate ----

test("evalSiteGate：降级/全门槛/一票否决三分支；siteGateOf 读 config 覆盖", () => {
  const base = { relevance: "strong", region: "global", serpDedicated: 0 };
  assert.equal(evalSiteGate(base, DEFAULT_SITE_GATE).pass, true, "降级：strong+零竞争+global");
  assert.ok(evalSiteGate(base, DEFAULT_SITE_GATE).reason.includes("价值未验证"));
  assert.equal(evalSiteGate({ ...base, region: "cn" }, DEFAULT_SITE_GATE).pass, false, "非 global 一票否决");
  assert.equal(evalSiteGate({ ...base, relevance: "weak" }, DEFAULT_SITE_GATE).pass, false, "requireStrong 拦 weak");
  assert.equal(evalSiteGate({ ...base, serpDedicated: 2 }, DEFAULT_SITE_GATE).pass, false, "竞争超上限");
  assert.equal(evalSiteGate({ relevance: "strong", region: "global" }, DEFAULT_SITE_GATE).pass, false, "SERP 未查不标");
  // 全门槛：三指标齐全 + gepheiFetchedAt 新鲜（90 天内）才启用（W7-3 权威源口径）
  const full = { ...base, monthlySearch: 1000, kd: 10, cpc: 0.5, gepheiFetchedAt: new Date().toISOString() };
  assert.equal(evalSiteGate(full, DEFAULT_SITE_GATE).pass, true, "全门槛达标");
  assert.ok(evalSiteGate(full, DEFAULT_SITE_GATE).reason.includes("全门槛达标"));
  assert.equal(evalSiteGate({ ...full, monthlySearch: 100 }, DEFAULT_SITE_GATE).pass, false, "月搜不足");
  assert.equal(evalSiteGate({ ...full, kd: 50 }, DEFAULT_SITE_GATE).pass, false, "KD 超标");
  assert.equal(evalSiteGate({ ...full, cpc: 0.01 }, DEFAULT_SITE_GATE).pass, false, "CPC 不足");
  assert.equal(evalSiteGate({ ...full, kd: undefined }, DEFAULT_SITE_GATE).pass, true, "指标缺失走降级");
  // 批2 新鲜度语义：无时间戳/过期时间戳的指标不作为全门槛原料
  const stale = { ...base, monthlySearch: 1000, kd: 10, cpc: 0.5, gepheiFetchedAt: new Date(Date.now() - 91 * 86400000).toISOString() };
  assert.equal(evalSiteGate(stale, DEFAULT_SITE_GATE).pass, true, "过期指标回退降级（仍 pass）");
  assert.ok(evalSiteGate(stale, DEFAULT_SITE_GATE).reason.includes("价值未验证"), "过期指标不按全门槛判");
  assert.ok(!evalSiteGate({ ...base, monthlySearch: 1000, kd: 10, cpc: 0.5 }, DEFAULT_SITE_GATE).reason.includes("全门槛达标"), "无时间戳不按全门槛判");
  // requireStrong=false 时 weak 也可达标
  const looseGate = { ...DEFAULT_SITE_GATE, requireStrong: false };
  assert.equal(evalSiteGate({ ...base, relevance: "weak" }, looseGate).pass, true);
  // config 覆盖
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7gate-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    assert.deepEqual(siteGateOf(db), DEFAULT_SITE_GATE, "默认 gate");
    db.put("config", "siteGate", { serpDedicatedMax: 0 });
    assert.equal(siteGateOf(db).serpDedicatedMax, 0, "config 覆盖生效");
    assert.equal(siteGateOf(db).monthlySearchMin, 300, "未覆盖字段保留默认");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("siteGateAutoMark：出标 builtin-gate-v1、不覆写外部标注、limit 硬顶、门槛跟随 config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-w7mark-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "达标词", mkTerm("达标词", { relevance: "strong", region: "global", serpDedicated: 0 }));
    db.put("seen-terms", "超限词", mkTerm("超限词", { relevance: "strong", region: "global", serpDedicated: 3 }));
    db.put("seen-terms", "弱词", mkTerm("弱词", { relevance: "weak", region: "global", serpDedicated: 0 }));
    db.put("seen-terms", "中文词", mkTerm("中文词", { relevance: "strong", region: "cn", serpDedicated: 0 }));
    db.put("seen-terms", "归档词", mkTerm("归档词", { relevance: "strong", region: "global", serpDedicated: 0, status: "archived" }));
    // 外部 Agent 已标注词（seo-terms 在库）：不覆写
    db.put("seo-terms", "外部标注词", { id: "外部标注词", term: "外部标注词", siteCandidate: true, siteRationale: "TypeScript→Rust 工具链需求", siteType: "工具站" });
    db.put("seen-terms", "外部标注词", mkTerm("外部标注词", { relevance: "strong", region: "global", serpDedicated: 0 }));
    // limit=1 硬顶：只标 1 个
    const r1 = await siteGateAutoMark(db, fetch, 1);
    assert.equal(r1.marked, 1, "limit 硬顶（列表 rowid 倒序，外部标注词跳过后标到达标词）");
    assert.ok(db.get<any>("seo-terms", "达标词")?.siteCandidate, "达标词出标 builtin-gate-v1");
    const r2 = await siteGateAutoMark(db, fetch);
    assert.equal(r2.marked, 0, "全库已标词不重复标注");
    // 外部标注词：不覆写 rationale / siteType
    const ext = db.get<any>("seo-terms", "外部标注词");
    assert.equal(ext.siteRationale, "TypeScript→Rust 工具链需求", "外部标注 rationale 保留");
    assert.equal(ext.siteType, "工具站");
    assert.equal(ext.siteCandidateBy, undefined, "外部标注不被打上 builtin 标");
    // 不达标词不标
    assert.equal(db.get<any>("seo-terms", "超限词"), undefined);
    assert.equal(db.get<any>("seo-terms", "弱词"), undefined);
    assert.equal(db.get<any>("seo-terms", "中文词"), undefined);
    assert.equal(db.get<any>("seo-terms", "归档词"), undefined);
    // 门槛收紧（serpDedicatedMax=0）：sd=1 的新词不再标
    db.put("config", "siteGate", { serpDedicatedMax: 0 });
    db.put("seen-terms", "紧门词条", mkTerm("紧门词条", { relevance: "strong", region: "global", serpDedicated: 1 }));
    assert.equal((await siteGateAutoMark(db, fetch)).marked, 0, "收紧后不达标不标");
    db.put("seen-terms", "零竞争词", mkTerm("零竞争词", { relevance: "strong", region: "global", serpDedicated: 0 }));
    assert.equal((await siteGateAutoMark(db, fetch)).marked, 1, "改 gate 数值行为跟随");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
