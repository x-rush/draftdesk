// 长尾：健康检查、工作台快照、全量导出、研究策略保存。
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { planSchema, type Plan } from "../schema";
import { termId } from "../seen-terms";
import { dailyMetricsCandidates, siteGateOf, isEnglishTerm } from "../seo-gate";
import { gepheiToolLinks } from "../seo-source";
import { shanghaiDay } from "../model-metrics";

export const routes: RouteDef[] = [
  { methods: ["GET"], pattern: "health", handler: () => json({ ok: true, version: "2.0.0" }) },
  { methods: ["GET"], pattern: "workspace", handler: ({ db, query }) => json(db.snapshot(query.has("page") ? query : undefined)) },
  {
    methods: ["GET"],
    pattern: "export",
    handler: ({ db }) => json({
      schemaVersion: "2.0",
      exportedAt: now(),
      artifacts: db.list("artifacts"),
      evidence: db.list("evidence"),
      discovery: db.list("discovery"),
      events: db.list("events"),
      metrics: db.list("metrics"),
      plans: db.list("plans"),
      sources: db.list("sources"),
      jobs: db.list("jobs"),
      conversations: db.list("conversations"),
      decisions: db.list("decisions"),
      clusters: db.list("clusters"),
      outlines: db.list("outlines"),
    }),
  },
  {
    // 今日摘要（R9-4②）：一次请求给齐「今天该看什么」——供外部每日摘要（小拾 03:10）调用。
    // 四段：审查台待拍（大纲+决策）/ 今日待查（共享质量闸英文前 5 词+深链）/ 四聚合源昨晚候选数。
    methods: ["GET"],
    pattern: "summary/today",
    handler: ({ db }) => {
      const shDayKey = shanghaiDay(); // R10.11-4：统一上海日口径
      const gate = siteGateOf(db);
      const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
      const checks = dailyMetricsCandidates(db, gate, markedIds)
        .filter((t) => isEnglishTerm(String(t.term || t.id)))
        .slice(0, 10)
        .map((t) => ({
          term: String(t.term || t.id),
          observations: t.observations ?? 0,
          links: gepheiToolLinks(String(t.term || t.id)).slice(0, 3),
        }));
      const outlinesPending = db.list<any>("outlines").filter((o) => o.decision === "pending").length;
      const decisionsPending = db.list<any>("decisions").filter((d) => d.decision === "pending").length;
      // 四聚合源候选数：最新一次含该源的 discovery 批次（昨日 01:15 定时或手动触发）
      const fourSources: Record<string, number> = {};
      const dailySources = ["dailyhot-tieba", "dailyhot-toutiao", "dailyhot-douyin", "dailyhot-zhihu"];
      const latest = db.list<any>("discovery")
        .filter((r) => (r.sources || []).some((s: any) => dailySources.includes(String(s.sourceId))))
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
      if (latest) {
        for (const sid of dailySources) {
          const cov = (latest.sources || []).find((s: any) => s.sourceId === sid);
          fourSources[sid] = cov ? (latest.candidates || []).filter((c: any) => c.sourceId === sid).length : 0;
        }
      }
      // R10 第3段：外部消费回执（超 24h 未跑标记 stale——运维提醒信号，不触发内置补稿）
      const report = db.get<any>("meta", "agent-consume-report");
      const externalConsumption = report
        ? { by: report.by, consumed: report.consumed ?? 0, stale: Date.now() - Date.parse(report.at) > 24 * 3600000 }
        : null;
      // R10 第1段：今日全量采集批次概况；R10.2② 附初筛状态（done/failed/pending——失败含归因可查）
      const collectAll = db.get<any>("meta", "collect-all-done:" + shDayKey);
      const caJob = "collectall-" + shDayKey;
      const caTriageDone = db.get<any>("candidate-groups", "tg-" + caJob);
      const caTriageFail = db.get<any>("meta", "triage-fail:" + caJob);
      // R10.19-3：external 模式 triage 状态=外部处理状态（pending→02:00 外部 Agent 执行）
      const isExternal = (db.get("config", "consumerMode") || "external") === "external";
      const collectAllTriage = caTriageDone
        ? { state: "done" as const, engine: caTriageDone.source === "external" ? "external" as const : "builtin" as const }
        : isExternal
          ? { state: "pending" as const, engine: "external" as const, note: "等待外部 Agent 02:00 语义处理" }
          : caTriageFail
            ? { state: "failed" as const, at: caTriageFail.at, error: String(caTriageFail.error || "").slice(0, 160) }
            : { state: "pending" as const, engine: "builtin" as const };
      // R10.8 P1-2：六段总览补齐——组分布 / 机会卡数 / 今日已拍
      // R10.11-4②：优先当日 collectall 批；无则回落最新并标注批次来源
      const todayCa = db.get<any>("candidate-groups", "tg-collectall-" + shDayKey);
      const latestGroups = todayCa || db.list<any>("candidate-groups").sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
      const groupStats = latestGroups
        ? { strong: latestGroups.groups.filter((g: any) => g.attention === "strong").length, potential: latestGroups.groups.filter((g: any) => g.attention === "potential").length, none: latestGroups.groups.filter((g: any) => g.attention === "none").length }
        : null;
      const opportunities = db.list<any>("opportunities").length;
      // R10.11-4①：decidedToday 改上海日（原 UTC 口径漏今晨 04:12 的拍板）
      const decidedToday = db.list<any>("outlines").filter((o: any) => {
        if (!o.decidedAt || !o.decision || o.decision === "pending") return false;
        try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(o.decidedAt)) === shDayKey; } catch { return false; }
      }).length
        + db.list<any>("decisions").filter((d: any) => {
          if (!d.decidedAt || !d.decision || d.decision === "pending") return false;
          try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(d.decidedAt)) === shDayKey; } catch { return false; }
        }).length;
      // R10.11-4③：入池=discovery 实况 status=watch 计数（原 raw−trimmed 把非当日 filtered 算入）
      const todayRecord = db.get<any>("discovery", "collectall-" + shDayKey);
      const inPool = todayRecord ? todayRecord.candidates.filter((c: any) => c.status === "watch" || c.status === "selected").length : null;
      return json({
        groups: groupStats,
        inPool,
        opportunities,
        decidedToday,
        pendingOutlines: outlinesPending,
        pendingDecisions: decisionsPending,
        todayChecks: { total: checks.length, terms: checks },
        fourSources,
        collectAll: collectAll ? { sources: collectAll.sources, raw: collectAll.raw, trimmed: collectAll.trimmed ?? 0, triage: collectAllTriage } : null,
        externalConsumption,
      });
    },
  },
  {
    // R10.13：DiscoveryLens 按需拉全量候选（workspace 的 discovery 已瘦身为摘要）
    methods: ["GET"],
    pattern: "discovery/:jobId",
    handler: ({ db, params }) => {
      const record = db.get<any>("discovery", params.jobId);
      if (!record) throw new AppError("批次不存在", 404, "NOT_FOUND");
      return json(record);
    },
  },
  {
    // 手动触发内置分析（信息架构 v2 增补）：入队 job，worker 认领后跑整理/提词/审核链；
    // R10.24-1：external 模式门控——内置分析全链停用，不假装接受
    methods: ["POST"],
    pattern: "plans/:id/analyze",
    handler: async ({ db, params }) => {
      if ((db.get("config", "consumerMode") || "external") !== "builtin") {
        return json({ ok: false, skipped: true, reason: "external 模式由外部 Agent 执行，内置分析已停用；如需内置链请切 consumerMode=builtin。" });
      }
      const plan = db.get<any>("plans", params.id);
      if (!plan) throw new AppError("研究策略不存在", 404);
      if (plan.kind === "activities") throw new AppError("活动策略无内置分析；采集走登录浏览器流程。", 400);
      const running = db.list<any>("jobs").some((j) => j.planId === params.id && j.state === "running");
      if (running) return json({ ok: true, triggered: false, running: true });
      const job = db.enqueue(params.id, [], undefined, undefined, true);
      return json({ ok: true, triggered: true, jobId: job!.id }, 202);
    },
  },
  {
    methods: ["POST"],
    pattern: "plans",
    handler: async ({ db, readBody }) => {
      const plan = planSchema.parse(await readBody());
      if (plan.sourceIds.some((id) => !db.get("sources", id)))
        throw new AppError("策略引用未知来源");
      if (plan.scheduleEnabled && !db.config().apiKey)
        throw new AppError("请配置模型后再开启定时任务。");
      if (plan.kind === "activities" && plan.scheduleEnabled) throw new AppError("活动采集由登录浏览器主动执行，不能设置服务器定时任务。");
      const previous = db.get<Plan>("plans", plan.id);
      const saved = { ...plan, scheduleActivatedAt: plan.scheduleEnabled ? (previous?.scheduleEnabled ? previous.scheduleActivatedAt : now()) : undefined };
      db.put("plans", plan.id, saved);
      return json(saved);
    },
  },
];
