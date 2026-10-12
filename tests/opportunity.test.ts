// 机会引擎守护（第五轮 §1）：四信号源生成、去重合并、watch 池 TTL、平台适配、
// consumerMode 门控、源绑定矩阵迁移。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, hash } from "../core/store";
import { generateOpportunities, watchPoolMaintenance, watchTtlTick, opportunityTick, toolSignalOf, platformFitOf } from "../core/opportunity";
import { urlKey } from "../core/hotspots";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const DAY = 86400000;
function iso(offsetDays: number, base = new Date()) {
  return new Date(base.getTime() - offsetDays * DAY).toISOString();
}
function dayKey(offset: number, base = new Date()) {
  return new Date(base.getTime() - offset * DAY).toISOString().slice(0, 10);
}

function putEvidence(db: Store, id: string, url: string, extra: Record<string, unknown> = {}) {
  db.put("evidence", id, {
    id, title: "证据 " + id, url, excerpt: "_excerpt_", collectedAt: iso(1), sourceType: "official",
    region: "全球", language: "en", contentLevel: "excerpt", provenance: "test", fingerprint: id, ...extra,
  });
}

test("四信号源：complaint(idea 产物) + newtech(news 产物推演) + news(官方证据) + trend(蓝海词/工具意图)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-opp-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // complaint：small-products 的 idea 产物
    db.put("artifacts", "idea-1", {
      id: "idea-1", kind: "idea", archived: false, title: "会议纪要负责人核对小工具",
      summary: "把纪要逐条核对负责人，避免漏项。", evidenceIds: ["ev-c1"], quality: "ready",
      details: { trigger: "手工核对纪要负责人总漏", experiment: "一周内做最小核对页" },
    });
    putEvidence(db, "ev-c1", "https://example.org/discussion", { sourceType: "community" });
    // newtech：daily-editorial 的 news 产物（产品级变化 → 配套缺口推演）
    db.put("artifacts", "news-1", {
      id: "news-1", kind: "news", archived: false, title: "GPT-5 文件 API 上线批量处理",
      summary: "官方发布批量文件处理能力。", evidenceIds: ["ev-n1"], quality: "ready",
      details: { whatChanged: "官方上线批量文件处理，开放新端点", availability: "API", limitations: [] },
      createdAt: iso(2),
    });
    putEvidence(db, "ev-n1", "https://openai.com/news/batch-files");
    // news：官方证据直接命中（未被任何产物引用）
    putEvidence(db, "ev-o1", "https://openai.com/news/embedding-v4", { title: "OpenAI launches embedding v4" });
    // trend：verdict=推荐 的蓝海词 → site；工具意图强词 → app
    const obsByDay: Record<string, number> = {};
    for (let o = 0; o <= 1; o++) obsByDay[dayKey(o)] = 4;
    for (let o = 2; o <= 4; o++) obsByDay[dayKey(o)] = 1;
    db.put("seen-terms", "blueoceantool", {
      id: "blueoceantool", term: "blue ocean tool", status: "rising", observations: 11, sources: ["hn-algolia"],
      relatedSearches: [], daysSeen: [], obsByDay, firstSeenAt: iso(5), lastSeenAt: iso(0),
      relevance: "strong", region: "global", serpDedicated: 0, serpInternal: 0,
    });
    db.put("seen-terms", "notifalternative", {
      id: "notifalternative", term: "notif alternative", status: "rising", observations: 3, sources: ["hn-algolia"],
      relatedSearches: [], daysSeen: [], obsByDay: {}, firstSeenAt: iso(2), lastSeenAt: iso(0),
      relevance: "strong", region: "global", intent: "comparison",
    });
    assert.equal(toolSignalOf({ intent: "comparison", relevance: "strong", observations: 3 }), true);
    assert.equal(toolSignalOf({ intent: "comparison", relevance: "weak", observations: 9 }), false, "弱相关不进工具机会");

    const run = generateOpportunities(db, { source: "agent" });
    assert.ok(run.created >= 5, `四信号源都应出卡（实际 ${run.created}）`);
    const opps = db.list<any>("opportunities");
    const complaint = opps.find((o) => o.signals.includes("complaint") && o.kind === "app");
    assert.equal(complaint.title, "会议纪要负责人核对小工具");
    assert.equal(complaint.verdict, "可以试试", "quality=ready 的 idea 卡可以试试");
    const newtech = opps.find((o) => o.signals.includes("newtech"));
    assert.ok(newtech.oneLiner.includes("配套缺口"), "newtech 卡带配套缺口推演");
    assert.equal(newtech.verdict, "待验证");
    const news = opps.find((o) => o.signals.includes("news"));
    assert.ok(news, "官方新品证据出 news 卡");
    assert.deepEqual(news.evidenceIds, ["ev-o1"], "已被产物引用的证据不重出卡");
    const site = opps.find((o) => o.kind === "site" && o.signals.includes("trend"));
    assert.equal(site.term, "blue ocean tool");
    assert.equal(site.verdict, "推荐", "蓝海词卡推荐档");
    const appTrend = opps.find((o) => o.kind === "app" && o.signals.includes("trend"));
    assert.equal(appTrend.term, "notif alternative");
    // 去重：重跑不新增；agent 重复触发 source 保持 agent
    const rerun = generateOpportunities(db, { source: "agent" });
    assert.equal(rerun.created, 0, "同词/同证据集去重");
    assert.equal(db.list<any>("opportunities").length, opps.length);
    // 合并：既有 complaint 卡 + trend 信号同词 → signals 并集（id 必须按 dedupeKey 计算得出）
    const preId = "opp-" + hash("site:term:blueoceantool").slice(0, 20);
    db.put("opportunities", preId, {
      id: preId, dedupeKey: "site:term:blueoceantool", kind: "site", signals: ["complaint"],
      evidenceIds: [], title: "blue ocean tool", oneLiner: "手工预置", form: "内容页",
      verdict: "待验证", verdictReason: "", verifyPlan: [], source: "auto",
      createdAt: iso(1), updatedAt: iso(1),
    });
    const rerun2 = generateOpportunities(db, { source: "agent" });
    assert.equal(rerun2.merged, 1, "同 dedupeKey 合并 signals");
    assert.deepEqual(db.get<any>("opportunities", preId).signals.sort(), ["complaint", "trend"]);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("watch 池 TTL：引用≥2 晋升 selected；超 14 天未引用降级 filtered 且原 reason 保留", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-watchttl-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const plan = db.list<any>("plans").find((p) => p.kind === "opportunity")!;
    const cand = (url: string, title: string, observedAt: string, status = "watch") => ({
      url, title, sourceId: "v2ex-problems", sourceName: "V2EX", status, reason: "符合策略，等待证据名额", observedAt,
    });
    db.put("discovery", "job-w1", {
      jobId: "job-w1", at: iso(20), planName: plan.name, limit: 10,
      candidates: [
        cand("https://example.org/old-no-ref", "老词无人引用", iso(20)),
        cand("https://example.org/old-promoted", "被引用两次的老词", iso(20)),
        cand("https://example.org/fresh", "新词还在观察", iso(2)),
      ],
      sources: [],
    });
    // 引用：消费记录 ×2（同一 url 两条消费）
    const key = urlKey("https://example.org/old-promoted");
    db.put("consumption", "c1", { target: "hotspots", identity: key, reason: "r", consumedBy: "agent", consumedAt: iso(3) });
    db.put("consumption", "c2", { target: "hotspots", identity: key, reason: "r", consumedBy: "agent", consumedAt: iso(2) });
    const r = watchPoolMaintenance(db);
    assert.equal(r.scanned, 3);
    assert.equal(r.promoted, 1, "引用≥2 晋升");
    assert.equal(r.demoted, 1, "超 14 天未引用降级");
    const cands = db.get<any>("discovery", "job-w1").candidates;
    assert.equal(cands[0].status, "filtered");
    assert.ok(cands[0].reason.includes("TTL 降级") && cands[0].reason.includes("符合策略"), "原 reason 保留可查");
    assert.equal(cands[1].status, "selected");
    assert.ok(cands[1].reason.includes("2 次"));
    assert.equal(cands[2].status, "watch", "新词不动");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("平台适配：watch 池标题命中 platformAffinity 关键词 → site 内容线机会卡", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-fit-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    assert.equal(platformFitOf("Cursor 使用深度拆解", ["gzh"]), "gzh");
    assert.equal(platformFitOf("剪映字幕实测教程", ["gzh", "xhs-note"]), "xhs-note");
    assert.equal(platformFitOf("普通标题", ["gzh"]), undefined);
    const plan = db.list<any>("plans").find((p) => p.kind === "opportunity")!;
    db.put("discovery", "job-f1", {
      jobId: "job-f1", at: iso(1), planName: plan.name, limit: 5,
      candidates: [{ url: "https://example.org/deep-dive", title: "小模型部署深度拆解", sourceId: "v2ex-problems", sourceName: "V2EX", status: "watch", reason: "符合策略，等待证据名额", observedAt: iso(1) }],
      sources: [],
    });
    const run = generateOpportunities(db, { source: "agent" });
    assert.ok(run.created >= 1);
    const card = db.list<any>("opportunities").find((o) => o.kind === "site" && o.signals.includes("complaint"));
    assert.ok(card, "watch 平台适配候选出 site 卡");
    assert.equal(card.platform, plan.platformAffinity[0], "platform 标注命中档位");
    assert.equal(typeof card.watchRefs, "number");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("tick 门控：external 不自动生成；builtin 每日一道闸；watch TTL 不受 consumerMode 影响", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-tick-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const today = new Date().toISOString().slice(0, 10);
    opportunityTick(db);
    assert.equal(db.get("meta", "opportunity-auto-done:" + today), undefined, "external 模式不自动生成");
    db.put("config", "consumerMode", "builtin");
    opportunityTick(db);
    assert.ok(db.get("meta", "opportunity-auto-done:" + today), "builtin 每日一道闸");
    const after = db.get<any>("meta", "opportunity-auto-done:" + today);
    opportunityTick(db);
    assert.equal(db.get<any>("meta", "opportunity-auto-done:" + today).at, after.at, "同日不重跑");
    watchTtlTick(db);
    assert.ok(db.get("meta", "watch-ttl-done:" + today), "watch TTL 照跑");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("源绑定矩阵迁移：三策略补源 + platformAffinity 落库（存量库升级路径）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-oppmig-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const editorial = db.get<any>("plans", "daily-editorial")!;
    const products = db.get<any>("plans", "small-products")!;
    const trend = db.get<any>("plans", "trend-radar")!;
    for (const id of ["huggingface-blog", "reddit-localllama", "reddit-agents", "simon-practice", "v2ex-problems", "producthunt-feed", "github"])
      assert.ok(editorial.sourceIds.includes(id), `daily-editorial 应含 ${id}`);
    for (const id of ["hacker-news-top", "hn-algolia", "reddit-localllama", "reddit-agents"])
      assert.ok(products.sourceIds.includes(id), `small-products 应含 ${id}`);
    for (const id of ["github-trending", "hacker-news-top", "hn-algolia", "reddit-agents", "reddit-sd", "simon-practice"])
      assert.ok(trend.sourceIds.includes(id), `trend-radar 应含 ${id}`);
    assert.deepEqual(editorial.platformAffinity, ["gzh", "xhs-note"]);
    assert.deepEqual(products.platformAffinity, ["gzh"]);
    assert.deepEqual(trend.platformAffinity, ["gzh", "xhs-note"]);
    assert.ok(trend.sourceIds.length <= 24, "sourceIds 不超新上限");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
