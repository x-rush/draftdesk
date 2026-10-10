// 热词雷达路由（信息架构 v2 增补）：外部 Agent 与内置提取双写 seen-terms；
// UI 无令牌读。PUT merge 语义（批复 D）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { markSeenTermsWrite, mergeSeenTerm } from "../seen-terms";

const statusEnum = z.enum(["new", "rising", "sustained", "archived"]);
const upsertSchema = z.object({
  items: z.array(z.object({
    term: z.string().trim().min(1).max(80),
    sources: z.array(z.string().max(40)).max(20).optional(),
    relatedSearches: z.array(z.string().max(80)).max(20).optional(),
    offTopic: z.boolean().optional(),
    status: statusEnum.optional(),
    frequency: z.number().int().min(0).optional(),
    lastSeenAt: z.string().datetime().optional(),
  })).min(1).max(200),
}).strict();

export const routes: RouteDef[] = [
  {
    methods: ["PUT"],
    pattern: "agent/seen-terms",
    scope: "suggest",
    participants: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = upsertSchema.parse(await readBody());
      const by = `agent:${connection!.name}`;
      let upserted = 0;
      for (const item of parsed.items) {
        mergeSeenTerm(db, item, by);
        upserted++;
      }
      markSeenTermsWrite(db);
      return json({ ok: true, upserted, by });
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/seen-terms",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => json({ items: db.list("seen-terms"), total: db.list("seen-terms").length }),
  },
  {
    // UI 只读口（无令牌）：雷达板块数据源
    methods: ["GET"],
    pattern: "seen-terms",
    handler: ({ db }) => json({ items: db.list("seen-terms"), total: db.list("seen-terms").length }),
  },
];
