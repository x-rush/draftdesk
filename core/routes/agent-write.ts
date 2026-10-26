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
import { indexEventGroups, findSemanticDuplicate, searchVectors, vectorIndexStatus } from "../vector-store";

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
      const incoming = parsed.groups.map((g) => ({
        ...g,
        memberUrls: g.memberUrls || [],
        representativeUrl: g.representativeUrl || g.memberUrls?.[0] || "",
        sources: g.sources || [],
        angles: g.angles || [],
      }));
      // R10.26-4①：增量合并替代整卡替换——分片回写（如 150+50 组）不再抹掉前批；
      // 同 id 组被新值覆盖（显式变更），未在本次出现的旧组保留
      const incomingIds = new Set(incoming.map((g) => g.id));
      const kept = ((record?.groups as any[]) || []).filter((g) => !incomingIds.has(g.id));
      const doc = {
        jobId: parsed.jobId,
        planName: record?.planName || "外部语义处理",
        day: record?.day || nowIso.slice(0, 10),
        at: nowIso,
        groups: [...kept, ...incoming],
        shards: 0, calls: 0, tokens: 0, merges: 0,
        source: "external" as const,
      };
      // R10.26-4①：两次落库包事务——组卡与候选判级要么全成要么全不成（中间崩溃无对账）。
      // transaction 是同步回调，动态 import 提到事务外
      const { applyTriageToCandidates } = await import("../triage");
      db.transaction(() => {
        db.put("candidate-groups", "tg-" + parsed.jobId, doc);
        // R10.20-A2：回写 discovery 候选判级标记——preserveUnclaimed 保护既有判级/人工捞回
        // 不被缩减重放清掉（重放只影响本次组认领的候选）
        const disc = db.get<any>("discovery", parsed.jobId);
        if (disc) {
          const limit = disc.limit ?? 6;
          applyTriageToCandidates(disc.candidates || [], doc.groups as any, limit, { preserveUnclaimed: true });
          const judgedBySource = new Map<string, number>();
          for (const c of disc.candidates || []) if (c.attention) judgedBySource.set(c.sourceId, (judgedBySource.get(c.sourceId) || 0) + 1);
          for (const cov of disc.sources || []) cov.selected = judgedBySource.get(cov.sourceId) || 0;
          db.put("discovery", parsed.jobId, disc);
        }
      });
      // R10.24-5：组摘要入向量事件线（fire-and-forget，失败零影响主写口；写入前清同 jobId 旧向量防陈旧误杀）
      void indexEventGroups(db, parsed.jobId, incoming as never).catch(() => {});
      return json({ ok: true, jobId: parsed.jobId, groups: doc.groups.length, mergedKept: kept.length, at: nowIso, candidatesUpdated: (() => { const disc = db.get<any>("discovery", parsed.jobId); return disc ? (disc.candidates || []).filter((c: any) => c.attention).length : 0; })() });
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
    handler: async (ctx) => upsertCluster(ctx, await ctx.readBody()),
  },
  {
    methods: ["PUT"],
    pattern: "agent/outlines",
    scope: "suggest",
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
  {
    // R10.26-1 P0：级联删簇前保护拍板历史——簇内存在已拍板大纲（decision 非 pending）
    // 一律 400 拒绝整批；全 pending 才允许级联删除（拍板记录内联在大纲行上，删大纲=删拍板）。
    methods: ["DELETE"],
    pattern: "agent/clusters/:id",
    scope: "suggest",
    handler: (ctx) => {
      const { db, params } = ctx;
      const cluster = db.get("clusters", params.id);
      if (!cluster) throw new AppError("簇不存在", 404, "NOT_FOUND");
      const mine = db.list<any>("outlines").filter((o) => o.clusterId === params.id);
      const decided = mine.filter((o) => o.decision && o.decision !== "pending");
      if (decided.length)
        throw new AppError(`簇含已拍板大纲 ${decided.length} 条（${[...new Set(decided.map((o) => o.decision))].join("/")}），拍板历史不可级联删除；请先处理拍板项或仅删除 pending 大纲。`, 400, "DECIDED_OUTLINES");
      let outlinesRemoved = 0;
      for (const o of mine) { db.del("outlines", o.id); outlinesRemoved++; }
      db.del("clusters", params.id);
      return json({ ok: true, deleted: { cluster: params.id, outlines: outlinesRemoved }, by: by(ctx) });
    },
  },
  {
    // R10.26-1 P0：单删大纲同款 decision 守卫——已拍板大纲不可删（拍板 API 将 404 成死账）
    methods: ["DELETE"],
    pattern: "agent/outlines/:id",
    scope: "suggest",
    handler: (ctx) => {
      const { db, params } = ctx;
      const outline = db.get<any>("outlines", params.id);
      if (!outline) throw new AppError("大纲不存在", 404, "NOT_FOUND");
      if (outline.decision && outline.decision !== "pending")
        throw new AppError(`大纲已拍板（${outline.decision}），不可删除；如需移除请先在审查台处理拍板项。`, 400, "DECIDED_OUTLINE");
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
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
  {
    methods: ["PUT"],
    pattern: "agent/outlines/:rest...",
    scope: "suggest",
    handler: async (ctx) => upsertOutline(ctx, await ctx.readBody()),
  },
  {
    // R10.24-5：向量事件线检索——外部 Agent 合并判断前 KNN 查历史同事件（topK=5）；
    // index=eventline 组摘要 / termcluster 增量词。可选 sinceHours/untilHours 圈窗口。
    methods: ["POST"],
    pattern: "agent/vectors/search",
    scope: "suggest",
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
  {
    // R10.27-A#3：向量索引对账读口——批次期望/实写计数（缺失组可查，外部 Agent 凭此补跑）
    methods: ["GET"],
    pattern: "agent/vectors/status",
    scope: "read",
    handler: ({ db, query }) => {
      const jobId = z.string().min(1).max(64).parse(query.get("jobId") || "");
      const status = vectorIndexStatus(db, jobId);
      if (!status) return json({ ok: true, jobId, marked: false });
      return json({ ok: true, jobId, marked: true, ...status });
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
  // R10.21-1 P0 + R10.26-4②：组校验锚「近 48h 最新 collectall 批」——堵跨零点窗与停摆日。
  // R10.27-A#6 复核：不扩到任意前缀——计划批在 external 下已无产生口（手动分析 R10.24 封死），
  // 扩面会破坏「fresh clone/测试自建批次不阻断」约定（consumer-v3 类场景），按设计保留 collectall 口径。
  const recentBatch = db.list<any>("discovery")
    .filter((d) => String(d.jobId || "").startsWith("collectall-"))
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0];
  if (recentBatch && Date.now() - Date.parse(recentBatch.at || "") < 48 * 3600000) {
    const recentGroups = db.get<any>("candidate-groups", "tg-" + recentBatch.jobId);
    if (!recentGroups && !parsed.id) throw new AppError(`组结构未写回（批次 ${recentBatch.jobId}），先 PUT /agent/triage/groups`, 400, "GROUPS_MISSING");
  }
  // R10.21-2 P0 + R10.26-4② 收紧：48h 标题去重——NFC 归一+小写+全角转半角+剥零宽字符+
  // 压缩空白后比对（全角变体/大小写/零宽空格不再放行）；更新路径（带 id）同跑查重（排除自身）
  const normalizeTitle = (t: string) => t
    .normalize("NFC").toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角→半角（！-～）
    .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, ""); // 空格全剥：中英混排「GPT-6首测/GPT-6 首测」同题
  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const normalizedTitle = normalizeTitle(parsed.title);
  const duplicate = db.list<any>("outlines").find((o) =>
    o.id !== parsed.id && normalizeTitle(String(o.title || "")) === normalizedTitle &&
    String(o.createdAt || "") >= cutoff48h,
  );
  if (duplicate) return json({ ok: true, duplicate: true, existingId: duplicate.id, title: duplicate.title }, 200);
  // R10.23-3 + R10.26-4②：跨日语义去重（48h 窗口不含当日）——更新路径同跑；
  // R10.27-F：向量线降级时照常写入但在大纲 doc 打 semanticDedupSkipped 标记（可观测，日报可查）
  let semanticSkipped = false;
  {
    const semantic = await findSemanticDuplicate(db, parsed.title.trim());
    if (semantic && "degraded" in semantic) semanticSkipped = true;
    else if (semantic)
      return json({ ok: true, duplicate: true, semantic: true, score: semantic.score, matchedEvent: { key: semantic.matchedEvent.key, title: semantic.matchedEvent.title, jobId: semantic.matchedEvent.jobId } }, 200);
  }
  const existing = parsed.id ? db.get<any>("outlines", parsed.id) : null;
  const outline = existing
    ? { ...existing, clusterId: parsed.clusterId, platform, ...(category ? { category } : {}), contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || existing.outline, keyPoints: parsed.keyPoints || existing.keyPoints, evidenceRefs: parsed.evidenceRefs || existing.evidenceRefs, ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx), ...(semanticSkipped ? { semanticDedupSkipped: true } : {}) }
    : { id: "out-" + randomUUID(), clusterId: parsed.clusterId, platform, ...(category ? { category } : {}), contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending", ...(parsed.draftBody !== undefined ? { draftBody: parsed.draftBody } : {}), producedBy: by(ctx), createdAt: now(), ...(semanticSkipped ? { semanticDedupSkipped: true } : {}) };
  db.put("outlines", outline.id, outline);
  return json(outline, existing ? 200 : 201);
}
