// R10 流水线守护：第1段 collectAllTick（当日闸/精简闸/归档恢复）、第2段默认全开与平台 9 值、
// 第3段 form 六值/新站复刻卡/消费回执。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r10-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { store } = await import("../core/store");
const { collectAllTick } = await import("../core/collect-all");
const { archiveNoneGroups, restoreArchived, triageTick } = await import("../core/triage");
const { COLLECT_ALL_PLAN_NAME } = await import("../core/triage");
const { triageEnabledOf, ANGLE_PLATFORMS } = await import("../core/triage");
const { normalizeForm, FORM_LABELS, FORM_MONETIZATION, PLATFORM_KEYS } = await import("../core/platforms");
const { handle } = await import("../core/http");

function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
after(() => { store().close(); cleanup(dir); });

// 上海当日午时（避开 00:00-01:00 的 collectAll 静默窗，且与 shanghaiDay() 同日）
const noonShanghai = () => new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()) + "T12:00:00+08:00");

function src(id: string, name: string): any { return { id, name, type: "rss", url: "https://example.com/feed.xml", sourceType: "media", region: undefined, query: undefined, officialDomains: undefined, enabled: true, note: "" }; }
const iso = (offsetH: number) => new Date(Date.now() - offsetH * 3600000).toISOString();

// ---- 第1段：collectAllTick ----
test("collectAll：当日闸（非当日 filtered/RSS 24h fallback）+ 300 精简（热度优先）+ 落盘与日闸幂等", async () => {
  const db = store();
  for (const [id, name] of [["s1", "源一"], ["s2", "源二"]] as const) db.put("sources", id, src(id, name));
  const reader = (async (s: any) => ({
    items: s.id === "s1"
      ? [
          { title: "今日热点甲", url: "https://a/1", excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline", publishedAt: iso(1) },
          { title: "昨日旧闻乙", url: "https://a/2", excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline", publishedAt: iso(30) },
          { title: "近24小时RSS丙", url: "https://a/3", excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline", publishedAt: iso(20) },
        ]
      : [{ title: "源二旧闻", url: "https://b/1", excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline", publishedAt: iso(50) }],
    warnings: [],
  })) as any;
  const noTriage = (async () => { throw new Error("本用例关初筛：不应调模型"); }) as any;
  await collectAllTick(db, noTriage, reader, noonShanghai());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const jobId = "collectall-" + day;
  const record = db.get<any>("discovery", jobId);
  assert.ok(record, "批次落盘");
  assert.equal(record.planName, COLLECT_ALL_PLAN_NAME);
  const byTitle: Record<string, any> = Object.fromEntries(record.candidates.map((c: any) => [c.title, c]));
  assert.equal(byTitle["今日热点甲"].status, "watch", "当日数据进入初筛池");
  assert.equal(byTitle["昨日旧闻乙"].status, "filtered");
  assert.match(byTitle["昨日旧闻乙"].reason, /非当日数据/);
  assert.equal(byTitle["近24小时RSS丙"].status, "watch", "RSS 24h fallback 放行");
  assert.equal(byTitle["源二旧闻"].status, "filtered", "非 RSS 超 24h 不放行");
  assert.ok(db.get("meta", "collect-all-done:" + day), "日闸落键");
  // 幂等：再跑不重复采集
  await collectAllTick(db, noTriage, (async () => { throw new Error("不应再读源"); }) as any, noonShanghai());
});

test("collectAll：超 300 按当日新>热度精简；none 组归档可恢复", async () => {
  const db = store();
  // 与上一用例共用单例 store：先清当日闸与批次再跑（重放当日采集场景）
  const day0 = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  db.del("meta", "collect-all-done:" + day0);
  db.del("discovery", "collectall-" + day0);
  for (const id of ["s1", "s2"]) { const prev = db.get<any>("sources", id); if (prev) db.put("sources", id, { ...prev, enabled: false }); }
  db.put("sources", "s9", src("s9", "大源"));
  const items = Array.from({ length: 320 }, (_, i) => ({
    title: `条目${String(i).padStart(3, "0")}`, url: `https://x/${i}`, excerpt: "x",
    collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline",
    publishedAt: iso(i % 5),
    metric: i % 7 === 0 ? { name: "热度", value: String(100000 - i), unit: "raw", period: "" } : undefined,
  }));
  const reader = (async () => ({ items, warnings: [] })) as any;
  await collectAllTick(db, (async () => { throw new Error("no model"); }) as any, reader, noonShanghai());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const record = db.get<any>("discovery", "collectall-" + day);
  const watch = record.candidates.filter((c: any) => c.status === "watch");
  // R10.28：精简闸已删——当日 watch 全量保留（原断言 300/trimmed 20 按新口径改写）
  assert.equal(watch.length, 320, "当日 watch 全量保留（零精简）");
  assert.equal(record.candidates.filter((c: any) => c.reason?.includes("精简上限")).length, 0, "零 filtered-by-limit");
  assert.ok(watch.some((c: any) => c.metric), "含热度条目（不再参与去留排序）");
  // none 归档 + 恢复
  const triage = { jobId: record.jobId, planName: COLLECT_ALL_PLAN_NAME, day, at: new Date().toISOString(), shards: 1, calls: 1, tokens: 1, merges: 0,
    groups: [
      { id: "grp-x", title: "无价值组", attention: "none", reason: "纯娱乐", memberUrls: [watch[0].url, watch[1].url], representativeUrl: watch[0].url, sources: ["大源"], angles: [] },
      { id: "grp-y", title: "强组", attention: "strong", reason: "强信号", memberUrls: [watch[2].url], representativeUrl: watch[2].url, sources: ["大源"], angles: [] },
    ] };
  const { applyTriageResult } = await import("../core/triage");
  applyTriageResult(db, db.get<any>("discovery", record.jobId), triage as any); // 真实链路顺序：先写判级再归档
  const archived = archiveNoneGroups(db, record.jobId, triage as any);
  assert.equal(archived.archived, 1);
  assert.equal(archived.candidates, 2);
  const after = db.get<any>("discovery", record.jobId);
  assert.equal(after.candidates.find((c: any) => c.url === watch[0].url).status, "filtered", "none 成员归档");
  assert.equal(after.candidates.find((c: any) => c.url === watch[2].url).status, "selected", "strong 成员按判级入选（名额内）");
  assert.ok(db.get("meta", "collect-all-done:" + day));
  const restored = restoreArchived(db, record.jobId);
  assert.equal(restored.restored, 2, "归档可恢复");
  assert.equal(db.get<any>("discovery", record.jobId).candidates.find((c: any) => c.url === watch[0].url).status, "watch");
});

// ---- 第2段 ----
test("triage 默认全开（全 kind）；角度平台 8 值（xhs-video 后置不进角度）", () => {
  assert.equal(triageEnabledOf({ kind: "editorial" }, { triage: "cheap" }), true, "R10：非 trends 计划默认也开");
  assert.equal(triageEnabledOf({ kind: "editorial", aiPolicy: { enabled: false } }, { triage: "cheap" }), false, "计划可显式退出");
  assert.equal(triageEnabledOf({ kind: "trends" }, { triage: "off" }), false, "总闸 off 一票否决");
  assert.deepEqual([...ANGLE_PLATFORMS], ["gzh", "tiebuhao", "xhs-note", "threads", "x", "facebook", "instagram", "linkedin"]);
});

// ---- R10.2 追加：补跑路径完成初筛后同样归档（实测 134 组 none 109 未进 triage-archive 的修复）----
test("补跑完成→归档存在：triageTick 成功路径产出 none 组进 triage-archive，成员置 filtered", async () => {
  const db = store();
  db.put("config", "consumerMode", "builtin"); // R10.19
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const jobId = "collectall-" + day;
  db.del("meta", "collect-all-done:" + day);
  db.del("discovery", jobId);
  db.del("meta", "triage-fail:" + jobId);
  db.del("candidate-groups", "tg-" + jobId);
  db.put("sources", "s-t", src("s-t", "补跑源"));
  const items = Array.from({ length: 12 }, (_, i) => ({ title: `补跑${i}`, url: `https://t/${i}`, excerpt: "x", collectedAt: new Date().toISOString(), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline" as const }));
  await collectAllTick(db, (async () => { throw new Error("首跑失败留痕"); }) as any, (async () => ({ items, warnings: [] })) as any, noonShanghai());
  assert.ok(db.get("meta", "triage-fail:" + jobId), "首跑失败已留痕");
  // 补跑：3 个 strong + 2 个 none（成员各 2 条）
  const runner = (async () => ({
    text: JSON.stringify({ groups: [
      { members: [0, 1], title: "强组", attention: "strong", reason: "强信号" },
      { members: [2, 3], title: "潜组", attention: "potential", reason: "次级" },
      { members: [4, 5], title: "噪音组甲", attention: "none", reason: "纯娱乐" },
      { members: [6, 7], title: "噪音组乙", attention: "none", reason: "时政" },
      { members: [8], title: "单条丙", attention: "potential", reason: "x" },
      { members: [9], title: "单条丁", attention: "none", reason: "y" },
      { members: [10, 11], title: "强组二", attention: "strong", reason: "z" },
    ] }),
    usage: 10,
  })) as any;
  await triageTick(db, runner);
  const archive = db.get<any>("triage-archive", "ta-" + jobId);
  assert.ok(archive, "补跑完成后归档存在");
  assert.equal(archive.groups.length, 3, "三个 none 组进归档");
  const rec = db.get<any>("discovery", jobId);
  assert.equal(rec.candidates.find((c: any) => c.url === items[4].url).status, "filtered", "none 成员置 filtered");
  assert.equal(rec.candidates.find((c: any) => c.url === items[0].url).status, "selected", "strong 成员照常入选");
  assert.ok(!db.get("meta", "triage-fail:" + jobId), "失败标记清除");
});

// ---- R10.5 safeRead 内网白名单 ----
test("safeRead：http://rsshub:1200 白名单放行（同 host 错端口/https 伪装其他内网仍拒）", async () => {
  const { safeRead } = await import("../core/sources");
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("<rss>ok</rss>", { status: 200 })) as typeof fetch;
    const text = await safeRead("http://rsshub:1200/36kr/newsflashes");
    assert.match(text, /ok/);
    await assert.rejects(() => safeRead("http://rsshub:8080/x"), /HTTPS/, "错端口不放行");
    await assert.rejects(() => safeRead("http://evil.internal:1200/x"), /HTTPS/, "仅 rsshub 主机放行");
  } finally { globalThis.fetch = orig; }
});

// ---- R10.4-① 补源守护 ----
test("defaultSources 含三个实测源（qbitai/ifanr/solidot），enabled 进 collectAll", async () => {
  const { defaultSources } = await import("../core/defaults");
  for (const id of ["qbitai", "ifanr", "solidot"]) {
    const src = defaultSources.find((s: any) => s.id === id);
    assert.ok(src, `${id} 在默认源`);
    assert.equal(src.enabled, true);
    assert.equal(src.type, "rss");
    assert.ok(src.url?.startsWith("https://"));
  }
});

// ---- R10.2① 守护：平台目录与 schema 不再漂移（旧测试只断言 ANGLE_PLATFORMS，五值平台漏网教训）----
test("平台一致性守护：PLATFORM_KEYS=schema platformAffinity 枚举全集；ANGLE_PLATFORMS ⊆ PLATFORM_KEYS；9 值识别", async () => {
  const { PLATFORM_KEYS, normalizePlatform } = await import("../core/platforms");
  const { planSchema } = await import("../core/schema");
  const { ANGLE_PLATFORMS } = await import("../core/triage");
  const base = {
    id: "p-guard", name: "守护计划", kind: "trends" as const, goal: "验证平台枚举一致性", audience: "测试",
    keywords: [], excludeKeywords: [], includeDomains: [], sourceIds: ["s"], lookbackDays: 7,
    maxEvidence: 10, maxQueries: 4, maxItems: 4, maxModelCalls: 8, maxTokens: 400000,
    scheduleEnabled: false, dailyTime: "01:00", publishPolicy: "manual" as const,
  };
  for (const key of PLATFORM_KEYS) {
    assert.equal(planSchema.parse({ ...base, platformAffinity: [key] }).platformAffinity?.[0], key, `${key} 须在 schema 枚举内`);
  }
  assert.throws(() => planSchema.parse({ ...base, platformAffinity: ["not-a-platform"] }), /platformAffinity/, "schema 拒绝未知平台");
  assert.equal(PLATFORM_KEYS.length, 9, "九值平台目录");
  for (const key of ["x", "facebook", "instagram", "linkedin"]) assert.equal(normalizePlatform(key), key, "新平台键原样识别");
  assert.equal(normalizePlatform("公众号"), "gzh", "当前显示标签反查仍可用");
  assert.ok((ANGLE_PLATFORMS as readonly string[]).every((k) => (PLATFORM_KEYS as string[]).includes(k)), "角度平台 ⊆ 平台目录");
});

// ---- R10.2②③ 守护 ----
test("collectAll 初筛失败留痕：triage-fail 键存在 + 候选标待语义初筛；按组恢复不删整批归档", async () => {
  const db = store();
  db.put("config", "consumerMode", "builtin"); // R10.19
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const jobId = "collectall-" + day;
  db.del("meta", "collect-all-done:" + day);
  db.del("discovery", jobId);
  db.del("meta", "triage-fail:" + jobId);
  db.put("sources", "s-f", src("s-f", "失败源"));
  const reader = (async (_s: any, _l: number, signal: AbortSignal) => {
    void signal;
    return { items: Array.from({ length: 10 }, (_, i) => ({ title: `今日${i}`, url: `https://f/${i}`, excerpt: "x", collectedAt: new Date().toISOString(), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline" as const })), warnings: [] };
  }) as any;
  const failing = (async () => { throw new Error("模型连接失败"); }) as any;
  await collectAllTick(db, failing, reader, noonShanghai());
  assert.ok(db.get("meta", "triage-fail:" + jobId), "② 失败留痕：triage-fail 键存在（旧实现只有 console.error）");
  const rec = db.get<any>("discovery", jobId);
  assert.ok(rec.candidates.some((c: any) => c.reason.includes("待语义初筛")), "② 候选标注待语义初筛");
  // ③ 按组恢复
  const watch = rec.candidates.filter((c: any) => c.status === "watch");
  const triage = { jobId, planName: COLLECT_ALL_PLAN_NAME, day, at: new Date().toISOString(), shards: 1, calls: 1, tokens: 1, merges: 0,
    groups: [
      { id: "g-a", title: "组甲", attention: "none", reason: "r", memberUrls: [watch[0].url], representativeUrl: watch[0].url, sources: ["失败源"], angles: [] },
      { id: "g-b", title: "组乙", attention: "none", reason: "r", memberUrls: [watch[1].url], representativeUrl: watch[1].url, sources: ["失败源"], angles: [] },
    ] };
  const { applyTriageResult } = await import("../core/triage");
  applyTriageResult(db, db.get<any>("discovery", jobId), triage as any);
  archiveNoneGroups(db, jobId, triage as any);
  const r1 = restoreArchived(db, jobId, "g-a");
  assert.equal(r1.restored, 1, "恢复组甲");
  const after = db.get<any>("triage-archive", "ta-" + jobId);
  assert.ok(after, "③ 归档记录仍在（旧实现会整条删除）");
  assert.equal(after.groups.length, 1, "仅剩组乙");
  const r2 = restoreArchived(db, jobId, "g-b");
  assert.equal(r2.restored, 1, "组乙仍可恢复");
  assert.ok(!db.get("triage-archive", "ta-" + jobId), "组空后记录才删除");
});

// ---- 第3段 ----
test("form 严格六值（总纲：无旧值映射）；标签与变现口径齐全", () => {
  assert.equal(normalizeForm("web"), undefined, "总纲：旧值不映射");
  assert.equal(normalizeForm("app"), undefined);
  assert.equal(normalizeForm("工具站"), undefined, "自由文本不再解析");
  assert.equal(normalizeForm("web-app"), "web-app");
  assert.equal(Object.keys(FORM_LABELS).length, 6);
  assert.ok(Object.keys(FORM_MONETIZATION).every((k) => FORM_MONETIZATION[k as keyof typeof FORM_MONETIZATION].length > 0));
});

test("generateFromLaunches：business/pain 且 HN≥50 或撞词的新站出「复刻已验证」卡", () => {
  const db = store();
  db.put("site-launches", "l1", { host: "a.example", title: "AI invoice tool", titleZh: "AI 发票工具", motive: "business", motiveSource: "quote", hnScore: 120, clashTerms: [], siteUrl: "https://a.example", sourceUrl: "https://news.ycombinator.com/item?id=1" });
  db.put("site-launches", "l2", { host: "b.example", title: "hobby site", motive: "hobby", hnScore: 300, siteUrl: "https://b.example" });
  db.put("site-launches", "l3", { host: "c.example", title: "pain low score but clashed", motive: "pain", hnScore: 5, clashTerms: ["ai resume"], siteUrl: "https://c.example" });
  db.put("site-launches", "l4", { host: "d.example", title: "low score no clash", motive: "business", hnScore: 5, siteUrl: "https://d.example" });
  // R10.40：新站复刻自动出卡下线——launch 数据只存不算卡，复刻评估归小拾
  assert.equal(db.list<any>("opportunities").length, 0, "launch 零自动出卡");
});

test("消费回执：POST agent/consume-report 落键；summary/today 暴露 stale 判定", async () => {
  const db = store();
  // 建 consume 令牌（走正规口）
  const conn = db.createConnection("r10-test", ["consume"]);
  const res = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/consume-report", {
    method: "POST",
    headers: { host: "127.0.0.1:5173", "content-type": "application/json", authorization: "Bearer " + conn.token },
    body: JSON.stringify({ consumed: 12, note: "主分析完成" }),
  }), "agent/consume-report".split("/"));
  assert.equal(res.status, 200);
  const report = db.get<any>("meta", "agent-consume-report");
  assert.equal(report.consumed, 12);
  assert.match(report.by, /agent:r10-test/);
  const summary = await (await handle(new Request("http://127.0.0.1:5173/api/v1/summary/today", { headers: { host: "127.0.0.1:5173" } }), ["summary", "today"])).json();
  assert.equal(summary.externalConsumption.consumed, 12);
  assert.equal(summary.externalConsumption.stale, false);
});
