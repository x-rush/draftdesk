// 创作活动 AI 整理路由（信息架构 v2-7）：外部 Agent 按采集批次写入分类与置顶。
// 身份键 = batchId（activity-batches 的内容散列 id）；同键后写覆盖（合并式保留 createdAt）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";

const upsertSchema = z.object({
  items: z.array(z.object({
    batchId: z.string().min(1).max(100),
    category: z.enum(["比赛", "征稿", "激励计划", "其他"]),
    pin: z.boolean().optional(),
    reason: z.string().max(300).optional(),
  })).min(1).max(100),
}).strict();

export const routes: RouteDef[] = [
  {
    methods: ["PUT"],
    pattern: "agent/activity-categories",
    scope: "suggest",
    participants: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = upsertSchema.parse(await readBody());
      const by = `agent:${connection!.name}`;
      const stamp = now();
      let upserted = 0;
      for (const item of parsed.items) {
        const previous = db.get<any>("activity-categories", item.batchId);
        db.put("activity-categories", item.batchId, {
          batchId: item.batchId,
          category: item.category,
          pin: item.pin === true,
          ...(item.reason ? { reason: item.reason } : {}),
          producedBy: by,
          updatedAt: stamp,
          ...(previous?.createdAt ? { createdAt: previous.createdAt } : { createdAt: stamp }),
        });
        upserted++;
      }
      return json({ ok: true, upserted, by });
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/activity-categories",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => json({ items: db.list("activity-categories"), total: db.list("activity-categories").length }),
  },
];
