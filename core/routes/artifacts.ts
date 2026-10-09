// 内容产物域（UI）：公开页、详情、研究脉络、人工编辑保存、讨论草稿落库。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { artifactSchema, type Artifact, type Evidence } from "../schema";
import { qualityIssues } from "../quality";
import { type ResearchEvent, type MetricSnapshot, metricComparison } from "../history";

export const routes: RouteDef[] = [
  {
    methods: ["GET"],
    pattern: "public",
    handler: ({ db }) => json({
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
    }),
  },
  {
    methods: ["GET"],
    pattern: "artifacts/:id",
    handler: ({ db, params }) => {
      const artifact = db.get<Artifact>("artifacts", params.id);
      if (!artifact || artifact.archived) throw new AppError("内容不存在或已归档", 404);
      return json(artifact);
    },
  },
  {
    methods: ["GET"],
    pattern: "history/:id",
    handler: ({ db, params }) => {
      const artifact = db.get<Artifact>("artifacts", params.id);
      if (!artifact) throw new AppError("内容不存在", 404);
      const events = db.list<ResearchEvent>("events").filter((e) => e.evidenceIds.some((id) => artifact.evidenceIds.includes(id)));
      const ids = new Set(events.flatMap((e) => e.evidenceIds));
      const all = db.list<MetricSnapshot>("metrics");
      const series = new Set(all.filter((m) => ids.has(m.evidenceId)).map((m) => m.seriesId));
      return json({ events, metrics: all.filter((m) => series.has(m.seriesId)).sort((a, b) => b.at.localeCompare(a.at)).map((m) => ({ ...m, comparison: metricComparison(all, m) })),
        related: db.list<Artifact>("artifacts").filter((a) => a.id !== artifact.id && !a.archived && a.evidenceIds.some((id) => ids.has(id))).map((a) => ({ id: a.id, title: a.title })) });
    },
  },
  {
    methods: ["POST"],
    pattern: "artifacts",
    handler: async ({ db, readBody }) => json(
      db.updateArtifact(
        z
          .object({
            id: z.string(),
            revision: z.number().int(),
            draft: z.unknown().optional(),
            creationStatus: z.enum(["inbox", "planned", "writing", "published"]).optional(),
            decision: z.enum(["pending", "approved", "rejected", "deferred", "drafting", "published"]).optional(),
            rejectReason: z.string().max(60).optional(),
            platforms: z.array(z.string().max(30)).max(6).optional(),
            archived: z.boolean().optional(),
            visibility: z.enum(["private", "public"]).optional(),
          })
          .parse(await readBody()),
      ),
    ),
  },
  {
    // 讨论整理草稿：保存即 approved（人工署名），质量检查意见随行
    methods: ["POST"],
    pattern: "save-draft",
    handler: async ({ db, readBody }) => {
      const input = await readBody();
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
    },
  },
];
