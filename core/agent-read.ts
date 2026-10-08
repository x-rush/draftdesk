import { z } from "zod";
import type { Store } from "./store";
import { urlKey } from "./hotspots";

const isoNow = () => new Date().toISOString();

// 外部 Agent 只读投影：REST（/api/v1/agent/*）与 MCP（/api/v1/mcp）共用同一实现。
// 边界（写入 docs/external-onboarding.md）：
//   - 只读；不触发模型调用、不消耗预算
//   - 永不暴露：API Key、模型配置、讨论会话、外部原始提交包
//   - 证据只给 excerpt 摘要（≤2000 字符），不给全文
//   - 产物返回全部质量分层并带 quality 标签；「是否公开」仍只由发布流程决定
//   - 每个响应携带 notice：热榜标题与摘录仅为线索，引用前核对原链接

const NOTICE =
  "热榜标题与摘录仅为线索，不构成事实认证；quality=review 是待验证、rejected 是已否决，引用前核对原链接。";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  source: z.string().max(100).optional(),
  sourceType: z.string().max(50).optional(),
  kind: z.string().max(50).optional(),
  quality: z.string().max(50).optional(),
  days: z.number().int().min(1).max(30).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});
export type AgentQuery = z.infer<typeof querySchema>;

function decodeCursor(raw?: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return Number.isInteger(parsed?.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}
function encodeCursor(offset: number): string | undefined {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}
function windowStart(days = 14): number {
  return Date.now() - days * 86400000;
}
function envelope<T>(items: T[], nextOffset: number, total: number) {
  return {
    items,
    nextCursor:
      nextOffset < total ? encodeCursor(nextOffset) : undefined,
    generatedAt: isoNow(),
    notice: NOTICE,
  };
}
function paginate<T>(rows: T[], params: AgentQuery) {
  const offset = decodeCursor(params.cursor);
  const limit = params.limit ?? 20;
  const page = rows.slice(offset, offset + limit);
  return { page, nextOffset: offset + limit };
}

// 近 N 天各批次热榜原始候选（含被研究策略筛除的条目，status 标注去向）。
export function agentHotspots(db: Store, raw: unknown) {
  const params = querySchema.parse(raw ?? {});
  const since = windowStart(params.days ?? 14);
  const rows: any[] = [];
  for (const record of db.list<any>("discovery")) {
    if (Date.parse(record.at) < since) continue;
    for (const c of record.candidates || []) {
      if (params.source && c.sourceId !== params.source && c.sourceName !== params.source) continue;
      if (params.q && !`${c.title} ${c.url}`.toLowerCase().includes(params.q.toLowerCase())) continue;
      rows.push({
        title: c.title,
        url: c.url,
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        status: c.status,
        reason: c.reason,
        observedAt: c.observedAt || record.at,
        rank: c.rank,
        region: c.region,
        metric: c.metric,
      });
    }
  }
  rows.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const { page, nextOffset } = paginate(rows, params);
  return envelope(page, nextOffset, rows.length);
}

// 证据库检索：标题+摘要文本匹配，来源类型过滤，只投影摘要级内容。
export function agentEvidence(db: Store, raw: unknown) {
  const params = querySchema.parse(raw ?? {});
  const since = windowStart(params.days ?? 14);
  const rows = db
    .list<any>("evidence")
    .filter((e) => {
      if (params.sourceType && e.sourceType !== params.sourceType) return false;
      if (params.q && !`${e.title} ${e.excerpt}`.toLowerCase().includes(params.q.toLowerCase())) return false;
      const at = Date.parse(e.collectedAt);
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))
    .map((e) => ({
      id: e.id,
      title: e.title,
      url: e.url,
      excerpt: String(e.excerpt || "").slice(0, 2000),
      sourceType: e.sourceType,
      region: e.region,
      language: e.language,
      contentLevel: e.contentLevel,
      collectedAt: e.collectedAt,
      publishedAt: e.publishedAt,
      metric: e.metric,
      provenance: e.acquisition
        ? { method: e.acquisition.method, provider: e.acquisition.provider, platform: e.acquisition.platform, observedAt: e.acquisition.observedAt }
        : undefined,
    }));
  const { page, nextOffset } = paginate(rows, params);
  return envelope(page, nextOffset, rows.length);
}

function artifactSummary(a: any) {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    summary: a.summary,
    audience: a.audience,
    tags: a.tags,
    evidenceIds: a.evidenceIds,
    quality: a.quality || "review",
    evidenceQuality: a.quality || "review",
    creationStatus: a.creationStatus || "inbox",
    visibility: a.visibility,
    createdAt: a.createdAt,
  };
}

// 产物列表：全部质量分层（review 待验证 / ready 通过检查 / rejected 已否决），标签随行。
export function agentArtifacts(db: Store, raw: unknown) {
  const params = querySchema.parse(raw ?? {});
  const since = windowStart(params.days ?? 30);
  const rows = db
    .list<any>("artifacts")
    .filter((a) => {
      if (a.archived) return false;
      // 人物观察已移除：历史 person 行在 UI 不可见，读取投影同样不暴露
      if ((a.kind as string) === "person") return false;
      if (params.kind && a.kind !== params.kind) return false;
      if (params.quality && (a.quality || "review") !== params.quality) return false;
      const at = Date.parse(a.createdAt);
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(artifactSummary);
  const { page, nextOffset } = paginate(rows, params);
  return envelope(page, nextOffset, rows.length);
}

// 单条产物详情：含 kind 专属 details 与引用证据的摘要内联（不给全文）。
export function agentArtifact(db: Store, id: string) {
  const a = db.get<any>("artifacts", id);
  if (!a || a.archived || (a.kind as string) === "person") return null;
  const evidence = (a.evidenceIds || [])
    .map((eid: string) => db.get<any>("evidence", eid))
    .filter(Boolean)
    .map((e: any) => ({
      id: e.id,
      title: e.title,
      url: e.url,
      excerpt: String(e.excerpt || "").slice(0, 2000),
      sourceType: e.sourceType,
      collectedAt: e.collectedAt,
      publishedAt: e.publishedAt,
      metric: e.metric,
    }));
  return {
    ...artifactSummary(a),
    evidenceQuality: a.quality || "review",
    details: a.details,
    evidence,
    generatedAt: isoNow(),
    notice: NOTICE,
  };
}

// 库存概览：给 agent 一眼看清「有什么可消费」。
export function agentStats(db: Store) {
  const artifacts = db.list<any>("artifacts").filter((a) => !a.archived && (a.kind as string) !== "person");
  const by = (field: string) =>
    artifacts.reduce((m: Record<string, number>, a) => {
      const key = a[field] || (field === "quality" ? "review" : field === "creationStatus" ? "inbox" : "unknown");
      m[key] = (m[key] || 0) + 1;
      return m;
    }, {});
  const jobs = db
    .list<any>("jobs")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10)
    .map((j) => ({ id: j.id, plan: j.plan?.name || j.planId, state: j.state, stage: j.stage, createdAt: j.createdAt }));
  return {
    artifacts: { total: artifacts.length, byKind: by("kind"), byQuality: by("quality"), byCreationStatus: by("creationStatus") },
    evidence: { total: db.list("evidence").length },
    hotspots: (() => {
      const c = consumptionSummary(db, "hotspots");
      const records = db.list<any>("discovery").sort((a: any, b: any) => b.at.localeCompare(a.at));
      return { total: c.total, consumed: c.consumed, remaining: c.remaining, records: records.filter((d: any) => Date.parse(d.at) >= windowStart(14)).length, windowDays: 14, lastCollectedAt: records[0]?.at || null };
    })(),
    sources: { enabled: db.list<any>("sources").filter((s) => s.enabled).length, total: db.list("sources").length },
    recentJobs: jobs,
    generatedAt: isoNow(),
    notice: NOTICE,
  };
}

// ---- MCP（JSON-RPC，Streamable HTTP 的纯 POST 简化档：无 SSE）----

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const mcpTools = [
  {
    name: "search_hotspots",
    description: "搜索工作台近 N 天的原始热榜条目（跨批次，含被策略筛除的），返回标题、原链接、来源、榜单热度与筛除原因。热榜标题仅为线索，不构成事实认证。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "标题或 URL 的包含式匹配词" },
        source: { type: "string", description: "来源 ID 或名称，如 weibo-hotsearch" },
        days: { type: "integer", minimum: 1, maximum: 30, description: "回看天数，默认 14" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "search_evidence",
    description: "检索工作台证据库（标题+摘要文本匹配），返回摘要级内容、来源类型与出处指标。摘要不等于全文或事实认证。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "标题与摘要的包含式匹配词" },
        sourceType: { type: "string", description: "如 trend/community/official/repository/product/other" },
        days: { type: "integer", minimum: 1, maximum: 30, description: "默认 14" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "list_artifacts",
    description: "列出研究产物（news 资讯/topic 选题/trend 趋势/idea 应用机会/activity 平台活动）。返回全部质量分层并带标签：quality=ready 通过检查、review 待验证、rejected 已否决；消费 review 条目前先补证。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["news", "topic", "trend", "idea", "activity"] },
        quality: { type: "string", enum: ["ready", "review", "rejected"] },
        days: { type: "integer", minimum: 1, maximum: 30, description: "默认 30" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "get_artifact",
    description: "按 ID 读取单条产物详情：含 kind 专属分析字段与引用证据的摘要内联。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "get_workspace_stats",
    description: "工作台库存概览：各类型/质量/创作状态的产物数量、证据总量、近 14 天热榜批次数与最近任务状态。",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export function mcpCall(db: Store, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "search_hotspots": return agentHotspots(db, args);
    case "search_evidence": return agentEvidence(db, args);
    case "list_artifacts": return agentArtifacts(db, args);
    case "get_artifact": {
      const id = z.string().min(1).parse(args.id);
      const result = agentArtifact(db, id);
      if (!result) throw new Error(`产物 ${id} 不存在`);
      return result;
    }
    case "get_workspace_stats": return agentStats(db);
    default: throw new Error(`未知工具：${name}`);
  }
}

export function mcpRpc(db: Store, message: unknown): unknown {
  if (Array.isArray(message)) return message.map((m) => mcpRpc(db, m));
  const msg = message as Record<string, any>;
  if (msg?.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效的 JSON-RPC 请求" } };
  if (msg.id === undefined || msg.id === null) return null; // 通知：无需响应
  try {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion || MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "draftdesk", version: "2.0.0" },
            instructions: "拾题工作台只读数据源。工具返回热榜、证据与选题产物；quality=review 为待验证、rejected 为已否决，引用前核对原链接。",
          },
        };
      case "tools/list":
        return { jsonrpc: "2.0", id: msg.id, result: { tools: mcpTools } };
      case "tools/call": {
        const name = String(msg.params?.name || "");
        const args = (msg.params?.arguments || {}) as Record<string, unknown>;
        try {
          const result = mcpCall(db, name, args);
          return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
        } catch (error) {
          // 工具入参或执行错误按 MCP 约定返回 isError，不抬升为协议错误
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true },
          };
        }
      }
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } };
    }
  } catch (error) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -26302, message: error instanceof Error ? error.message : String(error) } };
  }
}

// ---- 消费状态投影（consumption ≠ 删除：只加状态层，原始记录保留）----

export const CONSUME_REASONS = ["no-ai-signal", "outdated", "off-domain", "processed-into-artifact"] as const;

// 热榜条目身份 = urlKey(url)（与热点列表同口径去重）；证据身份 = 证据 id。
export function consumptionSummary(db: Store, target: "hotspots" | "evidence"): {
  target: string; total: number; consumed: number; remaining: number; byReason: Record<string, number>;
} {
  const consumed = new Map<string, any>();
  for (const c of db.list<any>("consumption")) if (c.target === target) consumed.set(c.identity, c);
  const byReason: Record<string, number> = {};
  let total = 0, consumedCount = 0;
  if (target === "hotspots") {
    const seen = new Set<string>();
    for (const record of db.list<any>("discovery"))
      for (const candidate of record.candidates || []) {
        const key = urlKey(candidate.url);
        if (seen.has(key)) continue;
        seen.add(key);
        total++;
        const entry = consumed.get(key);
        if (entry) { consumedCount++; byReason[entry.reason] = (byReason[entry.reason] || 0) + 1; }
      }
  } else {
    for (const e of db.list<any>("evidence")) {
      total++;
      const entry = consumed.get(e.id);
      if (entry) { consumedCount++; byReason[entry.reason] = (byReason[entry.reason] || 0) + 1; }
    }
  }
  return { target, total, consumed: consumedCount, remaining: total - consumedCount, byReason };
}

// 已消费热榜键集合（identity 即 urlKey(url)），供热点列表默认隐藏已消费条目。
export function consumptionHotspotKeys(db: Store): Set<string> {
  const keys = new Set<string>();
  for (const c of db.list<any>("consumption")) if (c.target === "hotspots") keys.add(c.identity);
  return keys;
}
