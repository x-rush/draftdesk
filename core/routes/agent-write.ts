// 外部 Agent 建议写回（suggest scope + participants 强制）。
// 注册序即旧 if 链顺序，严禁打乱——方法不符时 fallback 落到哪个定义、
// 走「先鉴权后 405」还是「先 405 后鉴权」，都由它决定（见重构清单保序矩阵）。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RouteContext, RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";

const by = (ctx: RouteContext) => `agent:${ctx.connection!.name}`;

export const routes: RouteDef[] = [
  {
    // PUT /agent/decisions/:id/draft（及更深路径，path[3]==="draft" 即命中）——写草稿正文，不能改 decision
    methods: ["PUT"],
    pattern: "agent/decisions/:id/draft/:rest...",
    scope: "suggest",
    participants: true,
    // 方法不符走「405 先行」：旧链里该形态的写路由由 method!==PUT 判定进入 read 块
    methodGuardFirst: true,
    handler: async ({ db, params, readBody }) => {
      const { draftBody } = z.object({ draftBody: z.string().max(100000) }).strict().parse(await readBody());
      const { collection, row } = db.decisionTarget(params.id);
      db.put(collection, row.id, { ...row, draftBody });
      return json({ ok: true, id: row.id, draftBody });
    },
  },
  {
    methods: ["PUT"],
    pattern: "agent/clusters",
    scope: "suggest",
    participants: true,
    handler: async (ctx) => upsertCluster(ctx, await ctx.readBody()),
  },
  {
    methods: ["PUT"],
    pattern: "agent/outlines",
    scope: "suggest",
    participants: true,
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
  {
    methods: ["DELETE"],
    pattern: "agent/clusters/:id",
    scope: "suggest",
    participants: true,
    handler: (ctx) => {
      const { db, params } = ctx;
      const cluster = db.get("clusters", params.id);
      if (!cluster) throw new AppError("簇不存在", 404, "NOT_FOUND");
      let outlinesRemoved = 0;
      for (const o of db.list<any>("outlines")) if (o.clusterId === params.id) { db.del("outlines", o.id); outlinesRemoved++; }
      db.del("clusters", params.id);
      return json({ ok: true, deleted: { cluster: params.id, outlines: outlinesRemoved }, by: by(ctx) });
    },
  },
  {
    methods: ["DELETE"],
    pattern: "agent/outlines/:id",
    scope: "suggest",
    participants: true,
    handler: (ctx) => {
      const { db, params } = ctx;
      if (!db.get("outlines", params.id)) throw new AppError("大纲不存在", 404, "NOT_FOUND");
      db.del("outlines", params.id);
      return json({ ok: true, deleted: params.id, by: by(ctx) });
    },
  },
  {
    // 怪异但保留：任意 PUT agent/clusters/<子路径> / agent/outlines/<子路径>（含 /:id/draft）
    // 落进大纲处理器——旧 if 链的 cascading 行为，重构清单③记录在案，不修。
    methods: ["PUT"],
    pattern: "agent/clusters/:rest...",
    scope: "suggest",
    participants: true,
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
  {
    methods: ["PUT"],
    pattern: "agent/outlines/:rest...",
    scope: "suggest",
    participants: true,
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
];

async function upsertCluster(ctx: RouteContext, input: unknown) {
  const { db } = ctx;
  const parsed = z.object({
    id: z.string().min(1).max(100).optional(),
    topic: z.string().min(1).max(200),
    memberIds: z.array(z.string().min(1)).max(2000),
    kind: z.string().min(1).max(30),
    window: z.string().max(60).optional(),
    suggestedPlatforms: z.array(z.string().max(30)).max(8).optional(),
    target: z.enum(["hotspots", "evidence"]).optional(),
    replaceMembers: z.boolean().optional(),
  }).parse(input);
  const existing = parsed.id ? db.get<any>("clusters", parsed.id) : null;
  // 簇幂等合并：同名 topic 已存在时合并 memberIds（去重）、window 取并集、大纲保留各自独立。
  // replaceMembers:true 时整体覆盖 memberIds 而非合并（用于修正错误归类的批量重建）。
  const dup = !existing
    ? db.list<any>("clusters").find((c: any) => c.topic === parsed.topic && c.target === (parsed.target || "hotspots"))
    : null;
  const cluster = existing
    ? { ...existing, topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || existing.window, suggestedPlatforms: parsed.suggestedPlatforms || existing.suggestedPlatforms, target: parsed.target || existing.target || "hotspots", status: existing.status || "active", producedBy: by(ctx) }
    : dup
      ? { ...dup, memberIds: parsed.replaceMembers ? parsed.memberIds : [...new Set([...(dup.memberIds || []), ...parsed.memberIds])], memberCount: 0, window: [dup.window, parsed.window].filter(Boolean).join(" ~ "), suggestedPlatforms: parsed.suggestedPlatforms || dup.suggestedPlatforms, producedBy: by(ctx) }
      : { id: "clu-" + randomUUID(), topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || "", suggestedPlatforms: parsed.suggestedPlatforms || [], target: parsed.target || "hotspots", status: "active", producedBy: by(ctx), createdAt: now() };
  if (dup) { cluster.memberCount = cluster.memberIds.length; }
  db.put("clusters", cluster.id, cluster);
  return json({ ...cluster, merged: !!dup, replaced: !!existing }, existing ? 200 : 201);
}

async function upsertOutline(ctx: RouteContext, input: unknown) {
  const { db } = ctx;
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
  }).parse(input);
  if (!db.get<any>("clusters", parsed.clusterId)) throw new AppError("簇不存在，请先经 /api/v1/agent/clusters 创建。", 404, "NOT_FOUND");
  const existing = parsed.id ? db.get<any>("outlines", parsed.id) : null;
  const outline = existing
    ? { ...existing, clusterId: parsed.clusterId, platform: parsed.platform, contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || existing.outline, keyPoints: parsed.keyPoints || existing.keyPoints, evidenceRefs: parsed.evidenceRefs || existing.evidenceRefs, ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx) }
    : { id: "out-" + randomUUID(), clusterId: parsed.clusterId, platform: parsed.platform, contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending", ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx), createdAt: now() };
  db.put("outlines", outline.id, outline);
  return json(outline, existing ? 200 : 201);
}
