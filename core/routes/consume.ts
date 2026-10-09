// 消费执行（consume scope）：按簇/ids/filter 三路径消费、撤销、状态查询。
// 状态查询属 read scope（旧链在 readScopedRoute 块内处理）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { decodeConsumeCursor } from "../http/pagination";
import { consumptionSummary } from "../agent-read";
import { urlKey } from "../hotspots";

export const routes: RouteDef[] = [
  // 方法截获器：consume/unconsume 只认 POST/PATCH，其余方法（含 GET 带令牌）先 405，不进鉴权
  { methods: ["GET", "PUT", "DELETE"], pattern: "agent/consume", preAuth405: true, handler: () => { throw new Error("unreachable"); } },
  { methods: ["GET", "PUT", "DELETE"], pattern: "agent/unconsume", preAuth405: true, handler: () => { throw new Error("unreachable"); } },
  {
    methods: ["GET"],
    pattern: "agent/consume/status",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => {
      const target = (query.get("target") === "evidence" ? "evidence" : "hotspots") as "hotspots" | "evidence";
      // SQL 直取最新采集记录（PHASE 4-A）：rowid 定位（discovery 追加写入，at=写入时刻）
      const lastDiscovery = db.kv.latestInserted<any>("discovery");
      return json({ ok: true, ...consumptionSummary(db, target), lastCollectedAt: lastDiscovery?.at || null });
    },
  },
  {
    methods: ["POST", "PATCH"],
    pattern: "agent/consume",
    scope: "consume",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
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
      }).strict().parse(await readBody());
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
        for (const ex of input.exceptIds || []) identities = identities.filter((x: string) => x !== ex);
        identities = [...new Set(identities)];
        if (identities.length > 5000)
          throw new AppError(`簇展开后共 ${identities.length} 条，超过单批上限 5000；请拆分簇后分批消费。`, 400, "BATCH_TOO_LARGE");
        total = identities.length;
        const producedRefFallback =
          db.list<any>("outlines").filter((o: any) => input.clusterIds!.includes(o.clusterId))[0]?.id
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
        const normalized = [...new Set(identities.map((x: string) => {
          try { return input.target === "hotspots" ? urlKey(x) : x; } catch { return x; }
        }))];
        const inPool = normalized.filter((x: string) => pool.has(x));
        notFound = normalized.filter((x: string) => !pool.has(x));
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
    },
  },
  {
    methods: ["POST", "PATCH"],
    pattern: "agent/unconsume",
    scope: "consume",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
      const input = z.object({
        target: z.enum(["hotspots", "evidence"]),
        ids: z.array(z.string().min(1).max(2048)).max(1000),
        dryRun: z.boolean().optional(),
      }).strict().parse(await readBody());
      const result = db.unconsumeIdentities(input.target, input.ids, input.dryRun === true);
      if (!result.ok) return json(result, 410);
      return json(result);
    },
  },
];
