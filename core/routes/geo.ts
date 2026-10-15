// 哥飞采集数据路由（第七轮批3 W7-9/W7-10 新增5）：标杆站监控 + 外链反推的 UI/Agent 读口。
// benchmark-sites（标杆站清单，可增删）/ benchmark-pages（关键词排名页面）/ link-prospects（外链来源站）。
// 「加入词库候选」= UI 无令牌写口，把高流量页需求词以 source=gephei-ideas 观测进 seen-terms。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { paginatedSql } from "../http/pagination";
import { now } from "../store";
import { observeSuggestion, termId } from "../seen-terms";
import { ensureBenchmarkSeeds, applyManualGephei } from "../gephei-collect";
import { dailyMetricsCandidates, isEnglishTerm, siteGateOf } from "../seo-gate";
import { gepheiToolLinks } from "../seo-source";

const BRAND_RE = /openai|anthropic|claude|gemini|midjourney|perplexity|google|microsoft|github|amazon|netlify|facebook|apple|nvidia|notion|slack|zoom|figma|spotify|youtube|tesla|chatgpt|bytedance|baidu|alibaba|tencent/i;

export const routes: RouteDef[] = [
  {
    // UI 读口：标杆站清单 + 每站页面数与新词统计
    methods: ["GET"],
    pattern: "benchmark-sites",
    handler: ({ db }) => {
      ensureBenchmarkSeeds(db);
      const sites = db.list<any>("benchmark-sites").map((s) => {
        const pages = db.list<any>("benchmark-pages").filter((p) => p.host === s.host);
        const trafficPages = pages.filter((p) => typeof p.traffic === "number").length;
        return { ...s, pageCount: pages.length, trafficPages, samplePages: pages.sort((a, b) => (b.traffic || 0) - (a.traffic || 0)).slice(0, 20) };
      });
      return json({ items: sites, total: sites.length });
    },
  },
  {
    // UI 写口：增删标杆站（哥飞挖需求法之「高流量站分析」的常驻清单）
    methods: ["POST"],
    pattern: "benchmark-sites",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        action: z.enum(["add", "remove"]),
        host: z.string().trim().min(3).max(120),
        name: z.string().trim().max(60).optional(),
      }).strict().parse(await readBody());
      const host = parsed.host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
      if (parsed.action === "remove") {
        db.del("benchmark-sites", host);
        return json({ ok: true, removed: host });
      }
      if (!host.includes(".") || BRAND_RE.test(host)) throw new Error("域名不合法或命中品牌站黑名单——标杆站应选可对标的独立工具站。");
      const prev = db.get<any>("benchmark-sites", host);
      db.put("benchmark-sites", host, { ...(prev ?? {}), id: host, host, name: parsed.name || host, addedAt: prev?.addedAt ?? now(), pagesCount: prev?.pagesCount ?? 0, producedBy: "human" });
      return json({ ok: true, added: host });
    },
  },
  {
    // UI 写口：高流量页需求词一键「加入词库候选」（source=gephei-ideas，status=new 走既有判定层）
    methods: ["POST"],
    pattern: "benchmark-words",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        items: z.array(z.object({ keyword: z.string().trim().min(1).max(80), host: z.string().max(120).optional() })).min(1).max(20),
      }).strict().parse(await readBody());
      let added = 0;
      for (const it of parsed.items) {
        const clean = it.keyword.toLowerCase().trim();
        if (!clean || clean.length < 3 || clean.length > 80) continue;
        observeSuggestion(db, clean, it.host ? `benchmark:${it.host}`.slice(0, 80) : "gephei-ideas", { source: "gephei-ideas" });
        added++;
      }
      return json({ ok: true, added, note: `已加入词库候选 ${added} 词（source=gephei-ideas，等 LLM 判定 strong 后回流挖掘）` });
    },
  },
  {
    // UI 读口：某标杆站的页面列表（点开看全）
    methods: ["GET"],
    pattern: "benchmark-pages",
    handler: ({ db, query }) => {
      const host = query.get("host") || "";
      const items = db.list<any>("benchmark-pages")
        .filter((p) => !host || p.host === host)
        .sort((a, b) => (b.traffic || b.volume || 0) - (a.traffic || a.volume || 0))
        .slice(0, 200);
      return json({ items, total: items.length });
    },
  },
  {
    // UI 读口：外链反推来源站清单
    methods: ["GET"],
    pattern: "link-prospects",
    handler: ({ db }) => json({ items: db.list<any>("link-prospects"), total: db.list<any>("link-prospects").length }),
  },
  {
    // UI 口：手动回传（批4 W7-11④）——粘贴哥飞站内查询结果（JSON/文本双模式后端解析），
    // 落词库指标字段（✋manual-gephei 权重最高）+ 已出标词的机会卡价值面板即时点亮
    methods: ["POST"],
    pattern: "seo-terms/manual",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ raw: z.string().min(2).max(20000) }).strict().parse(await readBody());
      const result = applyManualGephei(db, parsed.raw);
      return json({
        ok: true, ...result,
        note: `回传 ${result.applied} 词（${result.mode === "json" ? "JSON" : "文本"}模式）${result.cardsLit ? `，${result.cardsLit} 张站群卡价值面板已点亮` : ""}${result.intentConflicts ? `，意图冲突 ${result.intentConflicts} 条留人工` : ""}。`,
      });
    },
  },
  {
    // UI 口：最近 3 条手动回传记录
    methods: ["GET"],
    pattern: "seo-terms/manual/recent",
    handler: ({ db }) => {
      const rec = db.get<any>("meta", "manual-gephei-recent");
      return json({ items: Array.isArray(rec) ? rec.slice(0, 3) : [] });
    },
  },
  {
    // UI 口：今日待查清单（R8-4②，批4 指导行的聚合升级）——共享质量闸
    // （dailyMetricsCandidates：strong+global+低竞争+obs≥5+未出标+过期，英文优先）取前 10，
    // 每词三张实测深链；回传成功（manualAt）自动移出清单。
    methods: ["GET"],
    pattern: "seo-terms/today",
    handler: ({ db }) => {
      const gate = siteGateOf(db);
      const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
      const items = dailyMetricsCandidates(db, gate, markedIds)
        .filter((t) => isEnglishTerm(String(t.term || t.id)))
        .slice(0, 10)
        .map((t) => ({
          term: String(t.term || t.id),
          observations: t.observations ?? 0,
          links: gepheiToolLinks(String(t.term || t.id)).slice(0, 3),
        }));
      return json({ items, total: items.length, generatedAt: now() });
    },
  },
  {
    // Agent 读口：标杆站页面（第十二步消费侧=外部 Agent 挑高流量页需求词）
    methods: ["GET"],
    pattern: "agent/benchmark-pages",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => json(paginatedSql(db.kv, "benchmark-pages", query)),
  },
  {
    // Agent 读口：外链来源站（第十三步消费侧=外部 Agent 分析注册时间+流量）
    methods: ["GET"],
    pattern: "agent/link-prospects",
    scope: "read",
    methodGuardFirst: true,
    handler: ({ db, query }) => json(paginatedSql(db.kv, "link-prospects", query)),
  },
];
