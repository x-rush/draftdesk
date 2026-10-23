// 外部 Agent 建议写回（suggest scope + participants 强制）。
// 注册序即旧 if 链顺序，严禁打乱——方法不符时 fallback 落到哪个定义、
// 走「先鉴权后 405」还是「先 405 后鉴权」，都由它决定（见重构清单保序矩阵）。
import { z } from "zod";
import { PLATFORM_KEYS, normalizePlatform, normalizeCategory } from "../platforms";
import { randomUUID } from "node:crypto";
import type { RouteContext, RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { markCoveredVariants, coveredVariantDoc } from "../topic-dedupe";
import { indexEventGroups, findSemanticDuplicate, searchVectors } from "../vector-store";

const by = (ctx: RouteContext) => `agent:${ctx.connection!.name}`;

import { writeAgentOpportunity } from "../opportunity";

export const routes: RouteDef[] = [
  {
    // R10.19-2：外部 Agent 组结构写回——判级+角度+appGap（external 模式语义处理主写口）
    methods: ["PUT", "POST"],
    pattern: "agent/triage/groups",
    scope: "suggest",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        jobId: z.string().min(1).max(64),
        groups: z.array(z.object({
          id: z.string().min(1).max(40),
          title: z.string().min(1).max(120),
          attention: z.enum(["strong", "potential", "none"]),
          reason: z.string().max(300).optional(),
          memberUrls: z.array(z.string().max(2048)).max(100).optional(),
          representativeUrl: z.string().max(2048).optional(),
          sources: z.array(z.string().max(80)).max(10).optional(),
          angles: z.array(z.object({ platform: z.string().max(30), angle: z.string().max(150) })).max(8).optional(),
          appGap: z.string().max(300).optional(),
        })).min(1).max(200),
      }).strict().parse(await readBody());
      if (!db.get("discovery", parsed.jobId)) throw new AppError("采集批次不存在，请确认 jobId。", 404, "NOT_FOUND");
      const record = db.get<any>("candidate-groups", "tg-" + parsed.jobId);
      const nowIso = now();
      const doc = {
        jobId: parsed.jobId,
        planName: record?.planName || "外部语义处理",
        day: record?.day || nowIso.slice(0, 10),
        at: nowIso,
        groups: parsed.groups.map((g) => ({
          ...g,
          memberUrls: g.memberUrls || [],
          representativeUrl: g.representativeUrl || g.memberUrls?.[0] || "",
          sources: g.sources || [],
          angles: g.angles || [],
        })),
        shards: 0, calls: 0, tokens: 0, merges: 0,
        source: "external" as const,
      };
      db.put("candidate-groups", "tg-" + parsed.jobId, doc);
      // R10.20-A2：回写 discovery 候选判级标记（attention/groupId/selected）——
      // builtin 链靠 applyTriageToCandidates 做，external 写口补齐同款回写+覆盖率入模率回填
      const disc = db.get<any>("discovery", parsed.jobId);
      if (disc) {
        const limit = disc.limit ?? 6;
        const { applyTriageToCandidates } = await import("../triage");
        applyTriageToCandidates(disc.candidates || [], doc.groups as any, limit);
        const judgedBySource = new Map<string, number>();
        for (const c of disc.candidates || []) if (c.attention) judgedBySource.set(c.sourceId, (judgedBySource.get(c.sourceId) || 0) + 1);
        for (const cov of disc.sources || []) cov.selected = judgedBySource.get(cov.sourceId) || 0;
        db.put("discovery", parsed.jobId, disc);
      }
      // R10.24-5：组摘要入向量事件线（fire-and-forget，失败零影响主写口）
      void indexEventGroups(db, parsed.jobId, doc.groups as never).catch(() => {});
      return json({ ok: true, jobId: parsed.jobId, groups: doc.groups.length, at: nowIso, candidatesUpdated: disc ? (disc.candidates || []).filter((c: any) => c.attention).length : 0 });
    },
  },
  {
    // R10.19-2：外部 Agent 归档写回——判 none 的组进归档队列
    methods: ["PUT", "POST"],
    pattern: "agent/triage/archive",
    scope: "suggest",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        jobId: z.string().min(1).max(64),
        groups: z.array(z.object({
          id: z.string().min(1).max(40),
          title: z.string().min(1).max(120),
          reason: z.string().max(300).optional(),
          memberUrls: z.array(z.string().max(2048)).max(100).optional(),
        })).min(1).max(200),
      }).strict().parse(await readBody());
      if (!db.get("discovery", parsed.jobId)) throw new AppError("采集批次不存在。", 404, "NOT_FOUND");
      const nowIso = now();
      db.put("triage-archive", "ta-" + parsed.jobId, {
        jobId: parsed.jobId,
        day: nowIso.slice(0, 10),
        at: nowIso,
        groups: parsed.groups.map((g) => ({ ...g, memberUrls: g.memberUrls || [], sources: [] })),
        source: "external" as const,
      });
      // 同步更新 discovery 候选状态（归档成员置 filtered）
      const disc = db.get<any>("discovery", parsed.jobId);
      if (disc) {
        const archivedUrls = new Set(parsed.groups.flatMap((g) => g.memberUrls || []));
        for (const c of disc.candidates || []) {
          if (archivedUrls.has(c.url) && c.status !== "filtered") {
            c.status = "filtered";
            c.reason = `已归档（外部 Agent 判无注意力）`;
          }
        }
        db.put("discovery", parsed.jobId, disc);
      }
      return json({ ok: true, jobId: parsed.jobId, archivedGroups: parsed.groups.length });
    },
  },
  {
    // R10.7 P0-5：外部 Agent 机会卡写口（suggest scope）——初筛 appGap 由内置自动转卡，
    // Agent 主分析产出的深挖卡（form 六值+monetization）经此写回。
    methods: ["PUT", "POST"],
    pattern: "agent/opportunities",
    scope: "suggest",
    methodGuardFirst: true,
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        title: z.string().min(1).max(120),
        oneLiner: z.string().min(1).max(300),
        form: z.enum(["web-app", "site-group", "mobile-app", "mini-program", "tool", "open-source"]),
        monetization: z.string().max(60).optional(),
        signals: z.array(z.enum(["complaint", "newtech", "news", "trend"])).max(4).optional(),
        url: z.string().max(2048).optional(),
        term: z.string().max(120).optional(),
        verifyPlan: z.array(z.string().max(300)).max(4).optional(),
      }).strict().parse(await readBody());
      return json(writeAgentOpportunity(db, parsed));
    },
  },
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
  {
    // R10.24-5：向量事件线检索——外部 Agent 合并判断前 KNN 查历史同事件（topK=5）；
    // index=eventline 组摘要 / termcluster 增量词。可选 sinceHours/untilHours 圈窗口。
    methods: ["POST"],
    pattern: "agent/vectors/search",
    scope: "suggest",
    participants: true,
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        index: z.enum(["eventline", "termcluster"]),
        text: z.string().min(1).max(2000),
        topK: z.number().int().min(1).max(20).default(5),
        sinceHours: z.number().int().min(1).max(8760).optional(),
        untilHours: z.number().int().min(1).max(8760).optional(),
      }).strict().parse(await readBody());
      const nowSec = Math.floor(Date.now() / 1000);
      const hits = await searchVectors(db, parsed.index, parsed.text, {
        topK: parsed.topK,
        sinceTs: parsed.sinceHours ? nowSec - parsed.sinceHours * 3600 : undefined,
        untilTs: parsed.untilHours ? nowSec - parsed.untilHours * 3600 : undefined,
      });
      return json({ ok: true, index: parsed.index, degraded: hits === null, hits: (hits || []).map((h) => ({ title: h.title, jobId: h.jobId, attention: h.attention, similarity: Number(h.similarity.toFixed(4)), date: h.date })) });
    },
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
  // 选题去重记忆（第七轮批3 W7-9.5）：与已拍板选题核心词重合 ≥2/3 标「已覆盖变体」
  const { covered } = markCoveredVariants(db as any, cluster as any);
  if (covered && !(cluster as any).coveredVariant) (cluster as any).coveredVariant = coveredVariantDoc(covered);
  db.put("clusters", cluster.id, cluster);
  return json({ ...cluster, merged: !!dup, replaced: !!existing }, existing ? 200 : 201);
}

async function upsertOutline(ctx: RouteContext, input: unknown) {
  const { db } = ctx;
  const parsed = z.object({
    id: z.string().min(1).max(100).optional(),
    clusterId: z.string().min(1),
    platform: z.string().min(1).max(30),
    category: z.string().max(30).optional(),
    contentType: z.string().min(1).max(30),
    title: z.string().min(1).max(300),
    outline: z.array(z.string().max(300)).max(20).optional(),
    keyPoints: z.array(z.string().max(300)).max(20).optional(),
    evidenceRefs: z.array(z.string().max(2048)).max(200).optional(),
    draftBody: z.string().max(100000).optional(),
  }).parse(input);
  if (!db.get<any>("clusters", parsed.clusterId)) throw new AppError("簇不存在，请先经 /api/v1/agent/clusters 创建。", 404, "NOT_FOUND");
  // R10.11-1 P0：平台归一与 UI 口同口径——未知值 400 带允许列表
  const platform = normalizePlatform(parsed.platform);
  if (!platform) throw new AppError(`未知平台「${parsed.platform}」；允许值：${PLATFORM_KEYS.join(", ")}（或其显示标签）。`, 400);
  const category = parsed.category ? normalizeCategory(parsed.category) ?? parsed.category : undefined;
  // R10.21-1 P0：组结构校验——仅当日 collectall 批已落盘且该批无组时触发（防半失败态）；
  // 无批次（fresh clone/测试/纯 UI 操作）不阻断
  const shDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const caDone = db.get<any>("meta", "collect-all-done:" + shDay);
  const caGroups = db.get<any>("candidate-groups", "tg-collectall-" + shDay);
  if (caDone && !caGroups && !parsed.id) throw new AppError("组结构未写回，先 PUT /agent/triage/groups", 400, "GROUPS_MISSING");
  // R10.21-2 P0：48h 跨日去重——同标题（精确匹配）48h 内已写入 → 跳过
  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const trimmedTitle = parsed.title.trim();
  const duplicate = db.list<any>("outlines").find((o) =>
    o.id !== parsed.id && String(o.title || "").trim() === trimmedTitle &&
    String(o.createdAt || "") >= cutoff48h,
  );
  if (duplicate && !parsed.id) return json({ ok: true, duplicate: true, existingId: duplicate.id, title: duplicate.title }, 200);
  // R10.23-3：跨日语义去重（48h 窗口不含当日）——与前两天组摘要相似度 >0.92 视为重复事件；
  // 向量线降级时返回 null，照常写入（与标题级去重互补）
  if (!parsed.id) {
    const semantic = await findSemanticDuplicate(db, trimmedTitle);
    if (semantic)
      return json({ ok: true, duplicate: true, semantic: true, score: semantic.score, matchedEvent: { key: semantic.matchedEvent.key, title: semantic.matchedEvent.title, jobId: semantic.matchedEvent.jobId } }, 200);
  }
  const existing = parsed.id ? db.get<any>("outlines", parsed.id) : null;
  const outline = existing
    ? { ...existing, clusterId: parsed.clusterId, platform, ...(category ? { category } : {}), contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || existing.outline, keyPoints: parsed.keyPoints || existing.keyPoints, evidenceRefs: parsed.evidenceRefs || existing.evidenceRefs, ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx) }
    : { id: "out-" + randomUUID(), clusterId: parsed.clusterId, platform, ...(category ? { category } : {}), contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending", ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx), createdAt: now() };
  db.put("outlines", outline.id, outline);
  return json(outline, existing ? 200 : 201);
}
