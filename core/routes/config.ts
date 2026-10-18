// 配置域（UI）：主配置、人设、AI 策略、消费执行方/计划模式四开关、模型与搜索连通性自检。
// 注意 agent/consumerMode 读与 UI consumerMode 读的空值兜底不同（null vs "external"），分别保留。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { configSchema } from "../schema";
import { requestModel } from "../model";
import { recentModelMetrics } from "../model-metrics";
import { searchProvider } from "../sources";
import { siteGateOf } from "../seo-gate";
import { seoSourceOf, seoBudgetUsed, seoConnectionTest } from "../seo-source";

// persona 人设配置（决策个性化输入）；字段宽松校验，结构由 UI 与种子约定。
const personaInput = z.object({
  domains: z.object({ do: z.array(z.string().max(120)).max(30), dont: z.array(z.string().max(120)).max(30) }),
  goals: z.array(z.string().max(120)).max(12),
  platformRules: z.array(z.object({ contentType: z.string().max(60), scale: z.string().max(30), platforms: z.array(z.string().max(60)).max(8) })).max(20),
  imageOnly: z.boolean(),
  scoring: z.object({ threshold: z.number().min(0).max(5), dimensions: z.array(z.object({ name: z.string().max(60), weight: z.number().min(0).max(1) })).max(12) }),
  redLines: z.array(z.string().max(200)).max(30),
  style: z.object({ principles: z.array(z.string().max(120)).max(10), tone: z.string().max(200), forbidden: z.array(z.string().max(60)).max(20), notes: z.string().max(600) }),
  // termPolicy（§2.6）/ intentPolicy（第七轮 W7-1）：Agent 管理的判定标尺块。
  // 不放行则带块保存直接 422；保存时未传字段保留旧值（UI 表单不冲掉 Agent 策略块）。
  termPolicy: z.object({
    strongHint: z.string().max(2000).optional(),
    weakHint: z.string().max(2000).optional(),
    offHint: z.string().max(2000).optional(),
    redLine: z.string().max(600).optional(),
  }).optional(),
  intentPolicy: z.object({
    tool: z.string().max(400).optional(),
    info: z.string().max(400).optional(),
    nav: z.string().max(400).optional(),
  }).optional(),
}).strict();

export const routes: RouteDef[] = [
  { methods: ["GET"], pattern: "persona", handler: ({ db }) => json(db.get("config", "persona") || null) },
  { methods: ["GET"], pattern: "aiPolicy", handler: ({ db }) => json(db.get("config", "aiPolicy") || null) },
  { methods: ["GET"], pattern: "consumerMode", handler: ({ db }) => json(db.get("config", "consumerMode") || "external") },
  { methods: ["GET"], pattern: "planMode", handler: ({ db }) => json(db.get("config", "planMode") || "collect-and-analyze") },
  {
    // 每日成本看板（成本纪律批 7）：近 N 天调用台账（cheap/full 拆分 + 升级次数），
    // 附每日 token 上限供 UI 计算占比与 150% 标黄。
    methods: ["GET"],
    pattern: "model-metrics",
    handler: ({ db, query }) => {
      const days = Math.min(30, Math.max(1, Number(query.get("days")) || 7));
      return json({ items: recentModelMetrics(db, days), dailyTokenLimit: db.config().dailyTokenLimit });
    },
  },
  {
    // 全集合核对（保险丝批 8）：昨日 vs 今日 documents 行数快照，UI 异动标黄。
    methods: ["GET"],
    pattern: "collections-report",
    handler: ({ db }) => {
      const day = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() - offset * 86400000));
      return json({
        today: db.get("collections-report", day(0)) || null,
        yesterday: db.get("collections-report", day(1)) || null,
      });
    },
  },
  {
    methods: ["POST"],
    pattern: "config",
    handler: async ({ db, readBody }) => {
      const cfg = configSchema.parse(await readBody());
      const old = db.get<any>("config", "main");
      const { clearApiKey, clearTavilyKey, ...next } = cfg;
      db.put("config", "main", {
        ...next,
        apiKey: clearApiKey ? undefined : cfg.apiKey?.trim() || old.apiKey,
        tavilyKey: clearTavilyKey ? undefined : cfg.tavilyKey?.trim() || old.tavilyKey,
      });
      return json(db.publicConfig());
    },
  },
  {
    methods: ["POST"],
    pattern: "persona",
    handler: async ({ db, readBody }) => {
      const parsed = personaInput.parse(await readBody());
      // termPolicy/intentPolicy 未传时保留旧值：UI 表单全量保存不冲掉 Agent 管理的策略块
      const old = db.get<any>("config", "persona") || {};
      const merged = {
        ...parsed,
        ...(parsed.termPolicy === undefined && old.termPolicy !== undefined ? { termPolicy: old.termPolicy } : {}),
        ...(parsed.intentPolicy === undefined && old.intentPolicy !== undefined ? { intentPolicy: old.intentPolicy } : {}),
      };
      db.put("config", "persona", merged);
      return json(merged);
    },
  },
  {
    methods: ["POST"],
    pattern: "aiPolicy",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        triage: z.enum(["off", "cheap", "full"]),
        outline: z.enum(["off", "cheap", "full"]),
        draft: z.enum(["off", "cheap", "full"]),
        aiWriter: z.enum(["builtin", "external", "both"]),
      }).strict().parse(await readBody());
      db.put("config", "aiPolicy", parsed);
      return json(parsed);
    },
  },
  {
    methods: ["POST"],
    pattern: "consumerMode",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ consumerMode: z.enum(["external", "builtin"]) }).strict().parse(await readBody());
      db.put("config", "consumerMode", parsed.consumerMode);
      return json(parsed);
    },
  },
  {
    // R10.11-2②：机会引擎全信号自动出卡开关（默认开——老大拍 B；关闭只留组级转卡）
    methods: ["GET"],
    pattern: "autoOpportunityGenerate",
    handler: ({ db }) => json(db.get("config", "autoOpportunityGenerate") || { enabled: true }),
  },
  {
    methods: ["POST"],
    pattern: "autoOpportunityGenerate",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ enabled: z.boolean() }).strict().parse(await readBody());
      db.put("config", "autoOpportunityGenerate", parsed);
      return json(parsed);
    },
  },
  {
    methods: ["POST"],
    pattern: "planMode",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ planMode: z.enum(["collect", "collect-and-analyze"]) }).strict().parse(await readBody());
      db.put("config", "planMode", parsed.planMode);
      return json(parsed);
    },
  },
  {
    // siteGate 站群门槛（第七轮 W7-4）：GET 返回合并默认值后的生效规则；
    // POST 部分更新（未传字段保留现值），判定 sweep 与候选池判定口读时生效。
    methods: ["GET"],
    pattern: "siteGate",
    handler: ({ db }) => json(siteGateOf(db)),
  },
  {
    methods: ["POST"],
    pattern: "siteGate",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        requireStrong: z.boolean().optional(),
        serpDedicatedMax: z.number().int().min(0).max(10).optional(),
        monthlySearchMin: z.number().int().min(0).max(1000000).optional(),
        kdMax: z.number().min(0).max(100).optional(),
        cpcMin: z.number().min(0).max(100).optional(),
      }).strict().parse(await readBody());
      const next = { ...siteGateOf(db), ...parsed };
      db.put("config", "siteGate", next);
      return json(next);
    },
  },
  {
    // SEO 数据源（第七轮批2 W7-3）：可选增值数据源（哥飞 SEO 工具箱，自行注册）。
    // 默认关闭零外部调用；token 只写不读（GET 脱敏为 hasToken）。联调期 baseUrl 可指向自建端点。
    methods: ["GET"],
    pattern: "seoDataSource",
    handler: ({ db }) => {
      const src = seoSourceOf(db);
      const budgetKeys = { tier: "builtinTierBudget", metrics: "builtinMetricsBudget", collect: "builtinCollectBudget" } as Record<string, "builtinTierBudget" | "builtinMetricsBudget" | "builtinCollectBudget">;
      const pools = (["tier", "metrics", "collect"] as const).map((p) => ({ pool: p, used: seoBudgetUsed(db, p), budget: src[budgetKeys[p]] }));
      return json({ enabled: src.enabled, provider: src.provider, baseUrl: src.baseUrl, pools, hasToken: !!src.token, autoMetrics: src.autoMetrics, autoCollect: src.autoCollect });
    },
  },
  {
    methods: ["POST"],
    pattern: "seoDataSource",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({
        enabled: z.boolean().optional(),
        token: z.string().max(200).optional(),
        baseUrl: z.string().url().max(300).optional(),
        builtinTierBudget: z.number().int().min(1).max(10000).optional(),
        builtinMetricsBudget: z.number().int().min(1).max(100000).optional(),
        builtinCollectBudget: z.number().int().min(1).max(10000).optional(),
        autoMetrics: z.boolean().optional(),
        autoCollect: z.boolean().optional(),
      }).strict().parse(await readBody());
      // baseUrl 白名单（批A P0-1，社区安全审查）：/test 会带 Bearer 哥飞令牌请求该地址，
      // 任意 URL 等于令牌外泄通道。默认只允许官方域；自建/联调端点经 DRAFTDESK_SEO_EXTRA_HOSTS 追加。
      if (parsed.baseUrl !== undefined) {
        const allowed = ["seo.web.cafe", ...(process.env.DRAFTDESK_SEO_EXTRA_HOSTS || "").split(",")].map((h) => h.trim().toLowerCase()).filter(Boolean);
        let host = "";
        try { host = new URL(parsed.baseUrl).hostname.toLowerCase(); } catch { throw new AppError("SEO 数据源地址格式无效。", 400); }
        if (!allowed.includes(host))
          throw new AppError(`SEO 数据源地址不在允许域名（默认 seo.web.cafe；自建端点请在环境变量 DRAFTDESK_SEO_EXTRA_HOSTS 追加，逗号分隔）。`, 400);
      }
      const prev = seoSourceOf(db);
      const token = parsed.token !== undefined ? parsed.token.trim() : prev.token;
      const next = { ...prev, ...parsed, token, provider: "gephei" as const };
      db.put("config", "seoDataSource", next);
      const budgetKeys = { tier: "builtinTierBudget", metrics: "builtinMetricsBudget", collect: "builtinCollectBudget" } as const;
      const pools = (["tier", "metrics", "collect"] as const).map((p) => ({ pool: p, used: seoBudgetUsed(db, p), budget: next[budgetKeys[p]] }));
      return json({ enabled: next.enabled, provider: next.provider, baseUrl: next.baseUrl, pools, hasToken: !!next.token, autoMetrics: next.autoMetrics, autoCollect: next.autoCollect });
    },
  },
  {
    // 连接测试（W7-10④）：轻接口验证 token + 积分余额
    methods: ["POST"],
    pattern: "seoDataSource/test",
    handler: async ({ db }) => json(await seoConnectionTest(db, fetch)),
  },
  {
    methods: ["POST"],
    pattern: "test-model",
    handler: async ({ db, req }) => {
      const result = await requestModel(db, [{ role: "user", content: "只回复：连接成功" }], { signal: req.signal });
      return json({ message: result.text, usage: result.usage });
    },
  },
  {
    methods: ["POST"],
    pattern: "test-search",
    handler: async ({ db, req }) => {
      const runTavily = async () => {
        const key = db.config().tavilyKey;
        if (!key) throw new AppError("请先保存 Tavily Key。");
        try {
          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]),
            headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query: "AI productivity tools", search_depth: "basic", max_results: 1 }),
          });
          if (!response.ok) throw new AppError(`Tavily 搜索失败（HTTP ${response.status}），请检查密钥与额度。`, 502);
          const result = await response.json();
          const count = Array.isArray(result.results) ? result.results.length : 0;
          if (!count) throw new AppError("Tavily 已响应，但本次未返回搜索结果。", 502);
          return `Tavily 实际搜索成功，返回 ${count} 条结果（消耗一次 basic 搜索额度）。`;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("Tavily 连接失败或超时，请检查网络；密钥不会回显。", 502);
        }
      };
      const runSearxng = async () => {
        const base = (db.config().searxngUrl || "http://searxng:8080").replace(/\/+$/, "");
        try {
          const response = await fetch(`${base}/search?format=json&q=${encodeURIComponent("AI productivity tools")}`, {
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
            headers: { "accept": "application/json" },
          });
          if (!response.ok) throw new AppError(`SearXNG 搜索失败（HTTP ${response.status}），请检查地址与 JSON 输出是否放行。`, 502);
          const result = await response.json();
          const count = Array.isArray(result.results) ? result.results.length : 0;
          if (!count) throw new AppError("SearXNG 已响应，但本次未返回搜索结果。", 502);
          return `SearXNG 实际搜索成功，返回 ${count} 条结果（本地零成本）。`;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("SearXNG 连接失败或超时，请检查地址与网络。", 502);
        }
      };
      const provider = searchProvider(db);
      if (provider === "tavily") return json({ message: await runTavily() });
      if (provider === "searxng") return json({ message: await runSearxng() });
      // hybrid：SearXNG 必测（零成本兜底）；Tavily 配了 Key 才实测，未配置不算失败。
      const searxngMessage = await runSearxng();
      const tavilyMessage = db.config().tavilyKey
        ? await runTavily()
        : "Tavily 未配置 Key，补位搜索将由 SearXNG 承担";
      return json({ message: `${searxngMessage}；${tavilyMessage}` });
    },
  },
];
