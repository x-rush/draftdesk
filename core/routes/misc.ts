// 长尾：健康检查、工作台快照、全量导出、研究策略保存。
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { planSchema, type Plan } from "../schema";
import { termId } from "../seen-terms";
import { dailyMetricsCandidates, siteGateOf, isEnglishTerm } from "../seo-gate";
import { gepheiToolLinks } from "../seo-source";

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
      const gate = siteGateOf(db);
      const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
      const checks = dailyMetricsCandidates(db, gate, markedIds)
        .filter((t) => isEnglishTerm(String(t.term || t.id)))
        .slice(0, 5)
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
      return json({
        generatedAt: now(),
        pendingOutlines: outlinesPending,
        pendingDecisions: decisionsPending,
        todayChecks: { total: checks.length, terms: checks },
        fourSources,
      });
    },
  },
  {
    // 手动触发内置分析（信息架构 v2 增补）：入队 job，worker 认领后跑整理/提词/审核链
    methods: ["POST"],
    pattern: "plans/:id/analyze",
    handler: async ({ db, params }) => {
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
