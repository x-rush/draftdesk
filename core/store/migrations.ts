// 全部启动迁移（含首版种子）集中于此：每块幂等（meta 键守卫），按注册序在单个事务内跑完——
// 与旧 Store 构造函数行为一致：任一块抛错则整批回滚，包括 initialized。
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { defaultConfig, defaultPlans, defaultSources, defaultPersona, defaultAiPolicy, defaultConsumerMode } from "../defaults";
import { now } from "./helpers";
import { cleanSeedPollution } from "../seen-clean";
import { backfillSeenTermRegions, mergeSpaceVariants } from "../seen-terms";
import type { KV } from "./kv";

interface MigrationCtx {
  kv: KV;
  directory: string;
}
interface Migration {
  id: string;
  run: (ctx: MigrationCtx) => void;
}

export const migrations: Migration[] = [
  {
    id: "initialized",
    run: ({ kv }) => {
      if (kv.get("meta", "initialized")) return;
      kv.put("config", "main", defaultConfig);
      defaultSources.forEach((s) => kv.put("sources", s.id, s));
      defaultPlans.forEach((p) => kv.put("plans", p.id, p));
      kv.put("meta", "initialized", { version: 2 });
    },
  },
  {
    id: "activities-v1",
    run: ({ kv }) => {
      const plan = defaultPlans.find((p) => p.id === "creator-activities")!;
      if (!kv.get("plans", plan.id)) kv.put("plans", plan.id, plan);
    },
  },
  {
    id: "cn-hotlists-v1",
    run: ({ kv }) => {
      for (const source of defaultSources.filter((s) => s.type === "hotlist")) if (!kv.get("sources", source.id)) kv.put("sources", source.id, source);
      const trend = kv.get<any>("plans", "trend-radar");
      if (trend && JSON.stringify(trend.sourceIds) === '["trends-us","web"]') kv.put("plans", trend.id, { ...trend, sourceIds: ["baidu-hot", ...trend.sourceIds] });
    },
  },
  {
    id: "cn-hotwords-v1",
    run: ({ kv }) => {
      const trend = kv.get<any>("plans", "trend-radar");
      if (trend && JSON.stringify(trend.keywords) === '["AI","ChatGPT","Claude","Gemini"]') kv.put("plans", trend.id, { ...trend, keywords: defaultPlans.find((p) => p.id === "trend-radar")!.keywords });
    },
  },
  {
    id: "global-hotlists-v1",
    run: ({ kv }) => {
      for (const source of defaultSources.filter((s) => ["github-trending", "hacker-news-top", "trends-gb", "trends-jp", "trends-tw", "trends-in", "trends-kr", "trends-de", "producthunt-feed"].includes(s.id)))
        if (!kv.get("sources", source.id)) kv.put("sources", source.id, source);
    },
  },
  {
    id: "aggregate-hotlists-v1",
    run: ({ kv }) => {
      for (const source of defaultSources.filter((s) => s.type === "aggregated"))
        if (!kv.get("sources", source.id)) kv.put("sources", source.id, source);
    },
  },
  {
    id: "job-budget-v2",
    // 研究流水线最坏需要 3 阶段 × 2 次模型调用；旧默认预算会在修复轮中途撞墙，
    // 把已付费任务变成失败。这里对存量策略一次性上调到能完成全流程的尺寸。
    run: ({ kv }) => {
      for (const p of kv.list<any>("plans")) {
        const next = { ...p };
        if (next.maxModelCalls < 8) next.maxModelCalls = 8;
        if (next.maxTokens < 400000) next.maxTokens = 400000;
        if (next.maxModelCalls !== p.maxModelCalls || next.maxTokens !== p.maxTokens) kv.put("plans", p.id, next);
      }
    },
  },
  {
    id: "seo-radar-v1",
    // 趋势/应用机会策略升级：新增搜索联想来源（SEO/站群/web-app 机会的需求露头信号），
    // 趋势策略改以 Google Trends+联想词为主、关键词门禁扩到机会方向。
    run: ({ kv }) => {
      for (const source of defaultSources.filter((s) => s.type === "suggest"))
        if (!kv.get("sources", source.id)) kv.put("sources", source.id, source);
      const trend = kv.get<any>("plans", "trend-radar");
      const trendDefault = defaultPlans.find((p) => p.id === "trend-radar")!;
      if (trend) kv.put("plans", trend.id, { ...trend, sourceIds: trendDefault.sourceIds, keywords: trendDefault.keywords, focusTerms: trendDefault.focusTerms, goal: trendDefault.goal });
      const products = kv.get<any>("plans", "small-products");
      const productsDefault = defaultPlans.find((p) => p.id === "small-products")!;
      if (products) kv.put("plans", products.id, { ...products, sourceIds: productsDefault.sourceIds, keywords: productsDefault.keywords, goal: productsDefault.goal });
    },
  },
  {
    id: "open-radar-v2",
    // 采集层去话题门禁：热度本身就是信号，AI 话题之外的社会热度同样采集；
    // 转化判断（AI 内容 / web-app 工具 / SEO 站群）移到分析层目标里。
    // 联想种子改为需求形状词（替代/怎么查/alternative to…），不绑定已被做掉的具体机会。
    run: ({ kv }) => {
      for (const source of defaultSources.filter((s) => s.type === "suggest")) kv.put("sources", source.id, source);
      const trend2 = kv.get<any>("plans", "trend-radar");
      const trend2Default = defaultPlans.find((p) => p.id === "trend-radar")!;
      if (trend2) kv.put("plans", trend2.id, { ...trend2, keywords: [], focusTerms: [], goal: trend2Default.goal });
      const products2 = kv.get<any>("plans", "small-products");
      const products2Default = defaultPlans.find((p) => p.id === "small-products")!;
      if (products2) kv.put("plans", products2.id, { ...products2, keywords: products2Default.keywords, goal: products2Default.goal });
    },
  },
  {
    id: "people-removal-v1",
    // 人物观察功能已移除：清掉对应策略与任务，防止调度或流水线再触达已删除的人物技能链。
    // 旧库存量仍可能是 "people"，比较用宽松字符串而不是收窄后的联合类型。
    run: ({ kv }) => {
      for (const p of kv.list<any>("plans")) if ((p.kind as string) === "people") kv.del("plans", p.id);
      for (const j of kv.list<any>("jobs")) if ((j.plan?.kind as string) === "people") kv.del("jobs", j.id);
    },
  },
  {
    id: "decision-layer-v1",
    // 决策层重构（P1）：quality=证据可信度（字段名保留，语义正名）；decision=人的拍板状态机。
    // 存量映射：saved=true→approved（decidedBy=human），其余 pending；saved 布尔废弃；archived 保留为终态标记。
    // legacy 集合归档导出后移出活动集合；persona 种子仅首版初始化。
    run: ({ kv, directory }) => {
      const stamp0 = now();
      for (const a of kv.list<any>("artifacts")) {
        if (a.decision) continue;
        const { saved, ...rest } = a;
        kv.put("artifacts", a.id, { ...rest, decision: saved ? "approved" : "pending", ...(saved ? { decidedBy: "human", decidedAt: stamp0 } : {}) });
      }
      const legacyDocs = kv.list<any>("legacy");
      if (legacyDocs.length) {
        writeFileSync(path.join(directory, `legacy-archive-${stamp0.slice(0, 10)}.json`), JSON.stringify({ archivedAt: stamp0, count: legacyDocs.length, items: legacyDocs }, null, 2));
        for (const l of legacyDocs) kv.del("legacy", l.id);
      }
      if (!kv.get("config", "persona")) kv.put("config", "persona", defaultPersona);
      // 存量簇补 status 默认值
      for (const c of kv.list<any>("clusters")) { if (!c.status) kv.put("clusters", c.id, { ...c, status: "active" }); }
    },
  },
  {
    id: "ai-policy-v1",
    run: ({ kv }) => {
      if (!kv.get("config", "aiPolicy")) kv.put("config", "aiPolicy", defaultAiPolicy);
    },
  },
  {
    id: "consumer-mode-v1",
    run: ({ kv }) => {
      if (!kv.get("config", "consumerMode")) kv.put("config", "consumerMode", defaultConsumerMode);
      if (!kv.get("config", "planMode")) kv.put("config", "planMode", "collect-and-analyze");
    },
  },
  {
    id: "cluster-status-v1",
    run: ({ kv }) => {
      for (const c of kv.list<any>("clusters")) { if (!c.status) kv.put("clusters", c.id, { ...c, status: "active" }); }
    },
  },
  {
    id: "official-api-hotlists-v1",
    // B站热门/微博热搜改走官方公开 JSON 接口（HTML 入口有访客验证，聚合上游又常年失败）。
    // 种子两个新来源；热词策略仅在未被用户改动过默认来源清单时同步加入，改过的不碰。
    run: ({ kv }) => {
      for (const id of ["weibo-hotsearch", "bilibili-popular"]) {
        const source = defaultSources.find((s) => s.id === id);
        if (source && !kv.get("sources", id)) kv.put("sources", id, source);
      }
      const trend3 = kv.get<any>("plans", "trend-radar");
      if (trend3 && JSON.stringify(trend3.sourceIds) === JSON.stringify(["suggest-cn", "suggest-global", "trends-us", "trends-gb", "baidu-hot", "dailyhot-juejin", "web"]))
        kv.put("plans", trend3.id, { ...trend3, sourceIds: defaultPlans.find((p) => p.id === "trend-radar")!.sourceIds });
    },
  },
  {
    id: "enrichment-sources-v1",
    // 种子 enrichment 来源（Hugging Face 博客、Reddit r/LocalLLaMA）；
    // 热词策略仅在未被用户改动过默认来源清单时同步加入。
    run: ({ kv }) => {
      for (const id of ["huggingface-blog", "reddit-localllama"]) {
        const source = defaultSources.find((s) => s.id === id);
        if (source && !kv.get("sources", id)) kv.put("sources", id, source);
      }
      const trend4 = kv.get<any>("plans", "trend-radar");
      if (trend4 && JSON.stringify(trend4.sourceIds) === JSON.stringify(["suggest-cn", "suggest-global", "trends-us", "trends-gb", "baidu-hot", "weibo-hotsearch", "bilibili-popular", "dailyhot-juejin", "web"]))
        kv.put("plans", trend4.id, { ...trend4, sourceIds: defaultPlans.find((p) => p.id === "trend-radar")!.sourceIds });
    },
  },
  {
    id: "plan-mojibake-v1",
    // GBK→UTF-8 损坏修复（2026-10-10 清单）：三个内置策略的文案字段含 U+FFFD，从种子恢复；
    // 操作字段（dailyTime/scheduleEnabled/maxQueries 等）保留现值。顺带清理 outlines 的
    // 乱码 producedBy 与 connections 的乱码名死令牌（已撤销，直接删除）。
    run: ({ kv }) => {
      const textFields = ["name", "goal", "audience", "keywords", "focusTerms", "excludeKeywords"];
      for (const plan of kv.list<any>("plans")) {
        const def = defaultPlans.find((p) => p.id === plan.id);
        if (!def) continue;
        const corrupted = textFields.some((f) => JSON.stringify(plan[f] ?? "").includes("\uFFFD"));
        if (!corrupted) continue;
        const next = { ...plan };
        for (const f of textFields) if ((def as any)[f] !== undefined) next[f] = (def as any)[f];
        kv.put("plans", plan.id, next);
      }
      for (const o of kv.list<any>("outlines"))
        if (typeof o.producedBy === "string" && o.producedBy.includes("\uFFFD"))
          kv.put("outlines", o.id, { ...o, producedBy: "agent:未知来源(乱码已清理)" });
      for (const c of kv.list<any>("connections"))
        if (typeof c.name === "string" && c.name.includes("\uFFFD")) kv.del("connections", c.id);
    },
  },
  {
    id: "inbox-cluster-v1",
    // 选题收集箱：无簇来源（热点推进/讨论生成大纲）的大纲统一挂这里（信息架构 v2-A 批复）。
    run: ({ kv }) => {
      if (!kv.get("clusters", "clu-inbox"))
        kv.put("clusters", "clu-inbox", { id: "clu-inbox", topic: "选题收集箱", memberIds: [], memberCount: 0, kind: "inbox", window: "", suggestedPlatforms: [], target: "hotspots", status: "active", producedBy: "human", createdAt: now() });
    },
  },
  {
    id: "seen-sources-v1",
    // 热词捕获（信息架构 v2 增补）：Reddit 社区 ×2 + HN Algolia 前页。
    run: ({ kv }) => {
      for (const id of ["hn-algolia", "reddit-sd", "reddit-agents"]) {
        const source = defaultSources.find((s) => s.id === id);
        if (source && !kv.get("sources", id)) kv.put("sources", id, source);
      }
    },
  },
  {
    id: "trend-radar-regional-v1",
    // 热词捕获（用户批复）：trend-radar 补齐 7 国 Trends（us/gb 已在，补 de/in/jp/kr/tw）。
    run: ({ kv }) => {
      const plan = kv.get<any>("plans", "trend-radar");
      if (!plan) return;
      const missing = ["trends-de", "trends-in", "trends-jp", "trends-kr", "trends-tw"].filter((id) => !(plan.sourceIds || []).includes(id));
      if (missing.length) kv.put("plans", plan.id, { ...plan, sourceIds: [...(plan.sourceIds || []), ...missing] });
    },
  },
  {
    id: "seen-terms-index-v1",
    // 热词词表规模化（词表分页批）：表达式索引支撑 5000-8000（上限 3 万）条量级的
    // 分页/三区/搜索下推查询。表达式须与 core/seen-terms.ts 查询逐字一致才会命中。
    run: ({ kv }) => {
      kv.db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_status_seen ON documents(collection, json_extract(body,'$.status'), json_extract(body,'$.lastSeenAt'))`);
      kv.db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_status_first ON documents(collection, json_extract(body,'$.status'), json_extract(body,'$.firstSeenAt'))`);
      kv.db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_intent ON documents(collection, json_extract(body,'$.intent'))`);
      kv.db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_obs_first ON documents(json_extract(body,'$.observations'), json_extract(body,'$.firstSeenAt')) WHERE collection='seen-terms' AND json_extract(body,'$.offTopic') IS NOT 1`);
      kv.db.exec(`CREATE INDEX IF NOT EXISTS idx_seen_days ON documents(collection, json_array_length(json_extract(body,'$.daysSeen'))) WHERE collection='seen-terms'`);
    },
  },
  {
    id: "budgets-used-v1",
    // 预算表结构统一（用户实弹抓到）：生产库的 budgets 曾带外加过 used 列
    //（NOT NULL 无默认），而迁移建表与 reserve 的 INSERT 都停在两列老结构——
    // 雕刻重建库/fresh clone 的每个新一天首次 reserve 必 NOT NULL 炸。
    // 此迁移幂等补列，配合 reserve 显式写 used=0，两个世界归一。
    run: ({ kv }) => {
      const cols = kv.db.prepare("PRAGMA table_info(budgets)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "used"))
        kv.db.exec("ALTER TABLE budgets ADD COLUMN used INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    id: "seed-pollution-clean-v1",
    // 种子池污染清洗（2026-10-10 用户批复）：11 个跑题种子（自动驾驶/自動駕駛/点击器家族/
    // tesla/uber/toyota/台湾法规等）按 seed 血缘反查全部家族词归档出库（不删，备查）；
    // AI 短剧/版权/无血缘提词等白名单全保留（见 core/seen-clean.ts）。
    run: ({ kv }) => {
      const report = cleanSeedPollution(kv);
      console.log(`[migration] seed-pollution-clean-v1：种子 ${report.roots} / 家族词 ${report.family} / 归档 ${report.archived}`);
    },
  },
  {
    id: "seen-term-space-merge-v1",
    // termId 归一化收紧（清洗批 2）：去全部内部空格后，历史库「爱 奇 艺 收益」与
    // 「爱奇艺收益」这类空格变体是两份文档，一次性合并（obs max/并集/状态只升不降）。
    run: ({ kv }) => {
      const report = mergeSpaceVariants(kv);
      if (report.merged) console.log(`[migration] seen-term-space-merge-v1：合并 ${report.merged} 组，移除重复文档 ${report.removed} 条`);
    },
  },
  {
    id: "seen-term-region-backfill-v1",
    // region 分层（海外定位批）：存量按来源映射回填（inferRegion），无来源可判兜底
    // global（管线海外优先定位）。cn 词纯内容创作线，global 词双职责（内容选题+站群候选）。
    run: ({ kv }) => {
      const backfilled = backfillSeenTermRegions(kv);
      if (backfilled) console.log(`[migration] seen-term-region-backfill-v1：回填 region ${backfilled} 条`);
    },
  },
  {
    id: "opportunity-engine-v1",
    // 机会引擎（第五轮 §1）：三策略按「题材×数据源」搭配矩阵补源（只增不删，缺源才补），
    // 并落 platformAffinity 平台适配标签（机会引擎二次精筛 watch 池的平台权重）。
    // sourceIds 上限已在 planSchema 放宽到 24（trend-radar 补齐后 17 源）。
    run: ({ kv }) => {
      const matrix: Record<string, { add: string[]; affinity: string[] }> = {
        "daily-editorial": { add: ["huggingface-blog", "reddit-localllama", "reddit-agents", "simon-practice", "v2ex-problems", "producthunt-feed", "github"], affinity: ["gzh", "xhs-note"] },
        "small-products": { add: ["hacker-news-top", "hn-algolia", "reddit-localllama", "reddit-agents"], affinity: ["gzh"] },
        "trend-radar": { add: ["github-trending", "hacker-news-top", "hn-algolia", "reddit-agents", "reddit-sd", "simon-practice"], affinity: ["gzh", "xhs-note"] },
      };
      for (const [planId, cfg] of Object.entries(matrix)) {
        const plan = kv.get<any>("plans", planId);
        if (!plan) continue;
        const sourceIds = [...(plan.sourceIds || [])];
        for (const sid of cfg.add) if (!sourceIds.includes(sid) && kv.get("sources", sid)) sourceIds.push(sid);
        kv.put("plans", planId, { ...plan, sourceIds, ...(plan.platformAffinity ? {} : { platformAffinity: cfg.affinity }) });
      }
    },
  },
];

export function runMigrations(ctx: MigrationCtx) {
  // 挂载期保险丝（存储保险丝批 8）：有 pending 迁移（建索引/结构变更=大写入）时，
  // 先在 volume 内快照一份库文件（VACUUM INTO 一致性导出），保留最近 3 份。
  // 空库首启跳过；快照失败只告警不阻塞启动（与备份通道同类语义）。
  const pending = migrations.filter((m) => !ctx.kv.get("meta", m.id));
  if (pending.length && ctx.kv.get("meta", "initialized")) snapshotFuse(ctx, pending.map((m) => m.id));
  ctx.kv.transaction(() => {
    for (const migration of migrations) {
      if (ctx.kv.get("meta", migration.id)) continue;
      migration.run(ctx);
      ctx.kv.put("meta", migration.id, migration.id === "initialized" ? { version: 2 } : { version: 1 });
    }
  });
}

export function snapshotFuse(ctx: { kv: KV; directory: string }, pendingIds: string[]) {
  const dir = path.join(ctx.directory, "snapshots");
  try {
    mkdirSync(dir, { recursive: true });
    // 毫秒级时间戳：同秒多次迁移（多 Store 实例）不撞文件名
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const file = path.join(dir, `fuse-${stamp}.sqlite`);
    ctx.kv.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const all = readdirSync(dir).filter((f) => /^fuse-.*\.sqlite$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 3))) {
      try { rmSync(path.join(dir, old)); } catch { /* best effort */ }
    }
    console.log(`[fuse] 迁移前快照（${pendingIds.join(", ")}）→ snapshots/${path.basename(file)}`);
  } catch (e) {
    console.error(`[fuse] 迁移前快照失败（继续迁移；请检查 volume 剩余空间）:`, e instanceof Error ? e.message : e);
  }
}
