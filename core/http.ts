import {activityPageSchema,trustedActivityRulesUrl} from "./activity-import";
import {activityBatchSchema} from "./activity-batch";
import {triageActivityBatches,type ActivityTriageRecord} from "./activity-triage";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { store, AppError, now, hash } from "./store";
import {
  artifactSchema,
  configSchema,
  sourceSchema,
  planSchema,
  intakeSchema,
  type Artifact,
  type Conversation,
  type Evidence,
  type Job,
  type Plan,
  type Source,
} from "./schema";
import { skillCatalog, loadSkill } from "./skills";
import { requestModel } from "./model";
import { discussion, distill } from "./chat";
import { skillBundle } from "./skill-bundle";
import { collect, readAggregatedHotlist, readHotspotSource, searchProvider } from "./sources";
import { agentHotspots, agentEvidence, agentArtifacts, agentArtifact, agentStats, mcpRpc, consumptionSummary } from "./agent-read";
import { urlKey } from "./hotspots";

// 决策拍板入参：rejected 必须给否决原因；published 建议给发布链接（回填）。
const decisionInput = z.object({
  decision: z.enum(["approved", "rejected", "deferred", "drafting", "published"]),
  platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
  rejectReason: z.string().min(1).max(60).optional(),
  publishedRef: z.string().max(500).optional(),
}).strict().refine((v) => v.decision !== "rejected" || !!v.rejectReason, "否决必须给出否决原因。");

// persona 人设配置（决策个性化输入）；字段宽松校验，结构由 UI 与种子约定。
const personaInput = z.object({
  domains: z.object({ do: z.array(z.string().max(120)).max(30), dont: z.array(z.string().max(120)).max(30) }),
  goals: z.array(z.string().max(120)).max(12),
  platformRules: z.array(z.object({ contentType: z.string().max(60), scale: z.string().max(30), platforms: z.array(z.string().max(60)).max(8) })).max(20),
  imageOnly: z.boolean(),
  scoring: z.object({ threshold: z.number().min(0).max(5), dimensions: z.array(z.object({ name: z.string().max(60), weight: z.number().min(0).max(1) })).max(12) }),
  redLines: z.array(z.string().max(200)).max(30),
  style: z.object({ principles: z.array(z.string().max(120)).max(10), tone: z.string().max(200), forbidden: z.array(z.string().max(60)).max(20), notes: z.string().max(600) }),
}).strict();

function decodeConsumeCursor(raw?: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return Number.isInteger(parsed?.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}
import type {DiscoveryRecord} from "./discovery";
import { isAggregatePlatform } from "./hotlists";
import { qualityIssues } from "./quality";
import { validateIntake } from "./intake-validation";
import { type ResearchEvent, type MetricSnapshot, metricComparison } from "./history";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export function checkRequest(req: Request) {
  const host = (req.headers.get("host") || new URL(req.url).host).toLowerCase();
  const name = host.split(":")[0];
  if (
    ![
      "localhost",
      "127.0.0.1",
      ...(process.env.DRAFTDESK_ALLOWED_HOSTS || "").split(","),
    ].includes(name)
  )
    throw new AppError("此实例仅接受配置的工作台域名。", 403);
  const origin = req.headers.get("origin");
  if (origin && !["http://" + host, "https://" + host].includes(origin))
    throw new AppError("拒绝跨站请求。", 403);
  if (req.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError("拒绝跨站请求。", 403);
}
async function body(req: Request, maxLength = 1000000) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new AppError("请求需使用 application/json。", 415);
  const reader = req.body?.getReader();
  if (!reader) throw new AppError("缺少请求正文");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > maxLength) {
      await reader.cancel();
      throw new AppError("请求超过 1 MB。", 413);
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("JSON 格式无效。");
  }
}
export async function handle(req: Request, path: string[]) {
  try {
    checkRequest(req);
    const db = store(),
      route = path.join("/");
    // agent 命名空间：GET 读取要 read scope，消费写入要 consume scope，MCP 是 read。
    const consumeRoute = route === "agent/consume" || route === "agent/unconsume";
    const suggestWriteRoute = (path[0] === "agent" && (path[1] === "clusters" || path[1] === "outlines") && req.method !== "GET")
      || (path[0] === "agent" && path[1] === "decisions" && path[3] === "draft" && req.method === "PUT");
    const suggestReadRoute = (path[0] === "agent" && (path[1] === "clusters" || path[1] === "outlines") && req.method === "GET");
    const readScopedRoute = route === "mcp" || (path[0] === "agent" && !consumeRoute && !suggestWriteRoute) || suggestReadRoute;
    const authAllowed = ["intake", "intake-check"].includes(route) || readScopedRoute || consumeRoute || suggestWriteRoute;
    if (suggestWriteRoute && (req.method === "PUT" || req.method === "DELETE")) {
      const connection = db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), "suggest", route);
      // participants 服务端强制：enabled=false → 写入 403 SOURCE_DISABLED；canWrite=false → 写入 403 PERMISSION_DENIED。
      const participants = db.get<any>("config", "participants");
      const producerKey = `agent:${connection.name}`;
      const pCfg = participants?.[producerKey];
      if (pCfg?.enabled === false)
        throw new AppError(`来源已停用：${producerKey}（participants.enabled=false）`, 403, "SOURCE_DISABLED");
      if (pCfg?.canWrite === false)
        throw new AppError(`来源只读：${producerKey}（participants.canWrite=false）`, 403, "PERMISSION_DENIED");
      // 外部 Agent 写回/删除聚合结果与大纲（§4.2）：producedBy 标记来源；
      // 决策字段（decision/draftRef/publishedRef/rejectReason）不在写入面，字段显式挑选保证无法携带。
      const by = `agent:${connection.name}`;
      if (req.method === "DELETE" && path[2]) {
        if (path[1] === "clusters") {
          const cluster = db.get<any>("clusters", path[2]);
          if (!cluster) throw new AppError("簇不存在", 404, "NOT_FOUND");
          let outlinesRemoved = 0;
          for (const o of db.list<any>("outlines")) if (o.clusterId === path[2]) { db.del("outlines", o.id); outlinesRemoved++; }
          db.del("clusters", path[2]);
          return json({ ok: true, deleted: { cluster: path[2], outlines: outlinesRemoved }, by });
        }
        if (path[1] === "outlines") {
          if (!db.get("outlines", path[2])) throw new AppError("大纲不存在", 404, "NOT_FOUND");
          db.del("outlines", path[2]);
          return json({ ok: true, deleted: path[2], by });
        }
      }
      if (req.method !== "PUT") throw new AppError("方法不支持", 405);
      if (path[1] === "decisions" && path[3] === "draft") {
        // PUT /agent/decisions/:id/draft — 外部 Agent 写草稿正文（不能改 decision）
        const { draftBody } = z.object({ draftBody: z.string().max(100000) }).strict().parse(await body(req));
        const { collection, row } = db.decisionTarget(path[2]);
        db.put(collection, row.id, { ...row, draftBody });
        return json({ ok: true, id: row.id, draftBody });
      }
      if (route === "agent/clusters") {
        const parsed = z.object({
          id: z.string().min(1).max(100).optional(),
          topic: z.string().min(1).max(200),
          memberIds: z.array(z.string().min(1)).max(2000),
          kind: z.string().min(1).max(30),
          window: z.string().max(60).optional(),
          suggestedPlatforms: z.array(z.string().max(30)).max(8).optional(),
          target: z.enum(["hotspots", "evidence"]).optional(),
        }).parse(await body(req));
        const existing = parsed.id ? db.get<any>("clusters", parsed.id) : null;
        const cluster = existing
          ? { ...existing, topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || existing.window, suggestedPlatforms: parsed.suggestedPlatforms || existing.suggestedPlatforms, target: parsed.target || existing.target || "hotspots", status: existing.status || "active", producedBy: by }
          : { id: "clu-" + randomUUID(), topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || "", suggestedPlatforms: parsed.suggestedPlatforms || [], target: parsed.target || "hotspots", status: "active", producedBy: by, createdAt: now() };
        db.put("clusters", cluster.id, cluster);
        return json(cluster, existing ? 200 : 201);
      }
      const parsed = z.object({
        id: z.string().min(1).max(100).optional(),
        clusterId: z.string().min(1),
        platform: z.string().min(1).max(30),
        contentType: z.string().min(1).max(30),
        title: z.string().min(1).max(300),
        outline: z.array(z.string().max(300)).max(20).optional(),
        keyPoints: z.array(z.string().max(300)).max(20).optional(),
        evidenceRefs: z.array(z.string().max(2048)).max(200).optional(),
        draftBody: z.string().max(100000).optional(),
      }).parse(await body(req));
      if (!db.get("clusters", parsed.clusterId)) throw new AppError("簇不存在，请先经 /api/v1/agent/clusters 创建。", 404, "NOT_FOUND");
      const existing = parsed.id ? db.get<any>("outlines", parsed.id) : null;
      const outline = existing
        ? { ...existing, clusterId: parsed.clusterId, platform: parsed.platform, contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || existing.outline, keyPoints: parsed.keyPoints || existing.keyPoints, evidenceRefs: parsed.evidenceRefs || existing.evidenceRefs, ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by }
        : { id: "out-" + randomUUID(), clusterId: parsed.clusterId, platform: parsed.platform, contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending", ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by, createdAt: now() };
      db.put("outlines", outline.id, outline);
      return json(outline, existing ? 200 : 201);
    }
    if (req.headers.has("authorization") && !authAllowed)
      throw new AppError("提交令牌只允许写入收件接口。", 403);
    if (consumeRoute) {
      if (req.method !== "POST" && req.method !== "PATCH") throw new AppError("方法不支持", 405);
      db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), "consume", route);
      if (route === "agent/consume") {
        const input = z.object({
          target: z.enum(["hotspots", "evidence"]),
          ids: z.array(z.string().min(1).max(2048)).max(1000).optional(),
          clusterIds: z.array(z.string().min(1).max(100)).max(50).optional(),
          exceptIds: z.array(z.string().min(1).max(2048)).max(1000).optional(),
          filter: z.object({
            days: z.number().int().min(1).max(60).optional(),
            status: z.string().max(30).optional(),
            sourceId: z.string().max(100).optional(),
          }).strict().optional(),
          reason: z.enum(["no-ai-signal", "outdated", "off-domain", "processed-into-artifact"]),
          producedRef: z.string().max(300).optional(),
          dryRun: z.boolean().optional(),
          cursor: z.string().max(200).optional(),
        }).strict().parse(await body(req));
        if (!input.ids?.length && !input.filter && !input.clusterIds?.length)
          throw new AppError("ids、clusterIds 与 filter 必须提供其一。", 400, "INVALID_PAYLOAD");
        let identities = input.ids ?? [];
        let total = identities.length;
        let nextCursor: string | undefined;
        const outlineIds: string[] = [];
        let notFound: string[] = [];
        if (input.clusterIds?.length) {
          // 按簇消费：展开簇成员（memberIds 即该簇 target 空间的身份键），exceptIds 排除簇内部分条目；
          // producedRef 缺省自动指向该簇第一份大纲（无大纲则指向簇本身）；响应携带 outlineIds 全集。
          const seenCluster = new Set<string>();
          for (const clusterId of input.clusterIds) {
            const cluster = db.get<any>("clusters", clusterId);
            if (!cluster) throw new AppError(`簇 ${clusterId} 不存在。`, 404, "NOT_FOUND");
            const clusterTarget = cluster.target || "hotspots";
            if (clusterTarget !== input.target)
              throw new AppError(`簇 ${clusterId} 属于 ${clusterTarget} 空间，不能按 ${input.target} 消费。`, 400, "TARGET_MISMATCH");
            for (const member of cluster.memberIds || []) {
              if (seenCluster.has(member)) continue;
              seenCluster.add(member);
              identities.push(member);
            }
            for (const o of db.list<any>("outlines")) if (o.clusterId === clusterId) outlineIds.push(o.id);
          }
          for (const ex of input.exceptIds || []) identities = identities.filter((x) => x !== ex);
          identities = [...new Set(identities)];
          if (identities.length > 5000)
            throw new AppError(`簇展开后共 ${identities.length} 条，超过单批上限 5000；请拆分簇后分批消费。`, 400, "BATCH_TOO_LARGE");
          total = identities.length;
          const producedRefFallback =
            db.list<any>("outlines").filter((o) => input.clusterIds!.includes(o.clusterId))[0]?.id
            || input.clusterIds.join(",");
          if (!input.producedRef) input.producedRef = producedRefFallback;
        }
        // notFound 统计：三条路径（ids/filter/clusterIds）统一 urlKey 归一化，
        // 池也用 urlKey 构建，调用方传原始 url 或归一化 url 均可匹配（防静默假成功）。
        if (identities.length) {
          const pool = new Set<string>();
          if (input.target === "hotspots") {
            for (const record of db.list<any>("discovery"))
              for (const c of record.candidates || []) pool.add(urlKey(c.url));
          } else {
            for (const e of db.list<any>("evidence")) pool.add(e.id);
          }
          const normalized = [...new Set(identities.map((x) => {
            try { return input.target === "hotspots" ? urlKey(x) : x; } catch { return x; }
          }))];
          const inPool = normalized.filter((x) => pool.has(x));
          notFound = normalized.filter((x) => !pool.has(x));
          identities = inPool;
          total = inPool.length;
        }
        if (!input.ids?.length && !input.clusterIds?.length && input.filter) {
          const since = Date.now() - (input.filter.days ?? 30) * 86400000;
          const seen = new Set<string>();
          const pool: string[] = [];
          if (input.target === "hotspots") {
            for (const record of db.list<any>("discovery")) {
              if (Date.parse(record.at) < since) continue;
              for (const c of record.candidates || []) {
                if (input.filter.status && c.status !== input.filter.status) continue;
                if (input.filter.sourceId && c.sourceId !== input.filter.sourceId) continue;
                const key = urlKey(c.url);
                if (!seen.has(key)) { seen.add(key); pool.push(key); }
              }
            }
          } else {
            for (const e of db.list<any>("evidence")) {
              if (input.filter.status) continue;
              if (Date.parse(e.collectedAt) < since) continue;
              if (!seen.has(e.id)) { seen.add(e.id); pool.push(e.id); }
            }
          }
          total = pool.length;
          const offset = decodeConsumeCursor(input.cursor);
          identities = pool.slice(offset, offset + 1000);
          if (offset + 1000 < pool.length) nextCursor = Buffer.from(JSON.stringify({ offset: offset + 1000 })).toString("base64");
        }
        const result = db.consumeIdentities(input.target, identities, input.reason, "agent", input.producedRef, input.dryRun !== false);
        return json({ ...result, matched: total, notFound, outlineIds, nextCursor, alreadyConsumed: result.alreadyConsumed });
      }
      const unconsumeInput = z.object({
        target: z.enum(["hotspots", "evidence"]),
        ids: z.array(z.string().min(1).max(2048)).max(1000),
        dryRun: z.boolean().optional(),
      }).strict().parse(await body(req));
      const result = db.unconsumeIdentities(unconsumeInput.target, unconsumeInput.ids, unconsumeInput.dryRun === true);
      if (!result.ok) return json(result, 410);
      return json(result);
    }
    if (readScopedRoute) {
      const methodOk = route === "mcp" || route === "agent/suggestions"
        ? req.method === "POST" || req.method === "PATCH"
        : req.method === "GET";
      if (!methodOk) throw new AppError("方法不支持", 405);
      const connection = db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), "read", route);
      if (route === "mcp") {
        const reply = mcpRpc(db, await body(req));
        // 通知（无 id）按约定不回包；其余返回单对象或批量数组
        if (!reply) return new Response(null, { status: 202 });
        return json(reply);
      }
      if (route === "agent/suggestions") {
        // 建议（suggestions）多源并存：外部 Agent 只写建议，不直接改 decision（§12.1 分权）。
        const parsed = z.object({
          targetType: z.enum(["artifact", "outline", "decision"]),
          targetId: z.string().min(1),
          verdict: z.enum(["approved", "rejected", "deferred", "drafting", "published"]),
          score: z.number().min(0).max(5).optional(),
          platforms: z.array(z.string().max(30)).max(6).optional(),
          reason: z.string().max(600).optional(),
        }).strict().parse(await body(req));
        const updated = db.addSuggestion(parsed.targetId, { by: `agent:${connection.name}`, verdict: parsed.verdict, score: parsed.score, platforms: parsed.platforms, reason: parsed.reason });
        return json({ ok: true, id: updated.id, suggestions: updated.suggestions });
      }
      if (suggestWriteRoute && req.method === "DELETE" && path[2]) {
        const by = `agent:${connection.name}`;
        if (path[1] === "clusters") {
          const cluster = db.get<any>("clusters", path[2]);
          if (!cluster) throw new AppError("簇不存在", 404, "NOT_FOUND");
          let outlinesRemoved = 0;
          for (const o of db.list<any>("outlines")) if (o.clusterId === path[2]) { db.del("outlines", o.id); outlinesRemoved++; }
          db.del("clusters", path[2]);
          return json({ ok: true, deleted: { cluster: path[2], outlines: outlinesRemoved }, by });
        }
        if (path[1] === "outlines") {
          if (!db.get("outlines", path[2])) throw new AppError("大纲不存在", 404);
          db.del("outlines", path[2]);
          return json({ ok: true, deleted: path[2], by });
        }
      }
      if (suggestWriteRoute && req.method === "PUT" && path[2] === "draft") {
        // PUT /agent/decisions/:id/draft 或 /agent/outlines/:id/draft — 外部 Agent 写草稿正文
        const { draftBody } = z.object({ draftBody: z.string().max(100000) }).strict().parse(await body(req));
        const { collection, row } = db.decisionTarget(path[1]);
        db.put(collection, row.id, { ...row, draftBody });
        return json({ ok: true, id: row.id, draftBody });
      }
      if (route === "agent/persona") return json(db.get("config", "persona") || null);
      if (route === "agent/aiPolicy") return json(db.get("config", "aiPolicy") || null);
      if (route === "agent/consumerMode") return json(db.get("config", "consumerMode") || null);
      if (route === "agent/clusters") return json({ items: db.list("clusters").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) });
      if (route === "agent/outlines") return json({ items: db.list("outlines").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) });
      if (suggestWriteRoute && req.method === "DELETE" && path[2]) {
        const connection = db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), "suggest");
        const by = `agent:${connection.name}`;
        if (path[1] === "clusters") {
          const cluster = db.get<any>("clusters", path[2]);
          if (!cluster) throw new AppError("簇不存在", 404, "NOT_FOUND");
          let outlinesRemoved = 0;
          for (const o of db.list<any>("outlines")) if (o.clusterId === path[2]) { db.del("outlines", o.id); outlinesRemoved++; }
          db.del("clusters", path[2]);
          return json({ ok: true, deleted: { cluster: path[2], outlines: outlinesRemoved }, by });
        }
        if (path[1] === "outlines") {
          if (!db.get("outlines", path[2])) throw new AppError("大纲不存在", 404);
          db.del("outlines", path[2]);
          return json({ ok: true, deleted: path[2], by });
        }
      }

      if (route === "agent/decisions" || route === "agent/decisions/stats") {
        const rawStatus = new URL(req.url).searchParams.get("status") || undefined;
        const status = rawStatus === "all" ? undefined : rawStatus;
        return json(route === "agent/decisions" ? { items: db.decisionsQueue(status), generatedAt: now() } : db.decisionsStats());
      }
      const query = Object.fromEntries(new URL(req.url).searchParams.entries());
      const numeric = (key: string) => (query[key] === undefined ? undefined : Number(query[key]));
      const params = {
        q: query.q,
        source: query.source,
        sourceType: query.sourceType,
        kind: query.kind,
        quality: query.quality,
        days: numeric("days"),
        limit: numeric("limit"),
        cursor: query.cursor,
      };
      Object.keys(params).forEach((k) => params[k as keyof typeof params] === undefined && delete params[k as keyof typeof params]);
      if (route === "agent/hotspots") return json(agentHotspots(db, params));
      if (route === "agent/consume/status") {
        const target = (query.target === "evidence" ? "evidence" : "hotspots") as "hotspots" | "evidence";
        const lastDiscovery = db.list<any>("discovery").sort((a: any, b: any) => b.at.localeCompare(a.at))[0];
        return json({ ok: true, ...consumptionSummary(db, target), lastCollectedAt: lastDiscovery?.at || null });
      }
      if (route === "agent/evidence") return json(agentEvidence(db, params));
      if (route === "agent/artifacts" && path.length === 2) return json(agentArtifacts(db, params));
      if (path[0] === "agent" && path[1] === "artifacts" && path[2]) {
        const detail = agentArtifact(db, path[2]);
        if (!detail) throw new AppError("产物不存在", 404);
        return json(detail);
      }
      if (route === "agent/stats") return json(agentStats(db));
      throw new AppError("接口不存在", 404);
    }
    if (req.method === "GET") {
      if (route === "health") return json({ ok: true, version: "2.0.0" });
      if (route === "activity-batches")
        return json(db.list<{id:string;receivedAt:string;bundle:{platform:string;items:unknown[];coverage?:unknown}}>("activity-batches").map(({id,receivedAt,bundle})=>({id,receivedAt,platform:bundle.platform,count:bundle.items.length,hasCoverage:Boolean(bundle.coverage)})));
      if (path[0] === "activity-batches" && path[1]) {
        const record=db.get("activity-batches",path[1]);
        if(!record)throw new AppError("采集结果不存在",404);
        return json(record);
      }
      if (route === "activity-triage")
        return json(db.list<ActivityTriageRecord>("activity-triage").map(({id,createdAt,batchIds,keywords,totalCount,selectedCount,modelTokens})=>({id,createdAt,batchIds,keywords,totalCount,selectedCount,modelTokens})));
      if (path[0] === "activity-triage" && path[1]) {
        const record=db.get<ActivityTriageRecord>("activity-triage",path[1]);
        if(!record)throw new AppError("活动初筛结果不存在",404);
        return json(record);
      }
      if (route === "public")
        return json({
          items: db
            .list<Artifact>("artifacts")
            .filter(
              (a) =>
                a.visibility === "public" &&
                a.quality === "ready" &&
                !a.archived &&
                ["news", "topic"].includes(a.kind),
            )
            .map((a) => ({
              id: a.id,
              kind: a.kind,
              title: a.title,
              summary: a.summary,
              tags: a.tags,
              details: a.details,
              updatedAt: a.updatedAt,
            })),
        });
      if (route === "workspace") return json(db.snapshot(new URL(req.url).searchParams.has("page") ? new URL(req.url).searchParams : undefined));
      if (path[0] === "artifacts" && path[1]) {
        const artifact=db.get<Artifact>("artifacts",path[1]);
        if(!artifact || artifact.archived) throw new AppError("内容不存在或已归档",404);
        return json(artifact);
      }
      if (path[0] === "history") {
        const artifact = db.get<Artifact>("artifacts",path[1]);
        if (!artifact) throw new AppError("内容不存在",404);
        const events = db.list<ResearchEvent>("events").filter(e=>e.evidenceIds.some(id=>artifact.evidenceIds.includes(id)));
        const ids = new Set(events.flatMap(e=>e.evidenceIds));
        const all = db.list<MetricSnapshot>("metrics");
        const series = new Set(all.filter(m=>ids.has(m.evidenceId)).map(m=>m.seriesId));
        return json({events, metrics:all.filter(m=>series.has(m.seriesId)).sort((a,b)=>b.at.localeCompare(a.at)).map(m=>({...m,comparison:metricComparison(all,m)})),
          related:db.list<Artifact>("artifacts").filter(a=>a.id!==artifact.id && !a.archived && a.evidenceIds.some(id=>ids.has(id))).map(a=>({id:a.id,title:a.title}))});
      }
      if (route === "skills")
        return json(skillCatalog.map((s) => ({ ...s, ...loadSkill(s.id) })));
      if (route === "skill-bundle")
        return new Response(new Uint8Array(skillBundle()), {
          headers: {
            "content-type": "application/x-tar",
            "content-disposition":
              'attachment; filename="draftdesk-skills.tar"',
            "cache-control": "no-store",
          },
        });
      if (route === "schema") return json(z.toJSONSchema(intakeSchema));
      if (path[0] === "conversations") {
        const c = db.get<Conversation>("conversations", path[1]);
        if (!c) throw new AppError("讨论不存在", 404);
        return json(c);
      }
      if (path[0] === "evidence") {
        const e = db.get<Evidence>("evidence", path[1]);
        if (!e) throw new AppError("证据不存在", 404);
        return json(e);
      }
      if (path[0] === "job-context")
        return json({
          analysis: db.get("job-context", path[1]),
          draft: db.get("job-draft", path[1]),
          verification: db.get("job-verification", path[1]) || [],
        });
      if (route === "decisions" || route === "decisions/stats") {
        const rawStatus = new URL(req.url).searchParams.get("status") || undefined;
        const status = rawStatus === "all" ? undefined : rawStatus;
        return json(route === "decisions" ? { items: db.decisionsQueue(status), generatedAt: now() } : db.decisionsStats());
      }
      if (route === "persona") return json(db.get("config", "persona") || null);
      if (route === "aiPolicy") return json(db.get("config", "aiPolicy") || null);
      if (route === "consumerMode") return json(db.get("config", "consumerMode") || "external");
      if (route === "planMode") return json(db.get("config", "planMode") || "collect-and-analyze");
      if (route === "clusters") return json({ items: db.list("clusters").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) });
      if (route === "outlines") return json({ items: db.list("outlines").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) });
      if (route === "export") {
        return json({
          schemaVersion: "2.0",
          exportedAt: now(),
          artifacts: db.list("artifacts"),
          evidence: db.list("evidence"),
          discovery: db.list("discovery"),
          events: db.list("events"),
          metrics: db.list("metrics"),
          plans: db.list("plans"),
          sources: db.list("sources"),
          jobs: db.list("jobs"),
          conversations: db.list("conversations"),
          decisions: db.list("decisions"),
          clusters: db.list("clusters"),
          outlines: db.list("outlines"),
        });
      }
      throw new AppError("接口不存在", 404);
    }
    if (req.method !== "POST") throw new AppError("方法不支持", 405);
    if(route === "intake-check") {
      db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /,""));
      const input=await body(req);
      if(input.probe === true) return json({ok:true,permission:"intake-only",note:"连接和令牌通过；未验证外部搜索工具，未入库。"});
      const report=validateIntake(input);
      return json(report,report.ok?200:400);
    }
    // Intake tokens are deliberately scoped: they cannot access any other mutation.
    if (route === "intake") {
      const c = db.authenticate(
        (req.headers.get("authorization") || "").replace(/^Bearer /, ""),
      );
      return json(db.intake(await body(req), c.id), 201);
    }
    if (req.headers.has("authorization"))
      throw new AppError("提交令牌只允许写入收件接口。", 403);
    const input = await body(req,route === "activity-batches" ? 5000000 : 1000000);
    if(route === "activity-batches") {
      const bundle=activityBatchSchema.parse(input);
      if(bundle.items.some(item=>item.platform!==bundle.platform))throw new AppError("活动包的平台与条目不一致");
      const id=hash(JSON.stringify(bundle));
      const previous=db.get<{receivedAt:string}>("activity-batches",id);
      const receivedAt=previous?.receivedAt||now();
      if(!previous)db.put("activity-batches",id,{id,receivedAt,bundle});
      return json({ok:true,id,platform:bundle.platform,count:bundle.items.length,duplicate:!!previous,receivedAt},previous?200:201);
    }
    if(route === "activity-triage") {
      const consumerMode = db.get<any>("config", "consumerMode") || "external";
      if (consumerMode === "external")
        return json({ skipped: true, reason: "消费执行方为外部 Agent（consumerMode=external）：内置初筛停用，聚合分类由外部 Agent 经 /api/v1/agent/clusters 写回。", results: [] });
      const aiPolicy = db.get<any>("config", "aiPolicy");
      if ((aiPolicy?.triage || "off") === "off")
        return json({ skipped: true, reason: "内置初筛已关闭（aiPolicy.triage=off）；聚合分类由外部 Agent 经 /api/v1/agent/clusters 写回，或人工处理。", results: [] });
      const value=z.object({batchIds:z.array(z.string().min(1)).min(1).max(4),keywords:z.array(z.string().trim().min(1).max(80)).min(1).max(8)}).strict().parse(input);
      return json(await triageActivityBatches(db,value.batchIds,value.keywords,req.signal),201);
    }
    if(route === "validate-intake") { const report=validateIntake(input); return json(report); }
    if(route === "source-check") {
      const {sourceId}=z.object({sourceId:z.string()}).strict().parse(input);
      const source=db.get<{type:string;query?:string;name:string}>("sources",sourceId);
      if(!source||source.type!=="aggregated"||!source.query||!isAggregatePlatform(source.query))throw new AppError("请选择聚合热榜来源。");
      const items=await readAggregatedHotlist(source.query,req.signal);
      return json({ok:true,count:items.length,updatedAt:items[0].acquisition?.observedAt,method:"aggregator",provider:"DailyHotApi",platform:source.name});
    }
    if(route === "source-preview") {
      const {planId}=z.object({planId:z.string()}).strict().parse(input);
      const plan=db.get<Plan>("plans",planId);
      if(!plan||plan.kind==="activities")throw new AppError("请选择内置研究策略。",404);
      const sourceIds=plan.sourceIds.filter(id=>{const s=db.get<Source>("sources",id);return s?.enabled&&s.type!=="web";}).slice(0,3);
      if(!sourceIds.length)throw new AppError("此策略没有可预览的免模型来源；可在数据源页启用 RSS 或热榜。",400);
      const id="preview-"+randomUUID();
      const sample={...plan,sourceIds,maxQueries:0,maxEvidence:Math.min(12,plan.maxEvidence)};
      const result=await collect(db,sample,AbortSignal.any([req.signal,AbortSignal.timeout(65000)]),()=>{},()=>{},id,"preview");
      return json({record:db.get("discovery",id),evidenceCount:result.evidence.length,warnings:result.warnings});
    }
    if(route === "hotspot-refresh") {
      const {sourceId}=z.object({sourceId:z.string()}).strict().parse(input);
      const source=db.get<Source>("sources",sourceId);
      if(!source||!source.enabled||!["hotlist","aggregated","trends"].includes(source.type))throw new AppError("请选择已启用的热榜或趋势来源。",400);
      const at=now(),id="hotspot-"+randomUUID();
      try{
        const items=(await readHotspotSource(source,AbortSignal.any([req.signal,AbortSignal.timeout(45000)]))).slice(0,100);
        const record:DiscoveryRecord={jobId:id,at,planName:"独立热点快照",mode:"hotspot",limit:100,
          candidates:items.map((item,index)=>({url:item.url,title:item.title,sourceId:source.id,sourceName:source.name,status:"watch",reason:"原始热点；未按研究策略筛选或经 AI 核实",observedAt:at,rank:index+1,region:item.region,metric:item.metric})),
          sources:[{sourceId:source.id,sourceName:source.name,status:"ok",raw:items.length,matched:0,selected:0}]};
        db.put("discovery",id,record);
        return json({count:items.length,source:source.name,at});
      }catch(error){
        db.put("discovery",id,{jobId:id,at,planName:"独立热点快照",mode:"hotspot",limit:100,candidates:[],sources:[{sourceId:source.id,sourceName:source.name,status:"failed",raw:0,matched:0,selected:0,error:error instanceof AppError?error.message:"来源读取失败"}]} satisfies DiscoveryRecord);
        throw error;
      }
    }
    if (route === "config") {
      const cfg = configSchema.parse(input),
        old = db.get<any>("config", "main");
      const { clearApiKey, clearTavilyKey, ...next } = cfg;
      db.put("config", "main", {
        ...next,
        apiKey: clearApiKey ? undefined : cfg.apiKey?.trim() || old.apiKey,
        tavilyKey: clearTavilyKey
          ? undefined
          : cfg.tavilyKey?.trim() || old.tavilyKey,
      });
      return json(db.publicConfig());
    }
    if (route === "test-model") {
      const result = await requestModel(
        db,
        [{ role: "user", content: "只回复：连接成功" }],
        { signal: req.signal },
      );
      return json({ message: result.text, usage: result.usage });
    }
    if (route === "test-search") {
      const runTavily = async () => {
        const key = db.config().tavilyKey;
        if (!key) throw new AppError("请先保存 Tavily Key。");
        try {
          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]),
            headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query: "AI productivity tools", search_depth: "basic", max_results: 1 }),
          });
          if (!response.ok) throw new AppError(`Tavily 搜索失败（HTTP ${response.status}），请检查密钥与额度。`, 502);
          const result = await response.json();
          const count = Array.isArray(result.results) ? result.results.length : 0;
          if (!count) throw new AppError("Tavily 已响应，但本次未返回搜索结果。", 502);
          return `Tavily 实际搜索成功，返回 ${count} 条结果（消耗一次 basic 搜索额度）。`;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("Tavily 连接失败或超时，请检查网络；密钥不会回显。", 502);
        }
      };
      const runSearxng = async () => {
        const base = (db.config().searxngUrl || "http://searxng:8080").replace(/\/+$/,"");
        try {
          const response = await fetch(`${base}/search?format=json&q=${encodeURIComponent("AI productivity tools")}`, {
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
            headers: { "accept": "application/json" },
          });
          if (!response.ok) throw new AppError(`SearXNG 搜索失败（HTTP ${response.status}），请检查地址与 JSON 输出是否放行。`, 502);
          const result = await response.json();
          const count = Array.isArray(result.results) ? result.results.length : 0;
          if (!count) throw new AppError("SearXNG 已响应，但本次未返回搜索结果。", 502);
          return `SearXNG 实际搜索成功，返回 ${count} 条结果（本地零成本）。`;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("SearXNG 连接失败或超时，请检查地址与网络。", 502);
        }
      };
      const provider = searchProvider(db);
      if (provider === "tavily") return json({ message: await runTavily() });
      if (provider === "searxng") return json({ message: await runSearxng() });
      // hybrid：SearXNG 必测（零成本兜底）；Tavily 配了 Key 才实测，未配置不算失败。
      const searxngMessage = await runSearxng();
      const tavilyMessage = db.config().tavilyKey
        ? await runTavily()
        : "Tavily 未配置 Key，补位搜索将由 SearXNG 承担";
      return json({ message: `${searxngMessage}；${tavilyMessage}` });
    }
    if (route === "sources") {
      const source = sourceSchema.parse(input);
      if (source.type === "rss" && !source.url)
        throw new AppError("RSS 需要来源地址");
      if(source.type === "hotlist" && !["https://top.baidu.com/board?tab=realtime","https://s.weibo.com/top/summary?cate=realtimehot","https://github.com/trending","https://hacker-news.firebaseio.com/v0/topstories.json"].includes(source.url||""))
        throw new AppError("官方热榜入口不在允许列表中");
      if(source.type === "aggregated" && !["bilibili","weibo","zhihu","douyin","kuaishou","toutiao","tieba","juejin"].includes(source.query||""))
        throw new AppError("聚合热榜仅支持已列出的平台路由");
      if(source.type === "aggregated" && (source.sourceType !== "trend" || source.url))
        throw new AppError("聚合热榜固定为趋势线索，不能标记为官方来源或自定义采集地址");
      if(source.type === "suggest" && !(source.query||"").trim())
        throw new AppError("搜索联想来源需要至少一个种子关键词");
      if(source.type === "suggest" && source.url && source.url !== "https://www.baidu.com/sugrec")
        throw new AppError("搜索联想来源只支持默认 Google 联想或百度 sugrec 入口");
      db.put("sources", source.id, source);
      return json(source);
    }
    if (route === "plans") {
      const plan = planSchema.parse(input);
      if (plan.sourceIds.some((id) => !db.get("sources", id)))
        throw new AppError("策略引用未知来源");
      if (plan.scheduleEnabled && !db.config().apiKey)
        throw new AppError("请配置模型后再开启定时任务。");
      if (plan.kind === "activities" && plan.scheduleEnabled) throw new AppError("活动采集由登录浏览器主动执行，不能设置服务器定时任务。");
      const previous=db.get<Plan>("plans",plan.id);
      const saved={...plan,scheduleActivatedAt:plan.scheduleEnabled?(previous?.scheduleEnabled?previous.scheduleActivatedAt:now()):undefined};
      db.put("plans", plan.id, saved);
      return json(saved);
    }
    if(route === "activity-evidence") {
      const value=activityPageSchema.parse({schemaVersion:"draftdesk.activity-page.v1",...(input as object)});
      const evidence=db.addEvidence({title:value.title,url:value.url,excerpt:value.text,collectedAt:new Date().toISOString(),sourceType:trustedActivityRulesUrl(value.url)?"official":"other",region:"中国",language:"zh",contentLevel:"excerpt"},"manual-activity-rules");
      return json({evidenceId:evidence.id});
    }
    if (route === "jobs") {
      const value = z
        .object({
          planId: z.string(),
          evidenceIds: z.array(z.string()).max(60).default([]),
          receiptId: z.string().optional(),
          retry: z.boolean().default(false),
          targetKeywords: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
        })
        .parse(input);
      if (db.get<any>("plans", value.planId)?.kind === "activities" && !value.evidenceIds.length) throw new AppError("请先从创作活动页面导入官方规则；活动研究不再使用搜索。", 400);
      if (value.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("证据不存在");
      return json(db.enqueue(value.planId, value.evidenceIds, undefined, value.receiptId, value.retry, value.targetKeywords), 202);
    }
    if (route === "cancel") {
      const id = z.string().parse(input.id),
        j = db.get<Job>("jobs", id);
      if (!j) throw new AppError("任务不存在", 404);
      if (!["queued", "running"].includes(j.state)) return json(j);
      return json(
        db.patchJob(id, {
          cancelRequested: true,
          ...(j.state === "queued"
            ? { state: "cancelled", finishedAt: now() }
            : {}),
        }),
      );
    }
    if (route === "artifacts")
      return json(
        db.updateArtifact(
          z
            .object({
              id: z.string(),
              revision: z.number().int(),
              draft: z.unknown().optional(),
              creationStatus: z.enum(["inbox","planned","writing","published"]).optional(),
              decision: z.enum(["pending","approved","rejected","deferred","drafting","published"]).optional(),
              rejectReason: z.string().max(60).optional(),
              platforms: z.array(z.string().max(30)).max(6).optional(),
              archived: z.boolean().optional(),
              visibility: z.enum(["private", "public"]).optional(),
            })
            .parse(input),
        ),
      );
    if (route === "save-draft") {
      const draft = artifactSchema.parse(input.draft);
      if (draft.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("草稿引用不存在的证据");
      const jobId = z.string().max(100).parse(input.jobId);
      if (!db.get("jobs", jobId)) throw new AppError("整理任务不存在");
      const a = db.saveArtifact(draft, jobId, "review", [
        "讨论整理草稿，保存不代表事实已核实。",
        ...qualityIssues(draft, draft.evidenceIds.map((id) => db.get<Evidence>("evidence", id)!)),
      ]);
      return json(db.put("artifacts", a.id, { ...a, decision: "approved", decidedBy: "human", decidedAt: now() }));
    }
    if (route === "connections") {
      const parsed = z.object({ name: z.string().min(1).max(80), scopes: z.array(z.enum(["submit","read","consume","suggest"])).min(1).max(4).optional() }).parse(input);
      if (/�/.test(parsed.name))
        throw new AppError("连接名称包含无效字符（可能是编码错误），请以 UTF-8 重新发送。", 400);
      return json(db.createConnection(parsed.name, parsed.scopes));
    }
    if (route === "revoke") {
      const id = z.string().parse(input.id),
        c = db.get<any>("connections", id);
      if (!c) throw new AppError("连接不存在", 404);
      db.put("connections", id, { ...c, revoked: true });
      return json({ ok: true });
    }
    if (route === "import") {
      return json(db.intake(input, "manual-import"));
    }
    if (route === "migrate-local") {
      const old = z
        .object({
          version: z.literal(1),
          topics: z.array(z.record(z.string(), z.unknown())).max(5000),
          platforms: z.array(z.record(z.string(), z.unknown())).max(1000),
        })
        .parse(input);
      db.transaction(() => {
        old.topics.forEach((t) => {
          if (typeof t.id !== "string" || typeof t.title !== "string")
            throw new AppError("旧选题格式无效");
          if (!db.get("legacy", t.id))
            db.put("legacy", t.id, {
              ...t,
              legacyTags: old.platforms,
              migratedAt: now(),
            });
        });
      });
      return json({ count: old.topics.length });
    }
    if (route === "distill") {
      const value = z
        .object({ id: z.string(), kind: z.enum(["topic", "idea"]) })
        .parse(input);
      return json(await distill(db, value.id, value.kind, req.signal));
    }
    if (path[0] === "decisions" && path[2] === "draft") {
      const { draftBody } = z.object({ draftBody: z.string().max(100000) }).strict().parse(input);
      const { collection, row } = db.decisionTarget(path[1]);
      db.put(collection, row.id, { ...row, draftBody });
      return json({ ok: true, id: row.id, draftBody });
    }
    if (route === "decisions/manual") {
      const parsed = z.object({
        title: z.string().min(1).max(300),
        notes: z.string().max(2000).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
      }).strict().parse(input);
      const record = { id: "dec-" + randomUUID(), title: parsed.title, notes: parsed.notes, platforms: parsed.platforms || [], decision: "pending" as const, createdAt: now() };
      db.put("decisions", record.id, record);
      return json(record, 201);
    }
    if (route === "decisions/batch") {
      const parsed = z.object({
        ids: z.array(z.string().min(1)).min(1).max(100),
        decision: z.enum(["approved", "rejected", "deferred"]),
        rejectReason: z.string().max(60).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
      }).strict().parse(input);
      if (parsed.decision === "rejected" && !parsed.rejectReason) throw new AppError("批量否决必须给出否决原因。", 400, "INVALID_PAYLOAD");
      const results = parsed.ids.map((id) => {
        try { return { id, ok: true, row: db.setDecision(id, { decision: parsed.decision, rejectReason: parsed.rejectReason, platforms: parsed.platforms, decidedBy: "human" }) }; }
        catch (error) { return { id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
      });
      return json({ ok: true, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
    }
    if (route === "persona") {
      const parsed = personaInput.parse(input);
      db.put("config", "persona", parsed);
      return json(parsed);
    }
    if (route === "aiPolicy") {
      const parsed = z.object({
        triage: z.enum(["off", "cheap", "full"]),
        outline: z.enum(["off", "cheap", "full"]),
        draft: z.enum(["off", "cheap", "full"]),
        aiWriter: z.enum(["builtin", "external", "both"]),
      }).strict().parse(input);
      db.put("config", "aiPolicy", parsed);
      return json(parsed);
    }
    if (route === "consumerMode") {
      const parsed = z.object({ consumerMode: z.enum(["external", "builtin"]) }).strict().parse(input);
      db.put("config", "consumerMode", parsed.consumerMode);
      return json(parsed);
    }
    if (route === "planMode") {
      const parsed = z.object({ planMode: z.enum(["collect", "collect-and-analyze"]) }).strict().parse(input);
      db.put("config", "planMode", parsed.planMode);
      return json(parsed);
    }
    if (route === "clusters") {
      const parsed = z.object({
        topic: z.string().min(1).max(200),
        memberIds: z.array(z.string().min(1)).max(2000),
        kind: z.string().min(1).max(30),
        window: z.string().max(60).optional(),
        suggestedPlatforms: z.array(z.string().max(30)).max(8).optional(),
        target: z.enum(["hotspots", "evidence"]).optional(),
      }).strict().parse(input);
      const cluster = { id: "clu-" + randomUUID(), topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || "", suggestedPlatforms: parsed.suggestedPlatforms || [], target: parsed.target || "hotspots", status: "active", producedBy: "human", createdAt: now() };
      db.put("clusters", cluster.id, cluster);
      return json(cluster, 201);
    }
    if (route === "outlines") {
      const parsed = z.object({
        clusterId: z.string().min(1),
        platform: z.string().min(1).max(30),
        contentType: z.string().min(1).max(30),
        title: z.string().min(1).max(300),
        outline: z.array(z.string().max(300)).max(20).optional(),
        keyPoints: z.array(z.string().max(300)).max(20).optional(),
        evidenceRefs: z.array(z.string().max(2048)).max(200).optional(),
      }).strict().parse(input);
      if (!db.get("clusters", parsed.clusterId)) throw new AppError("簇不存在，请先创建内容簇。", 404);
      const outline = { id: "out-" + randomUUID(), ...parsed, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending" as const, producedBy: "human", createdAt: now() };
      db.put("outlines", outline.id, outline);
      return json(outline, 201);
    }
      if (path[0] === "decisions" && path[2] === "publish") {
        const { publishedRef } = z.object({ publishedRef: z.string().min(1).max(500) }).parse(input);
        return json(db.setDecision(path[1], { decision: "published", publishedRef }));
      }
      if (path[0] === "decisions" && path[2] === "decision") {
        const parsed = decisionInput.parse(input);
        return json(db.setDecision(path[1], { ...parsed, decidedBy: "human" }));
      }
      if (path[0] === "artifacts" && path[2] === "decision") {
        const parsed = decisionInput.parse(input);
        return json(db.setDecision(path[1], { ...parsed, decidedBy: "human" }));
      }
      if (path[0] === "outlines" && path[2] === "decision") {
        const parsed = decisionInput.parse(input);
        return json(db.setDecision(path[1], { ...parsed, decidedBy: "human" }));
      }
    if (route === "chat") {
      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      const stream = new ReadableStream({
        start(c) {
          let open = true;
          const emit = (event: unknown) => {
            if (open)
              try {
                c.enqueue(
                  new TextEncoder().encode(JSON.stringify(event) + "\n"),
                );
              } catch {
                open = false;
                controller.abort();
              }
          };
          void discussion(db, input, controller.signal, emit)
            .catch((e) =>
              emit({
                type: "error",
                message: e instanceof AppError ? e.message : "讨论请求失败。",
              }),
            )
            .finally(() => {
              if (open) {
                open = false;
                c.close();
              }
            });
        },
        cancel() {
          controller.abort();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson;charset=utf-8",
          "cache-control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    throw new AppError("接口不存在", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return json(
        {
          error:
            "数据格式不符合协议：" +
            e.issues
              .slice(0, 3)
              .map((i) => i.path.join(".") + " " + i.message)
              .join("；"),
        },
        400,
      );
    return json(
      {
        error:
          e instanceof AppError
            ? e.message
            // 本机自托管应用：直接透出异常类型与消息，便于排障，不再只报通用失败。
            : `服务处理失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        code: e instanceof AppError ? e.code || undefined : e instanceof Error && e.name === "SyntaxError" ? "INVALID_PAYLOAD" : undefined,
      },
      e instanceof AppError ? e.status : 500,
    );
  }
}
