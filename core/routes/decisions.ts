// 人工拍板域（UI）：队列/统计/手动建档/批量/草稿/发布回填/单条拍板（decisions、artifacts、outlines 三载体）。
// 拍板只能由人完成——这些是 none-scope 路由，外部 Agent 无任何写入口。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { PLATFORM_KEYS, normalizePlatform, normalizeCategory } from "../platforms";

// 决策拍板入参：rejected 必须给否决原因；published 建议给发布链接（回填）。
const decisionInput = z.object({
  decision: z.enum(["approved", "rejected", "deferred", "drafting", "published", "pending"]),
  platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
  rejectReason: z.string().min(1).max(60).optional(),
  publishedRef: z.string().max(500).optional(),
}).strict().refine((v) => v.decision !== "rejected" || !!v.rejectReason, "否决必须给出否决原因。");

const statusOf = (query: URLSearchParams) => {
  const rawStatus = query.get("status") || undefined;
  return rawStatus === "all" ? undefined : rawStatus;
};

export const routes: RouteDef[] = [
  {
    methods: ["GET"],
    pattern: "decisions",
    handler: ({ db, query }) => json({ items: db.decisionsQueue(statusOf(query), { includeAll: query.get("includeArchived") === "1" }), generatedAt: now() }),
  },
  {
    methods: ["GET"],
    pattern: "decisions/stats",
    handler: ({ db }) => json(db.decisionsStats()),
  },
  {
    methods: ["POST"],
    pattern: "decisions/manual",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        title: z.string().min(1).max(300),
        notes: z.string().max(2000).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
      }).strict().parse(await readBody());
      const record = { id: "dec-" + randomUUID(), title: parsed.title, notes: parsed.notes, platforms: parsed.platforms || [], decision: "pending" as const, createdAt: now() };
      db.put("decisions", record.id, record);
      return json(record, 201);
    },
  },
  {
    methods: ["POST"],
    pattern: "decisions/batch",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        ids: z.array(z.string().min(1)).min(1).max(100),
        decision: z.enum(["approved", "rejected", "deferred"]),
        rejectReason: z.string().max(60).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(6).optional(),
      }).strict().parse(await readBody());
      if (parsed.decision === "rejected" && !parsed.rejectReason) throw new AppError("批量否决必须给出否决原因。", 400, "INVALID_PAYLOAD");
      const results = parsed.ids.map((id) => {
        try { return { id, ok: true, row: db.setDecision(id, { decision: parsed.decision, rejectReason: parsed.rejectReason, platforms: parsed.platforms, decidedBy: "human" }) }; }
        catch (error) { return { id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
      });
      return json({ ok: true, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
    },
  },
  {
    methods: ["POST"],
    pattern: "decisions/:id/draft",
    handler: async ({ db, params, readBody }) => {
      const { draftBody } = z.object({ draftBody: z.string().max(100000) }).strict().parse(await readBody());
      const { collection, row } = db.decisionTarget(params.id);
      db.put(collection, row.id, { ...row, draftBody });
      return json({ ok: true, id: row.id, draftBody });
    },
  },
  {
    methods: ["POST"],
    pattern: "decisions/:id/publish",
    handler: async ({ db, params, readBody }) => {
      // R10.48：publishedRef 可空——有链接存链接，无链接只切状态（decidedAt 照记）
      const { publishedRef, platform } = z.object({ publishedRef: z.string().max(500).optional(), platform: z.string().max(30).optional() }).parse(await readBody());
      return json(db.setDecision(params.id, { decision: "published", ...(publishedRef ? { publishedRef } : {}), ...(platform ? { platform } : {}) }));
    },
  },
  {
    methods: ["POST"],
    pattern: "decisions/:id/decision",
    handler: async ({ db, params, readBody }) => {
      const parsed = decisionInput.parse(await readBody());
      return json(db.setDecision(params.id, { ...parsed, decidedBy: "human" }));
    },
  },
  {
    methods: ["POST"],
    pattern: "artifacts/:id/decision",
    handler: async ({ db, params, readBody }) => {
      const parsed = decisionInput.parse(await readBody());
      return json(db.setDecision(params.id, { ...parsed, decidedBy: "human" }));
    },
  },
  {
    methods: ["POST"],
    pattern: "outlines/:id/decision",
    handler: async ({ db, params, readBody }) => {
      const parsed = decisionInput.parse(await readBody());
      return json(db.setDecision(params.id, { ...parsed, decidedBy: "human" }));
    },
  },
  {
    // R10.50：平台编辑口（选题状态与平台解耦）——platforms 只是适配标注，点徽章增删
    // 不触发状态。传 { platform } 切换增删；传 { platforms } 整组覆写。
    methods: ["PUT", "POST"],
    pattern: "outlines/:id/platforms",
    scope: "suggest",
    handler: async ({ db, params, readBody }) => {
      const parsed = z.object({
        platform: z.string().min(1).max(30).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(9).optional(),
      }).strict().parse(await readBody());
      const outline = db.get<any>("outlines", params.id);
      if (!outline) throw new AppError("大纲不存在", 404, "NOT_FOUND");
      // 归一+校验：toggle 单平台或整组覆写（与 R10.35 create 口同一 normalizePlatform 链）
      let platforms = (outline.platforms?.length ? outline.platforms : [outline.platform].filter(Boolean)) as string[];
      if (parsed.platforms?.length) {
        platforms = [];
        for (const raw of parsed.platforms) {
          const k = normalizePlatform(raw);
          if (!k) throw new AppError(`未知平台「${raw}」；允许值：${PLATFORM_KEYS.join(", ")}（或其显示标签）。`, 400, "UNKNOWN_PLATFORM");
          if (!platforms.includes(k)) platforms.push(k);
        }
      } else if (parsed.platform) {
        const key = normalizePlatform(parsed.platform);
        if (!key) throw new AppError(`未知平台「${parsed.platform}」；允许值：${PLATFORM_KEYS.join(", ")}。`, 400, "UNKNOWN_PLATFORM");
        platforms = platforms.includes(key) ? platforms.filter((p) => p !== key) : [...platforms, key];
      } else {
        throw new AppError("platform 或 platforms 至少给一个。", 400, "MISSING_PLATFORM");
      }
      if (!platforms.length) throw new AppError("platforms 不能为空——选题至少标注一个平台；如需退出流程请走否决/暂缓。", 400, "EMPTY_PLATFORMS");
      // R10.50：decision 全局唯一，平台增删零状态联动
      db.put("outlines", params.id, { ...outline, platforms, platform: platforms[0], updatedAt: now() });
      return json({ ok: true, platforms, platform: platforms[0] });
    },
  },
  {
    // 题材点改（第六轮批 B §2②）：审查台题材徽章可点改（LLM 初标的人工纠偏口）
    methods: ["PUT", "POST"],
    pattern: "outlines/:id/category",
    handler: async ({ db, params, readBody }) => {
      const parsed = z.object({ category: z.string().min(1).max(30) }).strict().parse(await readBody());
      const outline = db.get<any>("outlines", params.id);
      if (!outline) throw new AppError("大纲不存在", 404, "NOT_FOUND");
      const category = normalizeCategory(parsed.category);
      if (!category) throw new AppError("未知题材，允许值：" + "newtech/news/oss/selfproduct/thinking/hot", 400, "UNKNOWN_CATEGORY");
      db.put("outlines", params.id, { ...outline, category, updatedAt: now() });
      return json({ ok: true, category });
    },
  },
];
