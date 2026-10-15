// 第七轮批 2 守护：W7-3 哥飞 SEO 适配器（门控/预算/归一/补查升级/serp 档位补位）
// + W7-5 机会卡 form 形态字段（枚举归一/生成赋值/价值数据）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import {
  seoSourceOf, seoSourceEnabled, seoBudgetLeft, seoBudgetUsed, SeoSourceOffError,
  fetchKeywordMetrics, fetchSerp, normalizeKeywordMetrics, normalizeSerpResults, GEPHEI_ENDPOINTS,
} from "../core/seo-source";
import { gepheiTierOf } from "../core/seen-judge";
import { evalSiteGate, valueScoreOf, siteGateAutoMark, DEFAULT_SITE_GATE } from "../core/seo-gate";
import { generateOpportunities, normalizeForm } from "../core/opportunity";
import { migrations } from "../core/store/migrations";
import { termId } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const enableSeo = (db: Store, budgets: { tier?: number; metrics?: number; collect?: number } = {}) =>
  db.put("config", "seoDataSource", { enabled: true, token: "test-token", builtinTierBudget: budgets.tier ?? 60, builtinMetricsBudget: budgets.metrics ?? 200, builtinCollectBudget: budgets.collect ?? 100 });

// mock 哥飞端点：三指标 / serp（带流量）/ domain_traffic
function mockGephei(overrides: { volume?: number; kd?: number; cpc?: number } = {}) {
  const calls: string[] = [];
  const fakeFetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(u);
    const body = JSON.parse(init?.body || "{}");
    const kw = (body.keywords || [])[0] || body.keyword || "";
    if (u.includes("keyword_volume")) return new Response(JSON.stringify([{ keyword: kw, volume: overrides.volume ?? 1000, cpc: overrides.cpc ?? 0.5 }]), { status: 200 });
    if (u.includes("bulk_keyword_difficulty")) return new Response(JSON.stringify([{ keyword: kw, difficulty: overrides.kd ?? 10 }]), { status: 200 });
    if (u.includes("keyword_difficulty")) return new Response(JSON.stringify([{ keyword: kw, difficulty: overrides.kd ?? 10 }]), { status: 200 });
    if (u.includes("search_intent")) return new Response(JSON.stringify([{ keyword: kw, intent: "commercial" }]), { status: 200 });
    if (u.includes(GEPHEI_ENDPOINTS.serp)) return new Response(JSON.stringify({ data: [
      { domain: "en.wikipedia.org", rank: 1, traffic: 500000 },
      { domain: "github.com", rank: 2, traffic: 50000 },
      { domain: "tinyblog.example.com", rank: 3, traffic: 300 },
    ] }), { status: 200 });
    if (u.includes("domain_traffic")) return new Response(JSON.stringify({ visits: 30000 }), { status: 200 });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  return { fakeFetch, calls };
}

// ---- W7-3 适配器 ----

test("适配器门控：关闭时零外部调用（fetch 计数 0）；开启后三指标归一合并 + 预算记账", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2gate-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const { fakeFetch, calls } = mockGephei();
    // 关闭（默认）：一切方法不碰网络
    assert.equal(seoSourceEnabled(db), false, "默认关闭");
    assert.deepEqual([...(await fetchKeywordMetrics(db, ["tool word"], fakeFetch)).keys()], [], "关闭时返回空");
    await assert.rejects(fetchSerp(db, "tool word", fakeFetch), SeoSourceOffError, "关闭时 serp 拒绝");
    assert.equal(calls.length, 0, "关闭时零外部调用");
    // 开启：三接口并行 + 归一合并
    enableSeo(db);
    const m = await fetchKeywordMetrics(db, ["tool word"], fakeFetch);
    const metrics = m.get("tool word");
    assert.equal(metrics?.monthlySearch, 1000);
    assert.equal(metrics?.kd, 10);
    assert.equal(metrics?.cpc, 0.5);
    assert.equal(metrics?.intent, undefined, "search_intent 内置化（批4②不自动查哥飞意图）");
    assert.equal(calls.length, 2, "双接口各一次（volume+difficulty，intent 内置化）");
    assert.equal(seoBudgetUsed(db, "metrics"), 2, "按次计预算（一批 volume+kd 共 2 次，R8-3）");
    // 全门槛判定路径：带 gepheiFetchedAt 的新鲜指标 → full 达标
    const term = { relevance: "strong", region: "global", serpDedicated: 0, ...metrics, gepheiFetchedAt: new Date().toISOString() };
    const verdict = evalSiteGate(term, DEFAULT_SITE_GATE);
    assert.equal(verdict.pass, true);
    assert.ok(verdict.reason.includes("全门槛达标"), "哥飞指标落库后升级全门槛");
    assert.equal(valueScoreOf(term), Math.round(1000 * 0.5 / Math.max(1, 10) * 10) / 10, "价值分 = 月搜×CPC÷KD");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("积分断路器（R8-3 按次）：预算不足一对请求（<2 次）→ 零调用；额度尽后续空手而回", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2budget-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db, { metrics: 1 });
    const { fakeFetch, calls } = mockGephei();
    // 一批=volume+kd 共 2 次，预算 1 次凑不齐一对 → 直接不发（半批比不发更浪费）
    const m = await fetchKeywordMetrics(db, ["词一", "词二"], fakeFetch);
    assert.equal(m.size, 0, "预算 <2 次零调用");
    assert.equal(seoBudgetUsed(db, "metrics"), 0);
    assert.equal(seoBudgetLeft(db, "metrics"), 1);
    // 充值到 5 次：词三单批（+2）成功后剩 3，词四再一批（+2）后剩 1 → 凑不齐一对
    db.put("config", "seoDataSource", { enabled: true, token: "test-token", builtinTierBudget: 60, builtinMetricsBudget: 5, builtinCollectBudget: 100, autoMetrics: true, autoCollect: false });
    const m2 = await fetchKeywordMetrics(db, ["词三"], fakeFetch);
    assert.equal(m2.size, 1, "剩 3 次可发一批");
    const m3 = await fetchKeywordMetrics(db, ["词四"], fakeFetch);
    assert.equal(m3.size, 1, "剩 3 次再发一批");
    const before = calls.length;
    const m4 = await fetchKeywordMetrics(db, ["词五"], fakeFetch);
    assert.equal(m4.size, 0, "剩 1 次凑不齐一对零调用");
    assert.equal(calls.length, before, "额度尽零调用");
    assert.equal(seoBudgetUsed(db, "metrics"), 4, "4 次额度对齐");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("响应归一：三指标兼容 {data}/数组/entries-map 三形状；serp 抽 host+流量", () => {
  assert.equal(normalizeKeywordMetrics({ volume: 900, difficulty: 3, cpc: 0.2, intent: "informational" }).monthlySearch, 900);
  assert.equal(normalizeKeywordMetrics({ data: { search_volume: 500, kd: 7 } }).monthlySearch, 500);
  assert.equal(normalizeKeywordMetrics([{ volume: 100 }]).monthlySearch, 100, "数组形状取首项");
  assert.deepEqual(normalizeKeywordMetrics(null), {});
  const serp = normalizeSerpResults({ organic: [{ domain: "Example.com", url: "https://example.com/x", traffic: 12000 }, { url: "https://sub.foo.dev/" }] });
  assert.equal(serp[0]?.host, "example.com");
  assert.equal(serp[0]?.traffic, 12000);
  assert.equal(serp[1]?.host, "sub.foo.dev");
  assert.equal(serp.length, 2);
});

test("gepheiTierOf：serp 结果带流量直接派生档位并缓存（source=gephei）；预算记账", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2tier-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db);
    const { fakeFetch, calls } = mockGephei();
    const tier = await gepheiTierOf("tool word", ["en.wikipedia.org", "github.com", "tinyblog.example.com"], db, fakeFetch);
    assert.equal(tier, "large", "前 3 名最强档位");
    assert.equal(calls.filter((u) => u.includes(GEPHEI_ENDPOINTS.serp)).length, 1, "serp 一次调用");
    assert.equal(seoBudgetUsed(db, "tier"), 1, "按调用计预算（tier 池）");
    const cached = db.get<any>("web-traffic", "en.wikipedia.org");
    assert.equal(cached?.tier, "large");
    assert.equal(cached?.source, "gephei", "权威源标记");
    assert.equal(cached?.visits, 500000);
    // 缓存命中路径：host 已有档位时不再调 serp（由 seenJudgeTick 链负责，此处验 cached 读侧行为一致）
    assert.equal(cached.tier, "large");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-3 补查升级（siteGateAutoMark enrich）----

test("siteGateAutoMark 哥飞补查：降级达标词拉指标落库并按全门槛重判——达标出标带指标、不达标不出标", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2enrich-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    enableSeo(db);
    // 达标指标词
    db.put("seen-terms", "达标词", { id: "达标词", term: "达标词", status: "rising", observations: 9, sources: ["hn"], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "", relevance: "strong", region: "global", serpDedicated: 0 });
    const { fakeFetch } = mockGephei({});
    const r = await siteGateAutoMark(db, fakeFetch);
    assert.equal(r.marked, 1);
    assert.equal(r.enriched, 1, "补查记账");
    const seo = db.get<any>("seo-terms", "达标词");
    assert.equal(seo.siteCandidate, true);
    assert.equal(seo.monthlySearch, 1000, "指标随出标落 seo-terms");
    assert.equal(seo.kd, 10);
    assert.equal(seo.cpc, 0.5);
    assert.ok(seo.gepheiFetchedAt, "gepheiFetchedAt 时间戳落库");
    assert.ok(String(seo.siteRationale).includes("全门槛达标"), "升级为全门槛口径");
    const seen = db.get<any>("seen-terms", "达标词");
    assert.equal(seen.monthlySearch, 1000, "词库（seen-terms）同落指标（W7-8 同口径）");
    assert.equal(seen.intent, undefined, "批4②：意图不自动查（内置 AI 标注为准）");
    // 不达标指标词：全门槛未达 → 不出标
    db.put("seen-terms", "弱价值词", { id: "弱价值词", term: "弱价值词", status: "rising", observations: 9, sources: ["hn"], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "", relevance: "strong", region: "global", serpDedicated: 0 });
    const { fakeFetch: lowFetch } = mockGephei({ volume: 100 });
    const r2 = await siteGateAutoMark(db, lowFetch);
    assert.equal(r2.marked, 0, "全门槛未达不出标");
    assert.equal(r2.enriched, 1, "补查照常记账");
    assert.equal(db.get<any>("seo-terms", "弱价值词"), undefined);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("siteGateAutoMark 无数据源：保持批1 降级出标（免费路径不回退）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2free-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "免费词", { id: "免费词", term: "免费词", status: "rising", observations: 9, sources: ["hn"], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "", relevance: "strong", region: "global", serpDedicated: 0 });
    const { fakeFetch, calls } = mockGephei();
    const r = await siteGateAutoMark(db, fakeFetch);
    assert.equal(r.marked, 1, "降级口径出标");
    assert.equal(r.enriched, 0, "未配置不补查");
    assert.equal(calls.length, 0, "零外部调用");
    const seo = db.get<any>("seo-terms", "免费词");
    assert.ok(String(seo.siteRationale).includes("价值未验证"));
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- W7-5 form 形态字段 ----

test("normalizeForm：存量自由文案归一四枚举；内容线卡清空", () => {
  assert.equal(normalizeForm("web"), "web");
  assert.equal(normalizeForm("web 工具"), "web");
  assert.equal(normalizeForm("web 工具（额度监控 / 状态页 / 迁移工具 / 格式转换 择一）"), "web");
  assert.equal(normalizeForm("内容页 / 工具页"), "tool");
  assert.equal(normalizeForm("工具站"), "tool");
  assert.equal(normalizeForm("微信小程序"), "miniprogram");
  assert.equal(normalizeForm("移动 App"), "app");
  assert.equal(normalizeForm("公众号 内容页"), undefined, "内容线卡无产品形态");
  assert.equal(normalizeForm(undefined), undefined);
});

test("站群卡：form=tool；无新鲜指标打 valueUnverified；哥飞指标新鲜带 seoMetrics+价值分", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2form-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 无指标：valueUnverified 徽章路径
    db.put("seo-terms", "无指标词", { id: "无指标词", term: "无指标词", siteCandidate: true, siteRationale: "降级门槛达标" });
    // 有新鲜指标：价值分路径
    db.put("seo-terms", "有指标词", { id: "有指标词", term: "有指标词", siteCandidate: true, siteRationale: "全门槛达标", monthlySearch: 2000, kd: 20, cpc: 0.4, gepheiFetchedAt: new Date().toISOString() });
    generateOpportunities(db, { source: "agent" });
    const plain = db.list<any>("opportunities").find((o) => o.term === "无指标词");
    assert.ok(plain, "无指标词出卡");
    assert.equal(plain.form, "tool");
    assert.equal(plain.valueUnverified, true);
    assert.equal(plain.seoMetrics, undefined);
    const rich = db.list<any>("opportunities").find((o) => o.term === "有指标词");
    assert.ok(rich, "有指标词出卡");
    assert.equal(rich.form, "tool");
    assert.equal(rich.valueUnverified, undefined, "有指标无未验证徽章");
    assert.equal(rich.seoMetrics?.valueScore, Math.round(2000 * 0.4 / 20 * 10) / 10, "价值分 = 40");
    assert.equal(rich.seoMetrics?.monthlySearch, 2000);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("迁移 opportunity-form-v1：存量 form 文案归一枚举/清空；已是枚举的幂等跳过", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-b2mig-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const mk = (id: string, form: string | undefined) => db!.put("opportunities", id, {
      id, dedupeKey: "k:" + id, kind: "app", signals: ["news"], evidenceIds: [], title: id, oneLiner: "",
      form, verdict: "待验证", verdictReason: "", verifyPlan: [], source: "auto",
      createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z",
    });
    mk("opp-web", "web 工具");
    mk("opp-tool", "内容页 / 工具页");
    mk("opp-content", "公众号 内容页");
    mk("opp-enum", "tool");
    const m = migrations.find((x) => x.id === "opportunity-form-v1");
    assert.ok(m, "迁移已注册");
    m!.run({ kv: db.kv as any, directory: dir });
    assert.equal(db.get<any>("opportunities", "opp-web").form, "web");
    assert.equal(db.get<any>("opportunities", "opp-tool").form, "tool");
    assert.equal(db.get<any>("opportunities", "opp-content").form, undefined, "内容线卡清空");
    assert.equal(db.get<any>("opportunities", "opp-enum").form, "tool", "枚举幂等");
    // 幂等重跑不再变化
    m!.run({ kv: db.kv as any, directory: dir });
    assert.equal(db.get<any>("opportunities", "opp-content").form, undefined);
  } finally {
    db?.close();
    cleanup(dir);
  }
});
