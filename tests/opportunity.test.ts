// 机会引擎守护（R10.40 归口重构后）：卡片唯一写口=PUT /agent/opportunities（小拾语义评估），
// from-group 单组机械转换保留；**自动出卡 sweep 已整体下线**——本文件同时锁定「auto 零新增」契约。
// watch 池 TTL / 平台适配关键词 / 源绑定矩阵迁移 / retighten 复检照旧。
import { test } from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { watchPoolMaintenance, platformFitOf, groupOpportunityDrafts, writeAgentOpportunity, retightenNewsOpportunities } from "../core/opportunity";
import { urlKey } from "../core/hotspots";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const DAY = 86400000;
function iso(offsetDays: number, base = new Date()) {
  return new Date(base.getTime() - offsetDays * DAY).toISOString();
}

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

test("平台适配关键词匹配（R10.40 后为计划档位/watch 精筛工具，不再产内容线卡）", () => {
  assert.equal(platformFitOf("Cursor 使用深度拆解", ["gzh"]), "gzh");
  assert.equal(platformFitOf("剪映字幕实测教程", ["gzh", "xhs-note"]), "xhs-note");
  assert.equal(platformFitOf("普通标题", ["gzh"]), undefined);
});

test("R10.40：auto sweep 下线——词/组/新站/站群信号零自动出卡，卡片唯一写口=agent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1040zero-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 词信号（原 app:term 路径原料）
    const now = new Date().toISOString();
    db.put("seen-terms", "t1", { id: "t1", term: "some tool", status: "rising", observations: 9, intent: "comparison", relevance: "strong", sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: now, lastSeenAt: now });
    // 组信号（原 app:grp 路径原料）
    db.put("candidate-groups", "tg-z", { jobId: "z", planName: "p", day: "d", at: now, shards: 0, calls: 0, tokens: 0, merges: 0, groups: [
      { id: "g-z", title: "带缺口组", attention: "strong", reason: "r", memberUrls: [], representativeUrl: "", sources: [], angles: [], appGap: "做个工具" },
    ] });
    // 新站信号（原 launch 路径原料）
    db.put("site-launches", "l-z", { host: "z.example", title: "AI tool", titleZh: "AI 工具", motive: "business", hnScore: 200, clashTerms: [], siteUrl: "https://z.example" });
    // 站群信号（原 site:cand 路径原料）
    db.put("seo-terms", "pdfconverter", { term: "pdf converter", siteCandidate: true, siteType: "工具站", siteRationale: "门槛达标" });
    // 触发原调用方等价动作：triage 补跑的转卡行已删——这里直接断言库面零卡
    assert.equal(db.list<any>("opportunities").length, 0, "auto 零新增（sweep 已下线）");
    // 组草案仍可经手动/Agent 口机械转换（from-group 同源函数）
    const record = db.get<any>("candidate-groups", "tg-z");
    const drafts = groupOpportunityDrafts(record.groups[0]);
    assert.equal(drafts.length, 1, "appGap 组出 1 条草案");
    assert.equal(drafts[0].dedupeKey, "app:grp:g-z");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("R10.40：writeAgentOpportunity 是卡片唯一写口——source=agent、待验证、同源去重合并", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1040agent-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const r1 = writeAgentOpportunity(db, {
      title: "本地大模型路由器：按成本自动选型", oneLiner: "多模型 API 网关按任务复杂度路由，成本降 60%",
      form: "web-app", monetization: "订阅", signals: ["newtech"], url: "https://example.org/router",
      verifyPlan: ["两周观察", "成本对比"],
    });
    assert.equal(r1.created, 1);
    const card = db.list<any>("opportunities")[0];
    assert.equal(card.source, "agent", "来源=agent（auto 已绝迹）");
    assert.equal(card.verdict, "待验证");
    assert.equal(card.kind, "app");
    // 同 title+url 再写 → 不重出（信号集相同，无合并计数）
    const r2 = writeAgentOpportunity(db, {
      title: "本地大模型路由器：按成本自动选型", oneLiner: "多模型 API 网关按任务复杂度路由，成本降 60%",
      form: "web-app", signals: ["newtech"], url: "https://example.org/router",
    });
    assert.equal(r2.created, 0);
    assert.equal(db.list<any>("opportunities").length, 1);
    // 信号集增长 → 合并计数 +1
    const r3 = writeAgentOpportunity(db, {
      title: "本地大模型路由器：按成本自动选型", oneLiner: "多模型 API 网关按任务复杂度路由，成本降 60%",
      form: "web-app", signals: ["newtech", "trend"], url: "https://example.org/router",
    });
    assert.equal(r3.created, 0);
    assert.equal(r3.merged, 1, "信号集增长计合并");
    assert.deepEqual(db.list<any>("opportunities")[0].signals.sort(), ["newtech", "trend"]);
    assert.equal(db.list<any>("opportunities").length, 1);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("news 卡收紧复检保留：营销话术存量卡降档标注（R10.40 后经 agent 卡验证）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-tighten-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const seed = (id: string, title: string) => db!.put("opportunities", id, {
      id, dedupeKey: "app:ev:" + id, kind: "app", signals: ["news"], evidenceIds: [],
      title, oneLiner: "官方发布推演", form: "web-app",
      verdict: "待验证", verdictReason: "官方发布推演缺口", verifyPlan: [], source: "agent",
      createdAt: iso(1), updatedAt: iso(1),
    });
    seed("opp-mkt", "Meet the new Atlas browser");
    seed("opp-real", "OpenAI releases batch API rate limit increases");
    const r = retightenNewsOpportunities(db);
    assert.equal(r.checked, 2, "复检池=待验证的 news/newtech 卡");
    assert.equal(r.demoted, 1, "营销卡（无实体变化词）降档，releases 实体词卡不动");
    assert.equal(db.get<any>("opportunities", "opp-mkt").verdict, "不值得做");
    assert.ok(db.get<any>("opportunities", "opp-mkt").verdictReason.includes("营销推演"));
    assert.equal(db.get<any>("opportunities", "opp-real").verdict, "待验证");
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
    const { migrations } = await import("../core/store/migrations");
    assert.ok(!migrations.find((x) => x.id === "outline-platform-v1"), "旧值迁移已随总纲删除");
    db.put("outlines", "out-key", { id: "out-key", clusterId: "clu-inbox", platform: "xhs-note", contentType: "长文", title: "新值选题", outline: [], keyPoints: [], evidenceRefs: [], decision: "pending" });

    // 题材标注 tick：mock cheap 模型
    db.put("outlines", "out-c1", { id: "out-c1", clusterId: "clu-inbox", platform: "gzh", contentType: "长文", title: "GPT-5 发布：一周内可用的三个工作流改造", outline: [], keyPoints: ["模型能力变化"], evidenceRefs: [], decision: "pending" });
    db.put("outlines", "out-c2", { id: "out-c2", clusterId: "clu-inbox", platform: "xhs-note", contentType: "笔记", title: "我的开源工具三个月使用复盘", outline: [], keyPoints: ["一手经历"], evidenceRefs: [], decision: "pending" });
    const model = (async (_db: any, messages: any[]) => {
      const lines = (messages[0].content as string).split("\n").filter((l: string) => /^\d+\. \[/.test(l));
      return { text: JSON.stringify(lines.map((l: string, i: number) => ({
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

test("选题体系批 B：按平台拍板聚合 + siteCandidate 只标注不落卡 + builtin 自动大纲 + 提示词矩阵", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-batchb-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    const { aggregateOutlineDecision } = await import("../core/platforms");
    assert.equal(aggregateOutlineDecision({ decision: "pending" }), "pending");
    assert.equal(aggregateOutlineDecision({ decision: "approved", perPlatformDecision: { gzh: "published", "xhs-note": "pending" } }), "published", "分化取最前进正向");
    assert.equal(aggregateOutlineDecision({ decision: "approved", perPlatformDecision: { gzh: "rejected", "xhs-note": "deferred" } }), "rejected");

    // R10.40：siteCandidate 纯数值门槛标注照旧，但不再落卡
    db.put("seo-terms", "pdfconverter", { term: "pdf converter", siteCandidate: true, siteType: "工具站", sources: ["hn-algolia"], siteRationale: "工具意图强且竞争弱" });
    db.put("seo-terms", "notmarked", { term: "not marked", siteCandidate: false });
    assert.ok(db.get<any>("seo-terms", "pdfconverter").siteCandidate, "标注机制在");
    assert.equal(db.list<any>("opportunities").filter((o) => String(o.dedupeKey).startsWith("site:cand")).length, 0, "站群卡零产出（评估归小拾）");

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
