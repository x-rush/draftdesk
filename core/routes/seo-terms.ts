// 热词趋势数据路由（信息架构 v2-4/5）：外部 Agent 每日 upsert seo-terms。
// 身份键 = term（trim 后小写）；category=主题类，intent=搜索意图（两字段分离，批复 2）；
// siteCandidate + 域名/站型/需求大纲字段供站群评估器（Part 5）消费。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";

export const termSchema = z.object({
  term: z.string().trim().min(1).max(80),
  frequency: z.number().int().min(0).optional(),
  sources: z.array(z.string().max(40)).max(20).optional(),
  lastSeenAt: z.string().datetime().optional(),
  trend7d: z.string().max(60).optional(),
  category: z.string().max(30).optional(),
  intent: z.enum(["怎么选型", "怎么装", "怎么修", "免费替代", "价格对比", "其他"]).optional(),
  sourceUrls: z.array(z.string().max(2048)).max(20).optional(),
  siteCandidate: z.boolean().optional(),
  domainSuggestions: z.array(z.string().max(120)).max(10).optional(),
  siteType: z.enum(["资讯站", "工具站"]).optional(),
  siteRationale: z.string().max(600).optional(),
  contentOutline: z.array(z.string().max(200)).max(8).optional(),
}).strict();

const upsertSchema = z.object({ items: z.array(termSchema).min(1).max(200) }).strict();

export const routes: RouteDef[] = [
  {
    methods: ["PUT"],
    pattern: "agent/seo-terms",
    scope: "suggest",
    participants: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = upsertSchema.parse(await readBody());
      const by = `agent:${connection!.name}`;
      const stamp = now();
      let upserted = 0;
      for (const t of parsed.items) {
        const id = t.term.toLowerCase();
        const previous = db.get<any>("seo-terms", id);
        db.put("seo-terms", id, { ...(previous ?? {}), ...t, term: t.term, id, producedBy: by, updatedAt: stamp, ...(previous?.createdAt ? { createdAt: previous.createdAt } : { createdAt: stamp }) });
        upserted++;
      }
      return json({ ok: true, upserted, by });
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/seo-terms",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => json({ items: db.list("seo-terms"), total: db.list("seo-terms").length }),
  },
];
