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
  // 哥飞三指标 + 时间戳（第七轮批2 W7-3/W7-8 外部 Agent 日更同口径；90 天过期由读方判定）
  monthlySearch: z.number().int().min(0).max(100000000).optional(),
  kd: z.number().min(0).max(100).optional(),
  cpc: z.number().min(0).max(1000).optional(),
  gepheiFetchedAt: z.string().datetime().optional(),
}).strict();

const upsertSchema = z.object({ items: z.array(termSchema).min(1).max(200) }).strict();

export const routes: RouteDef[] = [
  {
    // UI 只读口（无令牌）。R10.52①：默认 scope=cards——UI 唯一消费方（站群评估器）
    // 只筛 siteCandidate:true，此前全量 2.4MB/响应曾随 4s 轮询整页下发。
    // ?scope=all 保留全量口（limit/offset 分页）；total 恒为全量计数。
    // 修复项：原实现 items/total 各 list() 一遍=每次请求双倍物化。
    methods: ["GET"],
    pattern: "seo-terms",
    handler: ({ db, query }) => {
      const all = db.list<any>("seo-terms");
      const scope = query.get("scope") || "cards";
      if (scope !== "all") {
        const cards = all.filter((t) => t.siteCandidate === true);
        return json({ items: cards, total: all.length, cards: cards.length, scope: "cards" });
      }
      const limit = Math.min(Math.max(Number(query.get("limit")) || 500, 1), 2000);
      const offset = Math.max(Number(query.get("offset")) || 0, 0);
      return json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset, scope: "all" });
    },
  },
  {
    methods: ["PUT"],
    pattern: "agent/seo-terms",
    scope: "suggest",
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
    handler: ({ db }) => {
      const items = db.list<any>("seo-terms"); // R10.52：单次物化（原 items/total 各一遍）
      return json({ items, total: items.length });
    },
  },
];
