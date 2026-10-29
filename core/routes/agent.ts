// 外部 Agent 读取域（read scope）：热榜/证据/产物/决策队列/统计/人设开关 + MCP。
// 文件末尾的 agent/:rest... 兜底必须保持最后注册——未知 agent 路径先鉴权再 404（保序矩阵）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { paginatedSql } from "../http/pagination";
import { AppError, now } from "../store";
import { agentHotspots, agentEvidence, agentArtifacts, agentArtifact, agentStats, mcpRpc } from "../agent-read";
import { siteGateOf } from "../seo-gate";

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

import { triageGroupsPayload } from "./triage";

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
    // R10.7 P0-2：外部消费链路读口——组视角与归档（read scope；原 none-scope 的 /triage/groups
    // 对带令牌的 Agent 实测 403，agent/* 下又无对应路由，R10 第③段在接口层断链）
    methods: ["GET"],
    pattern: "agent/triage/groups",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const jobId = query.get("jobId") || "";
      return json(triageGroupsPayload(db, jobId));
    },
  },
  {
    methods: ["GET"],
    pattern: "agent/triage/archive",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const jobId = query.get("jobId") || "";
      const rows = jobId
        ? db.list<any>("triage-archive").filter((r) => r.jobId === jobId)
        : db.list<any>("triage-archive").sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 14);
      return json({ items: rows.map((r) => ({ jobId: r.jobId, day: r.day, at: r.at, groups: (r.groups || []).map((g: any) => ({ id: g.id, title: g.title, reason: g.reason, members: (g.memberUrls || []).length })) })), total: db.list<any>("triage-archive").length });
    },
  },
  {
    // R10 第3段：消费回执——外部 Agent 每次跑完 ping；审查台显示「外部已消费 N 条/最后运行」，
    // 超 24h 未跑提醒（给老大的运维信号，不触发内置补稿——消费二选一，互斥不动）。
    methods: ["POST"],
    pattern: "agent/consume-report",
    scope: "consume",
    methodGuardFirst: true,
    handler: async ({ db, connection, readBody }) => {
      const parsed = z.object({
        consumed: z.number().int().min(0).max(10000),
        note: z.string().max(300).optional(),
      }).strict().parse(await readBody());
      const at = new Date().toISOString();
      db.put("meta", "agent-consume-report", { at, by: `agent:${connection!.name}`, consumed: parsed.consumed, ...(parsed.note ? { note: parsed.note } : {}) });
      return json({ ok: true, at, staleAfter: new Date(Date.parse(at) + 24 * 3600000).toISOString() });
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
  // siteGate 站群门槛（第七轮 W7-4）：外部 Agent 标注逻辑读同一份规则（规则同源，v1 硬编码白名单废弃）
  { methods: ["GET"], pattern: "agent/siteGate", scope: "read", methodGuardFirst: true, handler: ({ db }) => json(siteGateOf(db)) },
  { methods: ["GET"], pattern: "agent/clusters", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(paginatedSql(db.kv, "clusters", query)) },
  { methods: ["GET"], pattern: "agent/outlines", scope: "read", methodGuardFirst: true, handler: ({ db, query }) => json(paginatedSql(db.kv, "outlines", query)) },
  {
    methods: ["GET"],
    pattern: "agent/decisions",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const rawStatus = query.get("status") || undefined;
      const status = rawStatus === "all" ? undefined : rawStatus;
      return json({ items: db.decisionsQueue(status, { includeAll: query.get("includeArchived") === "1" }), generatedAt: now() });
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
    // R10.22-1：候选明细读口——外部 Agent 拉候选（分页，按状态过滤）
    methods: ["GET"],
    pattern: "agent/triage/candidates",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const jobId = query.get("jobId") || "";
      const status = query.get("status") || "";
      const limit = Math.min(500, Math.max(1, Number(query.get("limit")) || 200));
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      const record = jobId ? db.get<any>("discovery", jobId) : db.list<any>("discovery").sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
      if (!record) throw new AppError("采集批次不存在", 404, "NOT_FOUND");
      let candidates = (record.candidates || []).filter((c: any) => !status || c.status === status);
      const total = candidates.length;
      const items = candidates.slice(offset, offset + limit).map((c: any) => ({
        title: c.title, url: c.url, sourceName: c.sourceName, status: c.status,
        reason: c.reason, attention: c.attention, groupId: c.groupId, observedAt: c.observedAt,
      }));
      return json({ jobId: record.jobId, planName: record.planName, at: record.at, items, total, offset, limit });
    },
  },
  {
    // 命名空间兜底（必须最后注册）
    methods: ["GET"],
    pattern: "agent/:rest...",
    scope: "read",
    methodGuardFirst: true,
    handler: () => { throw new AppError("接口不存在", 404); },
  },
];
