// 人工侧内容簇与大纲（UI）：列表全量返回（与 agent 分页口不同，保持既有行为）、创建。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { normalizePlatform, PLATFORM_KEYS } from "../platforms";
import { markCoveredVariants, coveredVariantDoc } from "../topic-dedupe";

export const routes: RouteDef[] = [
  { methods: ["GET"], pattern: "clusters", handler: ({ db }) => json({ items: (db.list("clusters") as any[]).filter((c) => c.status !== "archived").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) }) },
  { methods: ["GET"], pattern: "outlines", handler: ({ db }) => json({ items: db.list("outlines").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)) }) },
  {
    methods: ["POST"],
    pattern: "clusters",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        topic: z.string().min(1).max(200),
        memberIds: z.array(z.string().min(1)).max(2000),
        kind: z.string().min(1).max(30),
        window: z.string().max(60).optional(),
        suggestedPlatforms: z.array(z.string().max(30)).max(8).optional(),
        target: z.enum(["hotspots", "evidence"]).optional(),
      }).strict().parse(await readBody());
      const cluster = { id: "clu-" + randomUUID(), topic: parsed.topic, memberIds: parsed.memberIds, memberCount: parsed.memberIds.length, kind: parsed.kind, window: parsed.window || "", suggestedPlatforms: parsed.suggestedPlatforms || [], target: parsed.target || "hotspots", status: "active", producedBy: "human", createdAt: now() } as any;
      // 选题去重记忆（第七轮批3 W7-9.5）
      const { covered } = markCoveredVariants(db as any, cluster);
      if (covered) cluster.coveredVariant = coveredVariantDoc(covered);
      db.put("clusters", cluster.id, cluster);
      return json(cluster, 201);
    },
  },
  {
    // R10.35 裁决修复（P1）：UI 手动建大纲与 agent 写口同模型——platforms（适合平台集合，
    // 主字段）+recommendation（推荐建议）；只给 platform 的旧形态收敛 platforms:[platform]。
    // 此前选题助手只改了 agent PUT 口，本路由 .strict() 不认识新字段 → 审查台手动表单必 400。
    // 手动口不设空壳闸：表单本身只有标题+建议，老大手动登记不该被拦。
    methods: ["POST"],
    pattern: "outlines",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        clusterId: z.string().min(1),
        platform: z.string().min(1).max(30).optional(),
        platforms: z.array(z.string().min(1).max(30)).max(9).optional(),
        recommendation: z.string().max(2000).optional(),
        contentType: z.string().min(1).max(30),
        title: z.string().min(1).max(300),
        outline: z.array(z.string().max(300)).max(20).optional(),
        keyPoints: z.array(z.string().max(300)).max(20).optional(),
        evidenceRefs: z.array(z.string().max(2048)).max(200).optional(),
      }).strict().parse(await readBody());
      if (!db.get("clusters", parsed.clusterId)) throw new AppError("簇不存在，请先创建内容簇。", 404);
      // R10.7 P0-4：平台归一（裸 string 曾让中文/硬编码值直落库，拍板口按 PLATFORM_KEYS 找不到而静默失效）
      const rawPlatforms = parsed.platforms?.length ? parsed.platforms : parsed.platform ? [parsed.platform] : [];
      if (!rawPlatforms.length) throw new AppError(`platforms 或 platform 至少给一个；允许值：${PLATFORM_KEYS.join(", ")}。`, 400);
      const platforms: string[] = [];
      for (const raw of rawPlatforms) {
        const p = normalizePlatform(raw);
        if (!p) throw new AppError(`未知平台「${raw}」；允许值：${PLATFORM_KEYS.join(", ")}（或其显示标签）。`, 400);
        if (!platforms.includes(p)) platforms.push(p);
      }
      const outline = { id: "out-" + randomUUID(), clusterId: parsed.clusterId, platform: platforms[0], platforms, ...(parsed.recommendation !== undefined ? { recommendation: parsed.recommendation } : {}), contentType: parsed.contentType, title: parsed.title, outline: parsed.outline || [], keyPoints: parsed.keyPoints || [], evidenceRefs: parsed.evidenceRefs || [], decision: "pending" as const, producedBy: "human", createdAt: now() };
      db.put("outlines", outline.id, outline);
      return json(outline, 201);
    },
  },
];
