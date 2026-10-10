// 热词雷达路由（信息架构 v2 增补）：外部 Agent 与内置提取双写 seen-terms；
// UI 无令牌读。PUT merge 语义（批复 D）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { mergeSeenTerm, observeSeenTerm } from "../seen-terms";
import { requestSeenTermsExtraction, markSeenTermsWrite } from "../seen-extract";

const statusEnum = z.enum(["new", "rising", "sustained", "archived"]);
const intentEnum = z.enum(["informational", "comparison", "commercial", "question"]);
const upsertSchema = z.object({
  items: z.array(z.object({
    term: z.string().trim().min(1).max(80),
    observations: z.number().int().min(0).optional(),
    sources: z.array(z.string().max(40)).max(20).optional(),
    relatedSearches: z.array(z.string().max(80)).max(20).optional(),
    offTopic: z.boolean().optional(),
    status: statusEnum.optional(),
    frequency: z.number().int().min(0).optional(),
    lastSeenAt: z.string().datetime().optional(),
    seed: z.string().trim().max(80).optional(),
    intent: intentEnum.optional(),
  })).min(1).max(200),
}).strict();

export const routes: RouteDef[] = [
  {
    // UI「立即整理/刷新雷达」（信息架构 v2 增补）：写 manual 请求，worker tick 立即执行提取
    methods: ["POST"],
    pattern: "seen-terms/extract",
    handler: ({ db }) => {
      const result = requestSeenTermsExtraction(db);
      return json({ ok: true, ...result, note: result.alreadyDone ? "今日已整理。" : "提取已触发，约 1-2 分钟后雷达与词表自动更新。" });
    },
  },
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
