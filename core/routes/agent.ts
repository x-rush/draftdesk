// 外部 Agent 读取域（read scope）：热榜/证据/产物/决策队列/统计/人设开关 + MCP。
// 文件末尾的 agent/:rest... 兜底必须保持最后注册——未知 agent 路径先鉴权再 404（保序矩阵）。
import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { paginatedSql } from "../http/pagination";
import { AppError, now } from "../store";
import { agentHotspots, agentEvidence, agentArtifacts, agentArtifact, agentStats, mcpRpc } from "../agent-read";
import { seoSourceOf, seoBudgetUsed } from "../seo-source";
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
  {
    // R10.53：运维水位只读口——小拾每日简报的磁盘/内存/备份检查数据源。
    // 容器与宿主机共享内核：/proc/meminfo 即宿主真值；statfs 看数据盘（bind mount）。
    // BWH 月流量不在容器视野内——小拾侧经 KiwiVM API 拉取（VEID+API key 由老大面板生成）。
    methods: ["GET"],
    pattern: "agent/opsVitals",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => {
      // /proc/meminfo 仅 Linux 存在（容器共享内核=宿主真值）；Windows 本地/测试降级 null
      let mem: { totalMb: number; availMb: number; swapUsedMb: number } | null = null;
      try {
        const raw = {} as Record<string, number>;
        for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
          const m = line.match(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB/);
          if (m) raw[m[1]] = Number(m[2]) * 1024;
        }
        mem = {
          totalMb: Math.round((raw.MemTotal || 0) / 1048576),
          availMb: Math.round((raw.MemAvailable || 0) / 1048576),
          swapUsedMb: Math.round(((raw.SwapTotal || 0) - (raw.SwapFree || 0)) / 1048576),
        };
      } catch { /* 非 Linux 平台 */ }
      const st = statfsSync(db.directory);
      const jan = db.get<any>("meta", "janitor");
      return json({
        disk: {
          mount: db.directory,
          totalGb: Math.round((Number(st.blocks) * Number(st.bsize)) / 1e9 * 10) / 10,
          freeGb: Math.round((Number(st.bavail) * Number(st.bsize)) / 1e9 * 10) / 10,
          usedPct: Math.round((1 - Number(st.bavail) / Number(st.blocks)) * 1000) / 10,
        },
        mem,
        // janitor 日批单键：day=最近跑批日，backup 子对象含当日备份结果/跳过原因
        backup: jan ? { day: jan.day, at: jan.at, result: jan.backup ?? null } : null,
        serverUptimeDays: Math.round(os.uptime() / 86400 * 10) / 10,
        generatedAt: now(),
      });
    },
  },
  {
    // R10.47：哥飞 pools 只读校验口（生产迁移后外部 Agent 无容器内 DB 通道，
    // 每日主分析第 8 步「验证 tier.budget=0」凭此闭环）——与 UI 口同款脱敏（token 只回 hasToken）。
    methods: ["GET"],
    pattern: "agent/seoDataSource",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db }) => {
      const src = seoSourceOf(db);
      const budgetKeys = { tier: "builtinTierBudget", metrics: "builtinMetricsBudget", collect: "builtinCollectBudget" } as Record<string, "builtinTierBudget" | "builtinMetricsBudget" | "builtinCollectBudget">;
      const pools = (["tier", "metrics", "collect"] as const).map((p) => ({ pool: p, used: seoBudgetUsed(db, p), budget: src[budgetKeys[p]] }));
      return json({ enabled: src.enabled, provider: src.provider, pools, hasToken: !!src.token, autoMetrics: src.autoMetrics, autoCollect: src.autoCollect });
    },
  },
  {
    // R10.51：机会卡只读口——写口 PUT /agent/opportunities 早已闭环，读侧此前 404，
    // 小拾每日机会评估的简报无法核验池子状态（写没写进去/池里有什么）。read scope。
    methods: ["GET"],
    pattern: "agent/opportunities",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const limit = Math.min(Math.max(Number(query.get("limit")) || 100, 1), 200);
      const offset = Math.max(Number(query.get("offset")) || 0, 0);
      const all = db.list<any>("opportunities").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const items = all.slice(offset, offset + limit).map((o) => ({
        id: o.id, title: o.title, oneLiner: o.oneLiner, form: o.form, kind: o.kind,
        verdict: o.verdict, verdictReason: o.verdictReason, source: o.source,
        monetization: o.monetization, signals: o.signals, createdAt: o.createdAt, updatedAt: o.updatedAt,
      }));
      return json({ items, total: all.length, limit, offset, generatedAt: now() });
    },
  },
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
