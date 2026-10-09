// 数据源域（UI）：来源保存（入口白名单校验）、聚合热榜体检、策略预览、独立热点快照。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { sourceSchema } from "../schema";
import type { Plan, Source } from "../schema";
import { collect, readAggregatedHotlist, readHotspotSource } from "../sources";
import { isAggregatePlatform } from "../hotlists";
import type { DiscoveryRecord } from "../discovery";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "sources",
    handler: async ({ db, readBody }) => {
      const source = sourceSchema.parse(await readBody());
      if (source.type === "rss" && !source.url)
        throw new AppError("RSS 需要来源地址");
      if (source.type === "hotlist" && !["https://top.baidu.com/board?tab=realtime", "https://s.weibo.com/top/summary?cate=realtimehot", "https://github.com/trending", "https://hacker-news.firebaseio.com/v0/topstories.json"].includes(source.url || ""))
        throw new AppError("官方热榜入口不在允许列表中");
      if (source.type === "aggregated" && !["bilibili", "weibo", "zhihu", "douyin", "kuaishou", "toutiao", "tieba", "juejin"].includes(source.query || ""))
        throw new AppError("聚合热榜仅支持已列出的平台路由");
      if (source.type === "aggregated" && (source.sourceType !== "trend" || source.url))
        throw new AppError("聚合热榜固定为趋势线索，不能标记为官方来源或自定义采集地址");
      if (source.type === "suggest" && !(source.query || "").trim())
        throw new AppError("搜索联想来源需要至少一个种子关键词");
      if (source.type === "suggest" && source.url && source.url !== "https://www.baidu.com/sugrec")
        throw new AppError("搜索联想来源只支持默认 Google 联想或百度 sugrec 入口");
      db.put("sources", source.id, source);
      return json(source);
    },
  },
  {
    methods: ["POST"],
    pattern: "source-check",
    handler: async ({ db, req, readBody }) => {
      const { sourceId } = z.object({ sourceId: z.string() }).strict().parse(await readBody());
      const source = db.get<{ type: string; query?: string; name: string }>("sources", sourceId);
      if (!source || source.type !== "aggregated" || !source.query || !isAggregatePlatform(source.query)) throw new AppError("请选择聚合热榜来源。");
      const items = await readAggregatedHotlist(source.query, req.signal);
      return json({ ok: true, count: items.length, updatedAt: items[0].acquisition?.observedAt, method: "aggregator", provider: "DailyHotApi", platform: source.name });
    },
  },
  {
    methods: ["POST"],
    pattern: "source-preview",
    handler: async ({ db, req, readBody }) => {
      const { planId } = z.object({ planId: z.string() }).strict().parse(await readBody());
      const plan = db.get<Plan>("plans", planId);
      if (!plan || plan.kind === "activities") throw new AppError("请选择内置研究策略。", 404);
      const sourceIds = plan.sourceIds.filter((id) => { const s = db.get<Source>("sources", id); return s?.enabled && s.type !== "web"; }).slice(0, 3);
      if (!sourceIds.length) throw new AppError("此策略没有可预览的免模型来源；可在数据源页启用 RSS 或热榜。", 400);
      const id = "preview-" + randomUUID();
      const sample = { ...plan, sourceIds, maxQueries: 0, maxEvidence: Math.min(12, plan.maxEvidence) };
      const result = await collect(db, sample, AbortSignal.any([req.signal, AbortSignal.timeout(65000)]), () => {}, () => {}, id, "preview");
      return json({ record: db.get("discovery", id), evidenceCount: result.evidence.length, warnings: result.warnings });
    },
  },
  {
    methods: ["POST"],
    pattern: "hotspot-refresh",
    handler: async ({ db, req, readBody }) => {
      const { sourceId } = z.object({ sourceId: z.string() }).strict().parse(await readBody());
      const source = db.get<Source>("sources", sourceId);
      if (!source || !source.enabled || !["hotlist", "aggregated", "trends"].includes(source.type)) throw new AppError("请选择已启用的热榜或趋势来源。", 400);
      const at = now(), id = "hotspot-" + randomUUID();
      try {
        const items = (await readHotspotSource(source, AbortSignal.any([req.signal, AbortSignal.timeout(45000)]))).slice(0, 100);
        const record: DiscoveryRecord = { jobId: id, at, planName: "独立热点快照", mode: "hotspot", limit: 100,
          candidates: items.map((item, index) => ({ url: item.url, title: item.title, sourceId: source.id, sourceName: source.name, status: "watch", reason: "原始热点；未按研究策略筛选或经 AI 核实", observedAt: at, rank: index + 1, region: item.region, metric: item.metric, mediaType: item.mediaType, coverUrl: item.coverUrl, author: item.author })),
          sources: [{ sourceId: source.id, sourceName: source.name, status: "ok", raw: items.length, matched: 0, selected: 0 }] };
        db.put("discovery", id, record);
        return json({ count: items.length, source: source.name, at });
      } catch (error) {
        db.put("discovery", id, { jobId: id, at, planName: "独立热点快照", mode: "hotspot", limit: 100, candidates: [], sources: [{ sourceId: source.id, sourceName: source.name, status: "failed", raw: 0, matched: 0, selected: 0, error: error instanceof AppError ? error.message : "来源读取失败" }] } satisfies DiscoveryRecord);
        throw error;
      }
    },
  },
];
