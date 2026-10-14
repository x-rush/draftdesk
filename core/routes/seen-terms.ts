// 热词雷达路由（信息架构 v2 增补）：外部 Agent 与内置提取双写 seen-terms；
// UI 无令牌读。PUT merge 语义（批复 D）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { mergeSeenTerm, observeSeenTerm, querySeenTerms, seenTermZones, seenIntentCounts, seenRegionCounts, seenRelevanceCounts } from "../seen-terms";
import { requestSeenTermsExtraction, markSeenTermsWrite } from "../seen-extract";
import { computeObsRatio, judgeVerdict, deriveSerpFields, isSerpStale } from "../seen-judge";
import { siteGateOf, siteCandidateEligibleOf } from "../seo-gate";

const statusEnum = z.enum(["new", "rising", "sustained", "archived"]);
const intentEnum = z.enum(["informational", "comparison", "commercial", "question"]);
const demandIntentEnum = z.enum(["tool", "info", "nav"]);
const relevanceEnum = z.enum(["strong", "weak", "off"]);
const regionEnum = z.enum(["global", "cn"]);
const upsertSchema = z.object({
  items: z.array(z.object({
    term: z.string().trim().min(1).max(80),
    observations: z.number().int().min(0).optional(),
    sources: z.array(z.string().max(40)).max(20).optional(),
    relatedSearches: z.array(z.string().max(80)).max(20).optional(),
    offTopic: z.boolean().optional(),
    relevance: relevanceEnum.optional(),
    region: regionEnum.optional(),
    demandIntent: demandIntentEnum.optional(),
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
      return json({ ok: true, ...result, note: result.alreadyDone ? "今日已整理。" : "热词提取与挖掘已触发（联想展开/PAA/Trends Rising 需数分钟），完成后雷达与词表自动更新。" });
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
    handler: ({ db, query }) => json(seenListPayload(db, query)),
  },
  {
    // UI 只读口（无令牌）：雷达板块数据源。支持 ?limit&offset&status&intent&q
    //（默认 50 上限 200，status 权重 + lastSeenAt 降序）；响应附三区与意图计数。
    methods: ["GET"],
    pattern: "seen-terms",
    handler: ({ db, query }) => json(seenListPayload(db, query)),
  },
];

// 列表 + 三区 + 计数一次出（SQLite 下推，3 万条量级 <100ms）。
// region 筛选（海外定位批）：?region=global|cn|（空=全部）。
function seenListPayload(db: any, query: URLSearchParams) {
  const limit = Math.min(200, Math.max(1, Number(query.get("limit")) || 50));
  const offset = Math.max(0, Number(query.get("offset")) || 0);
  const status = query.get("status") || "";
  const intent = query.get("intent") || "";
  const region = query.get("region") || "";
  const origin = query.get("origin") || "";
  // q 与 termId 同口径去内部空格：id 归一化后无空格，带空格查询（"codex ai"）否则永远 miss
  const q = (query.get("q") || "").replace(/\s+/g, "").toLowerCase().slice(0, 80);
  const list = querySeenTerms(db.kv, { limit, offset, status, intent, region, q, origin });
  // 判定层（海外定位批 5）：每词附 obsRatio 与值不值得做三档（无外部调用，纯读时计算）
  const gate = siteGateOf(db);
  const items = list.items.map((t) => {
    const { verdict, reason } = judgeVerdict(t);
    // siteCandidate 候选池判定口（第六轮批 B §2.5② 双通道 + 第七轮 W7-1 意图通道，
    // 读 siteGate 数值：改 siteGate 即生效）。
    return { ...t, obsRatio: computeObsRatio(t), verdict, verdictReason: reason, serpDerived: deriveSerpFields(t), serpStale: isSerpStale(t), siteCandidateEligible: siteCandidateEligibleOf(t, gate) };
  });
  return {
    items,
    total: list.total,
    limit,
    offset,
    counts: seenIntentCounts(db.kv),
    regions: seenRegionCounts(db.kv),
    relevances: seenRelevanceCounts(db.kv),
    zones: seenTermZones(db.kv),
    // 来源层计数（W7-10① chips）：哥飞趋势/哥飞拓词/常规采集
    originCounts: {
      "gephei-trends": (db.kv.sqlRows("SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.sources') LIKE '%gephei-trends%'")[0] as { c: number }).c,
      "gephei-ideas": (db.kv.sqlRows("SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.sources') LIKE '%gephei-ideas%'")[0] as { c: number }).c,
      "gephei-newwords": (db.kv.sqlRows("SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.sources') LIKE '%gephei-newwords%'")[0] as { c: number }).c,
      normal: (db.kv.sqlRows("SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.sources') NOT LIKE '%gephei-%'")[0] as { c: number }).c,
    },
  };
}
