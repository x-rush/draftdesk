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
const { collectAllTick, archiveNoneGroups, restoreArchived } = await import("../core/collect-all");
const { COLLECT_ALL_PLAN_NAME } = await import("../core/triage");
const { triageEnabledOf, ANGLE_PLATFORMS } = await import("../core/triage");
const { generateOpportunities, normalizeForm, FORM_LABELS, FORM_MONETIZATION } = await import("../core/opportunity");
const { handle } = await import("../core/http");

function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
after(() => { store().close(); cleanup(dir); });

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
  await collectAllTick(db, noTriage, reader);
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
  await collectAllTick(db, noTriage, (async () => { throw new Error("不应再读源"); }) as any);
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
  await collectAllTick(db, (async () => { throw new Error("no model"); }) as any, reader);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const record = db.get<any>("discovery", "collectall-" + day);
  const watch = record.candidates.filter((c: any) => c.status === "watch");
  assert.equal(watch.length, 300, "精简到 300");
  const trimmed = record.candidates.filter((c: any) => c.reason?.includes("精简上限"));
  assert.equal(trimmed.length, 20);
  assert.ok(watch.some((c: any) => c.metric), "高热度条目优先保留");
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
  const run = generateOpportunities(db, { source: "agent" });
  assert.ok(run.created >= 2, "l1+l3 出卡");
  const all = db.list<any>("opportunities");
  const card = all.find((o) => o.dedupeKey === "launch:a.example");
  assert.ok(card, "复刻卡存在");
  assert.match(card.oneLiner, /复刻已验证/);
  assert.equal(card.form, "web-app");
  assert.equal(card.monetization, FORM_MONETIZATION["web-app"]);
  assert.equal(card.verdict, "可以试试");
  assert.ok(!all.some((o) => o.dedupeKey === "launch:b.example"), "hobby 动机不出卡");
  assert.ok(!all.some((o) => o.dedupeKey === "launch:d.example"), "低分无撞词不出卡");
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
