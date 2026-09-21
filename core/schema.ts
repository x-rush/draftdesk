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
      .object({ name: text, value: text, unit: text, period: text })
      .optional(),
    contentLevel: z
      .enum(["fulltext", "excerpt", "headline"])
      .default("excerpt"),
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
]);
export type ArtifactDraft = z.infer<typeof artifactSchema>;
export type Artifact = ArtifactDraft & {
  id: string;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  quality: "ready" | "review";
  issues: string[];
  reviewNote: string;
  skillVersion: string;
  visibility: "private" | "public";
  saved: boolean;
  archived: boolean;
};
export const batchSchema = z
  .object({
    items: z.array(artifactSchema).max(12),
    rejected: z
      .array(z.object({ reason: text, evidenceIds: z.array(id).max(10) }))
      .max(30),
  })
  .strict();
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
export const sourceSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    type: z.enum(["rss", "trends", "github", "web"]),
    url: url.optional(),
    region: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    query: z.string().max(300).optional(),
    sourceType: evidenceSchema.shape.sourceType,
    enabled: z.boolean(),
    note: z.string().max(1000),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
export const planSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    kind: z.enum(["editorial", "trends", "opportunity", "people"]),
    goal: text,
    audience: text,
    keywords: z.array(z.string().min(1).max(250)).max(8),
    excludeKeywords: strings,
    includeDomains: z
      .array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i))
      .max(12),
    sourceIds: z.array(id).min(1).max(12),
    lookbackDays: z.number().int().min(1).max(90),
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
};
