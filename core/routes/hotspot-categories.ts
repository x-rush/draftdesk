"use client";
// 热点分类路由（信息架构 v2-3）：外部 Agent 按热点 urlKey 写入 AI 分类；
// 身份键 = urlKey(url)（与热点列表/消费同口径），同键后写覆盖（幂等 upsert）。
// 读：GET /agent/hotspot-categories（read scope，全量或按 ids）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { urlKey } from "../hotspots";

// 7 类枚举（设计定案；新增类别需改此处 + 设置页订阅多选）
export const HOTSPOT_CATEGORIES = ["模型动态", "Agent生态", "图像视频", "开发工具", "成本额度", "教程实战", "其他"] as const;

const upsertSchema = z.object({
  items: z.array(z.object({
    url: z.string().min(1).max(2048),
    category: z.enum(HOTSPOT_CATEGORIES),
  })).min(1).max(500),
}).strict();

export function categoryIdentity(url: string): string {
  return urlKey(url);
}

export const routes: RouteDef[] = [
  {
    methods: ["PUT"],
    pattern: "agent/hotspot-categories",
    scope: "suggest",
    participants: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = upsertSchema.parse(await readBody());
      const by = `agent:${connection!.name}`;
      const stamp = now();
      let upserted = 0;
      const identities: string[] = [];
      for (const item of parsed.items) {
        const identity = categoryIdentity(item.url);
        if (!identity) throw new AppError("热点 url 无法归一化。", 400, "INVALID_PAYLOAD");
        const previous = db.get<any>("hotspot-categories", identity);
        db.put("hotspot-categories", identity, {
          identity,
          category: item.category,
          producedBy: by,
          updatedAt: stamp,
          ...(previous?.createdAt ? { createdAt: previous.createdAt } : { createdAt: stamp }),
        });
        identities.push(identity);
        upserted++;
      }
      return json({ ok: true, upserted, identities, by });
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/hotspot-categories",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const ids = query.get("ids");
      let items = db.list<any>("hotspot-categories");
      if (ids) {
        const wanted = new Set(ids.split(",").map((s) => s.trim()).filter(Boolean));
        items = items.filter((c) => wanted.has(c.identity));
      }
      return json({ items, total: items.length });
    },
  },
];
