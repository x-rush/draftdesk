// 配置域（UI）：主配置、人设、AI 策略、消费执行方/计划模式四开关、模型与搜索连通性自检。
// 注意 agent/consumerMode 读与 UI consumerMode 读的空值兜底不同（null vs "external"），分别保留。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { configSchema } from "../schema";
import { requestModel } from "../model";
import { searchProvider } from "../sources";

// persona 人设配置（决策个性化输入）；字段宽松校验，结构由 UI 与种子约定。
const personaInput = z.object({
  domains: z.object({ do: z.array(z.string().max(120)).max(30), dont: z.array(z.string().max(120)).max(30) }),
  goals: z.array(z.string().max(120)).max(12),
  platformRules: z.array(z.object({ contentType: z.string().max(60), scale: z.string().max(30), platforms: z.array(z.string().max(60)).max(8) })).max(20),
  imageOnly: z.boolean(),
  scoring: z.object({ threshold: z.number().min(0).max(5), dimensions: z.array(z.object({ name: z.string().max(60), weight: z.number().min(0).max(1) })).max(12) }),
  redLines: z.array(z.string().max(200)).max(30),
  style: z.object({ principles: z.array(z.string().max(120)).max(10), tone: z.string().max(200), forbidden: z.array(z.string().max(60)).max(20), notes: z.string().max(600) }),
}).strict();

export const routes: RouteDef[] = [
  { methods: ["GET"], pattern: "persona", handler: ({ db }) => json(db.get("config", "persona") || null) },
  { methods: ["GET"], pattern: "aiPolicy", handler: ({ db }) => json(db.get("config", "aiPolicy") || null) },
  { methods: ["GET"], pattern: "consumerMode", handler: ({ db }) => json(db.get("config", "consumerMode") || "external") },
  { methods: ["GET"], pattern: "planMode", handler: ({ db }) => json(db.get("config", "planMode") || "collect-and-analyze") },
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
      db.put("config", "persona", parsed);
      return json(parsed);
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
    methods: ["POST"],
    pattern: "planMode",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ planMode: z.enum(["collect", "collect-and-analyze"]) }).strict().parse(await readBody());
      db.put("config", "planMode", parsed.planMode);
      return json(parsed);
    },
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
