// 外部 Agent 读取域（read scope）：热榜/证据/产物/决策队列/统计/人设开关 + MCP。
// 文件末尾的 agent/:rest... 兜底必须保持最后注册——未知 agent 路径先鉴权再 404（保序矩阵）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { paginated } from "../http/pagination";
import { AppError, now } from "../store";
import { agentHotspots, agentEvidence, agentArtifacts, agentArtifact, agentStats, mcpRpc } from "../agent-read";

const listQuery = (query: URLSearchParams) => {
  const raw = Object.fromEntries(query.entries());
  const numeric = (key: string) => (raw[key] === undefined ? undefined : Number(raw[key]));
  const params = {
    q: raw.q,
    source: raw.source,
    sourceType: raw.sourceType,
    kind: raw.kind,
    quality: raw.quality,
    days: numeric("days"),
    limit: numeric("limit"),
    cursor: raw.cursor,
  };
  Object.keys(params).forEach((k) => (params as any)[k] === undefined && delete (params as any)[k]);
  return params;
};

export const routes: RouteDef[] = [
  // 方法截获器：mcp 与 suggestions 只认 POST/PATCH，其余方法先 405（旧 read 块 methodOk 语义）
  { methods: ["GET", "PUT", "DELETE"], pattern: "mcp", preAuth405: true, handler: () => { throw new Error("unreachable"); } },
  { methods: ["GET", "PUT", "DELETE"], pattern: "agent/suggestions", preAuth405: true, handler: () => { throw new Error("unreachable"); } },
  {
    // MCP 网关（read scope）：通知（无 id）不回包按 202
    methods: ["POST", "PATCH"],
    pattern: "mcp",
    scope: "read",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
      const reply = mcpRpc(db, await readBody());
      if (!reply) return new Response(null, { status: 202 });
      return json(reply);
    },
  },
  {
    // 建议多源并存：外部 Agent 只写建议，不直接改 decision（§12.1 分权）
    methods: ["POST", "PATCH"],
    pattern: "agent/suggestions",
    scope: "read",
    methodGuardFirst: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = z.object({
        targetType: z.enum(["artifact", "outline", "decision"]),
        targetId: z.string().min(1),
        verdict: z.enum(["approved", "rejected", "deferred", "drafting", "published"]),
        score: z.number().min(0).max(5).optional(),
        platforms: z.array(z.string().max(30)).max(6).optional(),
        reason: z.string().max(600).optional(),
      }).strict().parse(await readBody());
      const updated = db.addSuggestion(parsed.targetId, { by: `agent:${connection!.name}`, verdict: parsed.verdict, score: parsed.score, platforms: parsed.platforms, reason: parsed.reason });
      return json({ ok: true, id: updated.id, suggestions: updated.suggestions });
    },
  },
  { methods: ["GET"], pattern: "agent/persona", scope: "read", methodGuardFirst: true, handler: ({ db }) => json(db.get("config", "persona") || null) },
  { methods: ["GET"], pattern: "agent/aiPolicy", scope: "read", methodGuardFirst: true, handler: ({ db }) => json(db.get("config", "aiPolicy") || null) },
  { methods: ["GET"], pattern: "agent/consumerMode", scope: "read", methodGuardFirst: true, handler: ({ db }) => json(db.get("config", "consumerMode") || null) },
  { methods: ["GET"], pattern: "agent/clusters", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(paginated(db.list("clusters").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)), query)) },
  { methods: ["GET"], pattern: "agent/outlines", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(paginated(db.list("outlines").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)), query)) },
  {
    methods: ["GET"],
    pattern: "agent/decisions",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const rawStatus = query.get("status") || undefined;
      const status = rawStatus === "all" ? undefined : rawStatus;
      return json({ items: db.decisionsQueue(status), generatedAt: now() });
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/decisions/stats",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => json(db.decisionsStats()),
  },
  { methods: ["GET"], pattern: "agent/hotspots", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(agentHotspots(db, listQuery(query))) },
  { methods: ["GET"], pattern: "agent/evidence", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(agentEvidence(db, listQuery(query))) },
  { methods: ["GET"], pattern: "agent/artifacts", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(agentArtifacts(db, listQuery(query))) },
  {
    methods: ["GET"],
    pattern: "agent/artifacts/:id",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, params }) => {
      const detail = agentArtifact(db, params.id);
      if (!detail) throw new AppError("产物不存在", 404);
      return json(detail);
    },
  },
  { methods: ["GET"], pattern: "agent/stats", scope: "read", methodGuardFirst: true, handler: ({ db }) => json(agentStats(db)) },
  {
    // 命名空间兜底（必须最后注册）。methods 只有 GET：
    // GET 未知路径 → 鉴权后 404「接口不存在」（坏令牌 = 401 先行）；
    // 非 GET 到 agent/* 而无具体路由接住 → 落到此定义的 fallback，methodGuardFirst 405 先行。
    methods: ["GET"],
    pattern: "agent/:rest...",
    scope: "read",
    methodGuardFirst: true,
    handler: () => { throw new AppError("接口不存在", 404); },
  },
];
