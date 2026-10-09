// 人工拍板域（UI）：队列/统计/手动建档/批量/草稿/发布回填/单条拍板（decisions、artifacts、outlines 三载体）。
// 拍板只能由人完成——这些是 none-scope 路由，外部 Agent 无任何写入口。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";

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
    handler: ({ db, query }) => json({ items: db.decisionsQueue(statusOf(query)), generatedAt: now() }),
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
      const { publishedRef } = z.object({ publishedRef: z.string().min(1).max(500) }).parse(await readBody());
      return json(db.setDecision(params.id, { decision: "published", publishedRef }));
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
];
