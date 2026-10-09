// 研究任务域（UI）：入队、取消、任务上下文查询。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import type { Job } from "../schema";

export const routes: RouteDef[] = [
  {
    methods: ["GET"],
    pattern: "job-context/:id",
    handler: ({ db, params }) => json({
      analysis: db.get("job-context", params.id),
      draft: db.get("job-draft", params.id),
      verification: db.get("job-verification", params.id) || [],
    }),
  },
  {
    methods: ["POST"],
    pattern: "jobs",
    handler: async ({ db, readBody }) => {
      const value = z
        .object({
          planId: z.string(),
          evidenceIds: z.array(z.string()).max(60).default([]),
          receiptId: z.string().optional(),
          retry: z.boolean().default(false),
          targetKeywords: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
        })
        .parse(await readBody());
      if (db.get<any>("plans", value.planId)?.kind === "activities" && !value.evidenceIds.length) throw new AppError("请先从创作活动页面导入官方规则；活动研究不再使用搜索。", 400);
      if (value.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("证据不存在");
      return json(db.enqueue(value.planId, value.evidenceIds, undefined, value.receiptId, value.retry, value.targetKeywords), 202);
    },
  },
  {
    methods: ["POST"],
    pattern: "cancel",
    handler: async ({ db, readBody }) => {
      const id = z.string().parse((await readBody()).id);
      const j = db.get<Job>("jobs", id);
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
    },
  },
];
