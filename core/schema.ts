import { z } from "zod";
export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const text = z.string().trim().min(1).max(3000);
export const url = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return (
      ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "只接受无凭据的 HTTP/HTTPS 链接");
const strings = z.array(text).max(20);
export const evidenceSchema = z
  .object({
    id: id.optional(),
    title: z.string().min(1).max(300),
    url,
    excerpt: z.string().max(12000),
    publishedAt: z.string().datetime().optional(),
    collectedAt: z.string().datetime(),
    sourceType: z.enum([
      "official",
      "media",
      "community",
      "product",
      "repository",
      "trend",
      "other",
    ]),
    region: z.string().max(80).default("未知"),
    language: z.string().max(20).default("zh"),
    metric: z
      .object({ name: text, value: text, unit: text, period: text, cadence: z.enum(["instant", "day", "week"]).optional() })
      .optional(),
    contentLevel: z
      .enum(["fulltext", "excerpt", "headline"])
      .default("excerpt"),
    acquisition: z.object({method:z.enum(["platform","aggregator"]),provider:z.string().max(80),platform:z.string().max(80),observedAt:z.string().datetime().optional()}).strict().optional(),
  })
  .strict();
export type EvidenceInput = z.input<typeof evidenceSchema>;
export type Evidence = z.output<typeof evidenceSchema> & {
  id: string;
  provenance: string;
  fingerprint: string;
};
const claim = z
  .object({
    statement: text,
    type: z.enum(["fact", "inference", "hypothesis"]),
    evidenceIds: z.array(id).max(10),
    quote: z.string().max(300).optional(),
  })
  .strict();
const common = {
  id: id.optional(),
  title: z.string().min(3).max(120),
  summary: z.string().min(20).max(2500),
  audience: text,
  whyNow: text,
  personalImpact: text,
  tags: z.array(z.string().min(1).max(30)).max(12),
  evidenceIds: z.array(id).min(1).max(15),
  claims: z.array(claim).min(1).max(10),
  unknowns: strings,
  nextActions: z.array(text).min(1).max(8),
};
export const artifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("news"),
      details: z.object({
        whatChanged: text,
        availability: text,
        limitations: strings,
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("topic"),
      details: z.object({
        angle: text,
        readerPromise: text,
        outline: z.array(text).min(3).max(12),
        materialChecklist: strings,
        platforms: z
          .array(
            z.object({
              name: z.enum(["公众号", "小红书", "其他"]),
              titles: z.array(z.string().max(120)).min(1).max(3),
              hook: text,
              structure: z.array(text).min(2).max(12),
            }),
          )
          .min(1)
          .max(3),
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("trend"),
      details: z.object({
        keyword: text,
        region: text,
        window: text,
        intent: text,
        signalEvidenceIds: z.array(id).min(1).max(10),
        comparison: text,
        opportunity: text,
        cautions: strings,
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("idea"),
      details: z.object({
        job: text,
        trigger: text,
        frequency: text,
        alternatives: strings,
        differentiation: text,
        mvp: z.array(text).min(2).max(8),
        nonGoals: strings,
        willingnessToPay: text,
        experiment: text,
        successCriteria: text,
        stopCriteria: text,
      }),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("person"),
      details: z.object({
        name: text,
        identity: text,
        publicChannels: z.array(url).min(1).max(8),
        recentWork: strings,
        angles: strings,
        identityCaveat: text,
      }),
    })
    .strict(),
  z.object({...common,kind:z.literal("activity"),details:z.object({
    platform:z.enum(["哔哩哔哩","抖音","快手","小红书"]),
    activityUrl:url,
    startsAt:z.string().datetime({offset:true}).nullable(),
    endsAt:z.string().datetime({offset:true}).nullable(),
    dateText:text,
    dateQuote:z.string().max(1000),
    access:z.enum(["public","login_required","lead"]),
    eligibility:text,
    rewards:text,
    requirements:z.array(text).min(1).max(10),
    fit:z.enum(["suitable","verify","ineligible"]),
    fitReason:text,
    directions:z.array(z.object({title:z.string().min(3).max(120),angle:text,format:text,outline:z.array(text).min(2).max(6),ruleFit:text,effort:text})).min(3).max(5)
  })}).strict(),
]);
export type ArtifactDraft = z.infer<typeof artifactSchema>;
export type Artifact = ArtifactDraft & {
  id: string;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  quality: "ready" | "review" | "rejected";
  issues: string[];
  reviewNote: string;
  skillVersion: string;
  visibility: "private" | "public";
  saved: boolean;
  creationStatus?: "inbox" | "planned" | "writing" | "published";
  archived: boolean;
};
export const batchSchema = z
  .object({
    items: z.array(artifactSchema).max(12),
    rejected: z
      .array(z.object({ reason: text, evidenceIds: z.array(id).max(10).default([]) }))
      .max(30),
  })
  .strict();
export function researchBatchSchema(kind: "editorial" | "trends" | "opportunity" | "people" | "activities" | "topic", maxItems: number, evidenceIds?: string[]) {
  const item = kind === "editorial" ? z.union([artifactSchema.options[0], artifactSchema.options[1]])
    : kind === "topic" ? artifactSchema.options[1]
    : kind === "trends" ? artifactSchema.options[2]
    : kind === "opportunity" ? artifactSchema.options[3] : kind === "activities" ? artifactSchema.options[5] : artifactSchema.options[4];
  return z.object({ items: z.array(item).max(maxItems), rejected: batchSchema.shape.rejected }).strict().superRefine((batch, ctx) => {
    if (!evidenceIds) return;
    batch.items.forEach((draft, index) => {
      const check = (refs: string[], field: (string | number)[]) => refs.forEach((id, refIndex) => {
        if (!evidenceIds.includes(id) || (field[0] !== "evidenceIds" && !draft.evidenceIds.includes(id)))
          ctx.addIssue({ code: "custom", path: ["items", index, ...field, refIndex], message: "引用必须逐字复制本次输入 evidence 的 id，且列入本条 evidenceIds。允许的 ID：" + evidenceIds.join(", ") });
      });
      check(draft.evidenceIds, ["evidenceIds"]);
      draft.claims.forEach((claim, claimIndex) => check(claim.evidenceIds, ["claims", claimIndex, "evidenceIds"]));
      if (draft.kind === "trend") check(draft.details.signalEvidenceIds, ["details", "signalEvidenceIds"]);
    });
  });
}
export const clusterSchema = z
  .object({
    clusters: z
      .array(
        z.object({
          label: text,
          summary: text,
          evidenceIds: z.array(id).min(1).max(15),
          contradictions: strings,
          missing: strings,
        }),
      )
      .max(20),
    excluded: z.array(z.object({ evidenceId: id, reason: text })).max(60),
  })
  .strict();
export const reviewSchema = z
  .object({
    reviews: z
      .array(
        z.object({
          index: z.number().int().min(0).max(11),
          verdict: z.enum(["pass", "revise", "reject"]),
          issues: strings,
          note: text,
        }),
      )
      .max(12),
  })
  .strict();
export function researchClusterSchema(evidenceIds: string[]) {
  return clusterSchema.superRefine((batch, ctx)=>{
    const check=(value:string,path:(string|number)[])=>{
      if(!evidenceIds.includes(value))ctx.addIssue({code:"custom",path,message:"必须逐字复制输入 evidence.id，不使用序号或重新生成 ID。允许值："+evidenceIds.join(", ")});
    };
    batch.clusters.forEach((c,i)=>c.evidenceIds.forEach((id,j)=>check(id,["clusters",i,"evidenceIds",j])));
    batch.excluded.forEach((e,i)=>check(e.evidenceId,["excluded",i,"evidenceId"]));
  });
}
export const sourceSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    type: z.enum(["rss", "trends", "hotlist", "aggregated", "github", "web"]),
    url: url.optional(),
    region: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    query: z.string().max(300).optional(),
    sourceType: evidenceSchema.shape.sourceType,
    officialDomains: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i)).max(10).optional(),
    enabled: z.boolean(),
    note: z.string().max(1000),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
export const planSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    kind: z.enum(["editorial", "trends", "opportunity", "people", "activities"]),
    goal: text,
    audience: text,
    keywords: z.array(z.string().min(1).max(250)).max(8),
    focusTerms: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    requireMetrics: z.boolean().optional(),
    excludeKeywords: strings,
    includeDomains: z
      .array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i))
      .max(12),
    sourceIds: z.array(id).min(1).max(12),
    lookbackDays: z.number().int().min(1).max(365),
    maxEvidence: z.number().int().min(3).max(60),
    maxQueries: z.number().int().min(0).max(8),
    maxItems: z.number().int().min(1).max(8),
    maxModelCalls: z.number().int().min(3).max(6),
    maxTokens: z.number().int().min(30000).max(200000),
    scheduleEnabled: z.boolean(),
    dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    publishPolicy: z.literal("manual"),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export const configSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine(
        (v) =>
          /^https:\/\/(?:[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com|dashscope\.aliyuncs\.com)\/compatible-mode\/v1\/?$/.test(
            v,
          ),
        "使用百炼专属地址或官方兼容接口",
      ),
    model: z.string().min(1).max(150),
    profile: text,
    apiKey: z.string().max(500).optional(),
    tavilyKey: z.string().max(500).optional(),
    clearApiKey: z.boolean().optional(),
    clearTavilyKey: z.boolean().optional(),
    dailyTokenLimit: z.number().int().min(30000).max(2000000),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const intakeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    submissionId: id,
    producer: z.object({
      name: z.string().min(1).max(100),
      version: z.string().max(100),
    }),
    evidence: z.array(evidenceSchema).min(1).max(60),
    drafts: z.array(artifactSchema).max(12).default([]),
  })
  .strict();
export const discussionSchema = z
  .object({
    id,
    artifactId: id.optional(),
    message: z.string().trim().min(1).max(10000),
  })
  .strict();
export type Conversation = {
  id: string;
  title: string;
  artifactId?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    status?: "stopped" | "failed";
  }>;
  updatedAt: string;
};
export type Job = {
  id: string;
  planId: string;
  plan: Plan;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  createdAt: string;
  finishedAt?: string;
  leaseUntil?: number;
  cancelRequested?: boolean;
  steps: Array<{ name: string; state: string; detail: string; at: string }>;
  evidenceIds: string[];
  calls: number;
  reservedTokens: number;
  actualTokens: number;
  warnings: string[];
  error?: string;
  external: boolean;
  skillVersions: Record<string, string>;
  searchCount?: number;
  receiptId?: string;
  outcome?: "produced" | "no-findings";
};
