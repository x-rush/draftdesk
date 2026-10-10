// 活动批次归档持久化（信息架构 v2-7）：UI「归档」= 标记不感兴趣（category=其他 + pin=false + reason）。
// 无令牌 UI 路由（human），幂等 upsert；外部 Agent 的正式分类走 agent/activity-categories（suggest）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";

const schema = z.object({
  batchId: z.string().min(1).max(100),
}).strict();

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "activity-batches/archive",
    handler: async ({ db, readBody }) => {
      const { batchId } = schema.parse(await readBody());
      const previous = db.get<any>("activity-categories", batchId);
      db.put("activity-categories", batchId, {
        batchId,
        category: previous?.category ?? "其他",
        pin: false,
        ...(previous?.reason ? { reason: previous.reason } : { reason: "用户标记不感兴趣" }),
        producedBy: previous?.producedBy ?? "human",
        updatedAt: now(),
        ...(previous?.createdAt ? { createdAt: previous.createdAt } : { createdAt: now() }),
      });
      return json({ ok: true, batchId, archived: true });
    },
  },
];
