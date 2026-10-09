// 创作活动域：采集批次回传（浏览器插件，5MB 限额）、AI 初筛（consumerMode/aiPolicy 门控）、官方规则入证。
import { z } from "zod";
import { activityPageSchema, trustedActivityRulesUrl } from "../activity-import";
import { activityBatchSchema } from "../activity-batch";
import { triageActivityBatches, type ActivityTriageRecord } from "../activity-triage";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, hash, now } from "../store";

export const routes: RouteDef[] = [
  {
    methods: ["GET"],
    pattern: "activity-batches",
    handler: ({ db }) => json(db.list<{ id: string; receivedAt: string; bundle: { platform: string; items: unknown[]; coverage?: unknown } }>("activity-batches").map(({ id, receivedAt, bundle }) => ({ id, receivedAt, platform: bundle.platform, count: bundle.items.length, hasCoverage: Boolean(bundle.coverage) }))),
  },
  {
    methods: ["GET"],
    pattern: "activity-batches/:id",
    handler: ({ db, params }) => {
      const record = db.get("activity-batches", params.id);
      if (!record) throw new AppError("采集结果不存在", 404);
      return json(record);
    },
  },
  {
    methods: ["GET"],
    pattern: "activity-triage",
    handler: ({ db }) => json(db.list<ActivityTriageRecord>("activity-triage").map(({ id, createdAt, batchIds, keywords, totalCount, selectedCount, modelTokens }) => ({ id, createdAt, batchIds, keywords, totalCount, selectedCount, modelTokens }))),
  },
  {
    methods: ["GET"],
    pattern: "activity-triage/:id",
    handler: ({ db, params }) => {
      const record = db.get<ActivityTriageRecord>("activity-triage", params.id);
      if (!record) throw new AppError("活动初筛结果不存在", 404);
      return json(record);
    },
  },
  {
    // 浏览器插件回传：5MB 限额（旧链 body(req, 5000000)），按内容散列幂等
    methods: ["POST"],
    pattern: "activity-batches",
    handler: async ({ db, readBody }) => {
      const bundle = activityBatchSchema.parse(await readBody(5000000));
      if (bundle.items.some((item) => item.platform !== bundle.platform)) throw new AppError("活动包的平台与条目不一致");
      const id = hash(JSON.stringify(bundle));
      const previous = db.get<{ receivedAt: string }>("activity-batches", id);
      const receivedAt = previous?.receivedAt || now();
      if (!previous) db.put("activity-batches", id, { id, receivedAt, bundle });
      return json({ ok: true, id, platform: bundle.platform, count: bundle.items.length, duplicate: !!previous, receivedAt }, previous ? 200 : 201);
    },
  },
  {
    methods: ["POST"],
    pattern: "activity-triage",
    handler: async ({ db, req, readBody }) => {
      const consumerMode = db.get("config", "consumerMode") || "external";
      if (consumerMode === "external")
        return json({ skipped: true, reason: "消费执行方为外部 Agent（consumerMode=external）：内置初筛停用，聚合分类由外部 Agent 经 /api/v1/agent/clusters 写回。", results: [] });
      const aiPolicy = db.get<any>("config", "aiPolicy");
      if ((aiPolicy?.triage || "off") === "off")
        return json({ skipped: true, reason: "内置初筛已关闭（aiPolicy.triage=off）；聚合分类由外部 Agent 经 /api/v1/agent/clusters 写回，或人工处理。", results: [] });
      const value = z.object({ batchIds: z.array(z.string().min(1)).min(1).max(4), keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(8) }).strict().parse(await readBody());
      return json(await triageActivityBatches(db, value.batchIds, value.keywords, req.signal), 201);
    },
  },
  {
    methods: ["POST"],
    pattern: "activity-evidence",
    handler: async ({ db, readBody }) => {
      const value = activityPageSchema.parse({ schemaVersion: "draftdesk.activity-page.v1", ...(await readBody() as object) });
      const evidence = db.addEvidence({ title: value.title, url: value.url, excerpt: value.text, collectedAt: new Date().toISOString(), sourceType: trustedActivityRulesUrl(value.url) ? "official" : "other", region: "中国", language: "zh", contentLevel: "excerpt" }, "manual-activity-rules");
      return json({ evidenceId: evidence.id });
    },
  },
];
