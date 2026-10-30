// 机会引擎守护（第五轮 §1）：四信号源生成、去重合并、watch 池 TTL、平台适配、
// consumerMode 门控、源绑定矩阵迁移。
import { test } from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
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
  return shanghaiDayOf(new Date(base.getTime() - offset * DAY)); // 上海日同源（R10.31 测试债修复）
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
      relatedSearches: [], daysSeen: [], obsByDay: { [dayKey(0)]: 3 }, firstSeenAt: iso(2), lastSeenAt: iso(0),
      relevance: "strong", region: "global", intent: "comparison",
    });
    assert.equal(toolSignalOf({ intent: "comparison", relevance: "strong", observations: 3 }), true);
    assert.equal(toolSignalOf({ intent: "comparison", relevance: "weak", observations: 9 }), false, "弱相关不进工具机会");

    const run = generateOpportunities(db, { source: "agent" });
    assert.ok(run.created >= 5, `四信号源都应出卡（实际 ${run.created}）`);
    const opps = db.list<any>("opportunities");
    // alternative 探针词也会出 complaint app 卡（批 2b），按 dedupeKey 锚定 idea 卡
    const complaint = opps.find((o) => o.dedupeKey === "app:idea:idea-1");
    assert.equal(complaint.title, "会议纪要负责人核对小工具");
    const altCard = opps.find((o) => o.dedupeKey?.startsWith("app:altterm:"));
    assert.ok(altCard && altCard.term === "notif alternative", "alternative 词根 strong 词出 complaint 信号卡");
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
    const today = shanghaiDayOf();
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

test("news 卡收紧（批 1 收尾）：营销话术标题不出新卡 + 存量复检降档", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-tighten-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 营销话术标题（Introducing…）不推演；实体变化词（launches/releases/GA）照常
    db.put("artifacts", "news-mkt", {
      id: "news-mkt", kind: "news", archived: false, title: "Introducing ChatGPT for Financial Services",
      summary: "官方行业版宣传。", evidenceIds: ["ev-m1"], quality: "ready",
      details: { whatChanged: "面向金融行业的定制版本", availability: "API", limitations: [] }, createdAt: iso(2),
    });
    putEvidence(db, "ev-m1", "https://openai.com/news/financial");
    db.put("artifacts", "news-real", {
      id: "news-real", kind: "news", archived: false, title: "OpenAI releases batch API rate limit increases",
      summary: "官方提升批量接口限额。", evidenceIds: ["ev-m2"], quality: "ready",
      details: { whatChanged: "上线批量 API 限额提升", availability: "API", limitations: [] }, createdAt: iso(2),
    });
    putEvidence(db, "ev-m2", "https://openai.com/news/rate-limits");
    const run = generateOpportunities(db, { source: "agent" });
    const opps = db.list<any>("opportunities");
    assert.equal(opps.find((o) => o.title.includes("Financial Services")), undefined, "Introducing 营销标题不出卡");
    assert.ok(opps.find((o) => o.title.includes("rate limit increases")), "实体变化词照常出卡");
    // 存量复检：老规则出的营销卡被降档标注
    const legacy = {
      id: "opp-legacy", dedupeKey: "app:ev:legacy", kind: "app", signals: ["news"], evidenceIds: ["ev-m1"],
      title: "Meet the new Atlas browser", oneLiner: "官方新品推演", form: "web 工具",
      verdict: "待验证", verdictReason: "官方发布推演缺口", verifyPlan: [], source: "auto",
      createdAt: iso(1), updatedAt: iso(1),
    };
    db.put("opportunities", legacy.id, legacy);
    const { retightenNewsOpportunities } = await import("../core/opportunity");
    const r = retightenNewsOpportunities(db);
    assert.equal(r.checked, 2, "复检池=待验证的 news/newtech 卡（legacy + 新出的 rate limit 卡）");
    assert.equal(r.demoted, 1, "只有营销卡降档，实体变化卡不动");
    const after = db.get<any>("opportunities", "opp-legacy");
    assert.equal(after.verdict, "不值得做");
    assert.ok(after.verdictReason.includes("营销推演"), "降档标注营销推演");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("R10.2① 平台九值目录 + 题材六值（总纲：旧值映射与迁移已删，标签反查保留）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-outlineplat-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const { normalizePlatform, normalizeCategory, platformLabel, PLATFORM_KEYS } = await import("../core/platforms");
    assert.equal(PLATFORM_KEYS.length, 9);
    for (const k of ["x", "facebook", "instagram", "linkedin"]) assert.equal(normalizePlatform(k), k, "新平台键识别");
    assert.equal(normalizePlatform("公众号"), "gzh", "当前显示标签反查（gzh 的 label 即公众号）");
    assert.equal(normalizePlatform("小红书笔记"), "xhs-note", "标签反查用当前全称");
    assert.equal(normalizePlatform("小红书"), undefined, "总纲：旧简称不再映射");
    assert.equal(normalizePlatform("xhs-video"), "xhs-video");
    assert.equal(normalizePlatform("微信公众号"), undefined, "未知值不猜测");
    assert.equal(platformLabel("tiebuhao"), "贴图号");
    assert.equal(normalizeCategory("AI 新技术"), "newtech");
    assert.equal(normalizeCategory("社会热点"), "hot");
    // 总纲守护：outline-platform-v1 迁移已从迁移表移除
    const { migrations } = await import("../core/store/migrations");
    assert.ok(!migrations.find((x) => x.id === "outline-platform-v1"), "旧值迁移已随总纲删除");
    db.put("outlines", "out-key", { id: "out-key", clusterId: "clu-inbox", platform: "xhs-note", contentType: "长文", title: "新值选题", outline: [], keyPoints: [], evidenceRefs: [], decision: "pending" });

    // 题材标注 tick：mock cheap 模型
    db.put("outlines", "out-c1", { id: "out-c1", clusterId: "clu-inbox", platform: "gzh", contentType: "长文", title: "GPT-5 发布：一周内可用的三个工作流改造", outline: [], keyPoints: ["模型能力变化"], evidenceRefs: [], decision: "pending" });
    db.put("outlines", "out-c2", { id: "out-c2", clusterId: "clu-inbox", platform: "xhs-note", contentType: "笔记", title: "我的开源工具三个月使用复盘", outline: [], keyPoints: ["一手经历"], evidenceRefs: [], decision: "pending" });
    const model = (async (_db: any, messages: any[]) => {
      const lines = (messages[0].content as string).split("\n").filter((l) => /^\d+\. \[/.test(l));
      return { text: JSON.stringify(lines.map((l, i) => ({
        i: i + 1,
        category: l.includes("GPT-5") ? "newtech" : l.includes("开源工具") ? "oss" : "thinking",
      }))) };
    }) as any;
    const { outlineCategoryTick } = await import("../core/outline-categorize");
    outlineCategoryTick(db, model);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(db.get<any>("outlines", "out-c1").category, "newtech");
    assert.equal(db.get<any>("outlines", "out-c2").category, "oss");
    const day = shanghaiDayOf();
    assert.ok(db.get<any>("meta", "outline-category-done:" + day), "当日 done 置位（可持续模式 R9-1）");
    outlineCategoryTick(db, model);
    assert.ok(db.get<any>("meta", "outline-category-done:" + day), "当日 done 幂等");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("选题体系批 B：按平台拍板聚合 + siteCandidate 站群卡 + builtin 自动大纲 + 提示词矩阵", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-batchb-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    const { aggregateOutlineDecision } = await import("../core/platforms");
    assert.equal(aggregateOutlineDecision({ decision: "pending" }), "pending");
    assert.equal(aggregateOutlineDecision({ decision: "approved", perPlatformDecision: { gzh: "published", "xhs-note": "pending" } }), "published", "分化取最前进正向");
    assert.equal(aggregateOutlineDecision({ decision: "approved", perPlatformDecision: { gzh: "rejected", "xhs-note": "deferred" } }), "rejected");

    // siteCandidate 站群卡生成
    db.put("seo-terms", "pdfconverter", { term: "pdf converter", siteCandidate: true, siteType: "工具站", sources: ["hn-algolia"], siteRationale: "工具意图强且竞争弱" });
    db.put("seo-terms", "notmarked", { term: "not marked", siteCandidate: false });
    const run = generateOpportunities(db, { source: "agent" });
    const card = db.list<any>("opportunities").find((o) => o.dedupeKey === "site:cand:pdfconverter");
    assert.ok(card, "siteCandidate:true 词出站群卡");
    assert.equal(card.kind, "site");
    assert.ok(card.oneLiner.includes("工具站"), "卡带站型与来源标注");
    assert.equal(db.list<any>("opportunities").filter((o) => o.term === "not marked").length, 0, "未标注词不出卡");

    // 提示词矩阵：文件解析 + 组合生成
    const { composeOutlinePrompt } = await import("../core/prompts-matrix");
    const prompt = composeOutlinePrompt("xhs-video", "hot", "某社会热点改编", ["要点一"]);
    assert.ok(prompt.includes("口播稿"), "平台模板节命中");
    assert.ok(prompt.includes("48h") || prompt.includes("正能量"), "题材角度节命中");
    assert.ok(prompt.includes("要点一"), "素材要点拼入");
    assert.ok(prompt.includes("JSON"), "输出合同在提示词内");

    // builtin 自动大纲：approved 无草稿 → 出稿进 drafting；external 零动作
    db.put("outlines", "out-b1", { id: "out-b1", clusterId: "clu-inbox", platform: "gzh", category: "newtech", contentType: "长文", title: "测试自动大纲选题", outline: [], keyPoints: ["要点A"], evidenceRefs: [], decision: "approved", decidedAt: new Date().toISOString() });
    const draftModel = (async (_db: any, messages: any[]) => ({ text: JSON.stringify({ keyPoints: ["新要点"], outline: ["第一部分", "第二部分"], draftBody: "## 完整初稿\n\n这是按平台模板写的初稿正文。公众号长文结构：标题带钩子，核心论点先行，论据清单逐条引用证据链接，目标读者收益明确，建议工作日早间发布。\n\n第一部分展开：一周内可用性检验，读者这周能拿它做什么，对个人工作流的具体影响点在哪个环节被改变。\n\n第二部分展开：与已报道内容的差异点，给出别人没说的角度，避免重复报道，附上三步演示路径。" }) })) as any;
    const { outlineDraftTick } = await import("../core/outline-draft");
    outlineDraftTick(db, draftModel);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(db.get<any>("outlines", "out-b1").draftBody, undefined, "external 模式不自动出稿");
    db.put("config", "consumerMode", "builtin");
    outlineDraftTick(db, draftModel);
    await new Promise((r) => setTimeout(r, 250));
    const drafted = db.get<any>("outlines", "out-b1");
    assert.ok(drafted.draftBody?.includes("完整初稿"), "builtin 自动出稿");
    assert.equal(drafted.decision, "drafting", "自动推进 drafting");
    assert.deepEqual(drafted.outline, ["第一部分", "第二部分"], "outline 数组回写");
    assert.equal(db.get<any>("meta", "outline-draft-done:" + new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(new Date()).replace(/\//g, "-")).drafted, 1, "小时闸置位（上海小时，R10.31）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
