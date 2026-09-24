import {activityPageSchema,trustedActivityRulesUrl} from "./activity-import";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { store, AppError, now } from "./store";
import {
  artifactSchema,
  configSchema,
  sourceSchema,
  planSchema,
  intakeSchema,
  type Artifact,
  type Conversation,
  type Evidence,
  type Job,
  type Plan,
  type Source,
} from "./schema";
import { skillCatalog, loadSkill } from "./skills";
import { requestModel } from "./model";
import { discussion, distill } from "./chat";
import { skillBundle } from "./skill-bundle";
import { collect, readAggregatedHotlist } from "./sources";
import { isAggregatePlatform } from "./hotlists";
import { qualityIssues } from "./quality";
import { validateIntake } from "./intake-validation";
import { type ResearchEvent, type MetricSnapshot, metricComparison } from "./history";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export function checkRequest(req: Request) {
  const host = (req.headers.get("host") || new URL(req.url).host).toLowerCase();
  const name = host.split(":")[0];
  if (
    ![
      "localhost",
      "127.0.0.1",
      ...(process.env.DRAFTDESK_ALLOWED_HOSTS || "").split(","),
    ].includes(name)
  )
    throw new AppError("此实例仅接受配置的工作台域名。", 403);
  const origin = req.headers.get("origin");
  if (origin && !["http://" + host, "https://" + host].includes(origin))
    throw new AppError("拒绝跨站请求。", 403);
  if (req.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError("拒绝跨站请求。", 403);
}
async function body(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new AppError("请求需使用 application/json。", 415);
  const reader = req.body?.getReader();
  if (!reader) throw new AppError("缺少请求正文");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 1000000) {
      await reader.cancel();
      throw new AppError("请求超过 1 MB。", 413);
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("JSON 格式无效。");
  }
}
export async function handle(req: Request, path: string[]) {
  try {
    checkRequest(req);
    const db = store(),
      route = path.join("/");
    if (req.headers.has("authorization") && !["intake","intake-check"].includes(route))
      throw new AppError("提交令牌只允许写入收件接口。", 403);
    if (req.method === "GET") {
      if (route === "health") return json({ ok: true, version: "2.0.0" });
      if (route === "public")
        return json({
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
        });
      if (route === "workspace") return json(db.snapshot(new URL(req.url).searchParams.has("page") ? new URL(req.url).searchParams : undefined));
      if (path[0] === "artifacts" && path[1]) {
        const artifact=db.get<Artifact>("artifacts",path[1]);
        if(!artifact || artifact.archived) throw new AppError("内容不存在或已归档",404);
        return json(artifact);
      }
      if (path[0] === "history") {
        const artifact = db.get<Artifact>("artifacts",path[1]);
        if (!artifact) throw new AppError("内容不存在",404);
        const events = db.list<ResearchEvent>("events").filter(e=>e.evidenceIds.some(id=>artifact.evidenceIds.includes(id)));
        const ids = new Set(events.flatMap(e=>e.evidenceIds));
        const all = db.list<MetricSnapshot>("metrics");
        const series = new Set(all.filter(m=>ids.has(m.evidenceId)).map(m=>m.seriesId));
        return json({events, metrics:all.filter(m=>series.has(m.seriesId)).sort((a,b)=>b.at.localeCompare(a.at)).map(m=>({...m,comparison:metricComparison(all,m)})),
          related:db.list<Artifact>("artifacts").filter(a=>a.id!==artifact.id && !a.archived && a.evidenceIds.some(id=>ids.has(id))).map(a=>({id:a.id,title:a.title}))});
      }
      if (route === "skills")
        return json(skillCatalog.map((s) => ({ ...s, ...loadSkill(s.id) })));
      if (route === "skill-bundle")
        return new Response(new Uint8Array(skillBundle()), {
          headers: {
            "content-type": "application/x-tar",
            "content-disposition":
              'attachment; filename="draftdesk-skills.tar"',
            "cache-control": "no-store",
          },
        });
      if (route === "schema") return json(z.toJSONSchema(intakeSchema));
      if (path[0] === "conversations") {
        const c = db.get<Conversation>("conversations", path[1]);
        if (!c) throw new AppError("讨论不存在", 404);
        return json(c);
      }
      if (path[0] === "evidence") {
        const e = db.get<Evidence>("evidence", path[1]);
        if (!e) throw new AppError("证据不存在", 404);
        return json(e);
      }
      if (path[0] === "job-context")
        return json({
          analysis: db.get("job-context", path[1]),
          draft: db.get("job-draft", path[1]),
          verification: db.get("job-verification", path[1]) || [],
        });
      if (route === "legacy") return json(db.list("legacy"));
      if (route === "export") {
        return json({
          schemaVersion: "2.0",
          exportedAt: now(),
          artifacts: db.list("artifacts"),
          evidence: db.list("evidence"),
          discovery: db.list("discovery"),
          events: db.list("events"),
          metrics: db.list("metrics"),
          plans: db.list("plans"),
          sources: db.list("sources"),
          jobs: db.list("jobs"),
          conversations: db.list("conversations"),
          legacy: db.list("legacy"),
        });
      }
      throw new AppError("接口不存在", 404);
    }
    if (req.method !== "POST") throw new AppError("方法不支持", 405);
    if(route === "intake-check") {
      db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /,""));
      const input=await body(req);
      if(input.probe === true) return json({ok:true,permission:"intake-only",note:"连接和令牌通过；未验证外部搜索工具，未入库。"});
      const report=validateIntake(input);
      return json(report,report.ok?200:400);
    }
    // Intake tokens are deliberately scoped: they cannot access any other mutation.
    if (route === "intake") {
      const c = db.authenticate(
        (req.headers.get("authorization") || "").replace(/^Bearer /, ""),
      );
      return json(db.intake(await body(req), c.id), 201);
    }
    if (req.headers.has("authorization"))
      throw new AppError("提交令牌只允许写入收件接口。", 403);
    const input = await body(req);
    if(route === "validate-intake") { const report=validateIntake(input); return json(report); }
    if(route === "source-check") {
      const {sourceId}=z.object({sourceId:z.string()}).strict().parse(input);
      const source=db.get<{type:string;query?:string;name:string}>("sources",sourceId);
      if(!source||source.type!=="aggregated"||!source.query||!isAggregatePlatform(source.query))throw new AppError("请选择聚合热榜来源。");
      const items=await readAggregatedHotlist(source.query,req.signal);
      return json({ok:true,count:items.length,updatedAt:items[0].acquisition?.observedAt,method:"aggregator",provider:"DailyHotApi",platform:source.name});
    }
    if(route === "source-preview") {
      const {planId}=z.object({planId:z.string()}).strict().parse(input);
      const plan=db.get<Plan>("plans",planId);
      if(!plan||plan.kind==="activities")throw new AppError("请选择内置研究策略。",404);
      const sourceIds=plan.sourceIds.filter(id=>{const s=db.get<Source>("sources",id);return s?.enabled&&s.type!=="web";}).slice(0,3);
      if(!sourceIds.length)throw new AppError("此策略没有可预览的免模型来源；可在数据源页启用 RSS 或热榜。",400);
      const id="preview-"+randomUUID();
      const sample={...plan,sourceIds,maxQueries:0,maxEvidence:Math.min(12,plan.maxEvidence)};
      const result=await collect(db,sample,AbortSignal.any([req.signal,AbortSignal.timeout(65000)]),()=>{},()=>{},id,"preview");
      return json({record:db.get("discovery",id),evidenceCount:result.evidence.length,warnings:result.warnings});
    }
    if (route === "config") {
      const cfg = configSchema.parse(input),
        old = db.get<any>("config", "main");
      const { clearApiKey, clearTavilyKey, ...next } = cfg;
      db.put("config", "main", {
        ...next,
        apiKey: clearApiKey ? undefined : cfg.apiKey?.trim() || old.apiKey,
        tavilyKey: clearTavilyKey
          ? undefined
          : cfg.tavilyKey?.trim() || old.tavilyKey,
      });
      return json(db.publicConfig());
    }
    if (route === "test-model") {
      const result = await requestModel(
        db,
        [{ role: "user", content: "只回复：连接成功" }],
        { signal: req.signal },
      );
      return json({ message: result.text, usage: result.usage });
    }
    if (route === "test-search") {
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
        return json({ message: `Tavily 实际搜索成功，返回 ${count} 条结果（消耗一次 basic 搜索额度）。` });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("Tavily 连接失败或超时，请检查网络；密钥不会回显。", 502);
      }
    }
    if (route === "sources") {
      const source = sourceSchema.parse(input);
      if (source.type === "rss" && !source.url)
        throw new AppError("RSS 需要来源地址");
      if(source.type === "hotlist" && !["https://top.baidu.com/board?tab=realtime","https://s.weibo.com/top/summary?cate=realtimehot","https://github.com/trending","https://hacker-news.firebaseio.com/v0/topstories.json"].includes(source.url||""))
        throw new AppError("官方热榜入口不在允许列表中");
      if(source.type === "aggregated" && !["bilibili","weibo","zhihu","douyin","kuaishou","toutiao","tieba","juejin"].includes(source.query||""))
        throw new AppError("聚合热榜仅支持已列出的平台路由");
      if(source.type === "aggregated" && (source.sourceType !== "trend" || source.url))
        throw new AppError("聚合热榜固定为趋势线索，不能标记为官方来源或自定义采集地址");
      db.put("sources", source.id, source);
      return json(source);
    }
    if (route === "plans") {
      const plan = planSchema.parse(input);
      if (plan.sourceIds.some((id) => !db.get("sources", id)))
        throw new AppError("策略引用未知来源");
      if (plan.scheduleEnabled && !db.config().apiKey)
        throw new AppError("请配置模型后再开启定时任务。");
      if (plan.kind === "activities" && plan.scheduleEnabled) throw new AppError("活动采集由登录浏览器主动执行，不能设置服务器定时任务。");
      const previous=db.get<Plan>("plans",plan.id);
      const saved={...plan,scheduleActivatedAt:plan.scheduleEnabled?(previous?.scheduleEnabled?previous.scheduleActivatedAt:now()):undefined};
      db.put("plans", plan.id, saved);
      return json(saved);
    }
    if(route === "activity-evidence") {
      const value=activityPageSchema.parse({schemaVersion:"draftdesk.activity-page.v1",...(input as object)});
      const evidence=db.addEvidence({title:value.title,url:value.url,excerpt:value.text,collectedAt:new Date().toISOString(),sourceType:trustedActivityRulesUrl(value.url)?"official":"other",region:"中国",language:"zh",contentLevel:"excerpt"},"manual-activity-rules");
      return json({evidenceId:evidence.id});
    }
    if (route === "jobs") {
      const value = z
        .object({
          planId: z.string(),
          evidenceIds: z.array(z.string()).max(60).default([]),
          receiptId: z.string().optional(),
          retry: z.boolean().default(false),
          targetKeywords: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
        })
        .parse(input);
      if (db.get<any>("plans", value.planId)?.kind === "activities" && !value.evidenceIds.length) throw new AppError("请先从创作活动页面导入官方规则；活动研究不再使用搜索。", 400);
      if (value.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("证据不存在");
      return json(db.enqueue(value.planId, value.evidenceIds, undefined, value.receiptId, value.retry, value.targetKeywords), 202);
    }
    if (route === "cancel") {
      const id = z.string().parse(input.id),
        j = db.get<Job>("jobs", id);
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
    }
    if (route === "artifacts")
      return json(
        db.updateArtifact(
          z
            .object({
              id: z.string(),
              revision: z.number().int(),
              draft: z.unknown().optional(),
              saved: z.boolean().optional(),
              creationStatus: z.enum(["inbox","planned","writing","published"]).optional(),
              archived: z.boolean().optional(),
              visibility: z.enum(["private", "public"]).optional(),
            })
            .parse(input),
        ),
      );
    if (route === "save-draft") {
      const draft = artifactSchema.parse(input.draft);
      if (draft.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("草稿引用不存在的证据");
      const jobId = z.string().max(100).parse(input.jobId);
      if (!db.get("jobs", jobId)) throw new AppError("整理任务不存在");
      const a = db.saveArtifact(draft, jobId, "review", [
        "讨论整理草稿，保存不代表事实已核实。",
        ...qualityIssues(draft, draft.evidenceIds.map((id) => db.get<Evidence>("evidence", id)!)),
      ]);
      return json(db.put("artifacts", a.id, { ...a, saved: true }));
    }
    if (route === "connections")
      return json(
        db.createConnection(z.string().min(1).max(80).parse(input.name)),
      );
    if (route === "revoke") {
      const id = z.string().parse(input.id),
        c = db.get<any>("connections", id);
      if (!c) throw new AppError("连接不存在", 404);
      db.put("connections", id, { ...c, revoked: true });
      return json({ ok: true });
    }
    if (route === "import") {
      return json(db.intake(input, "manual-import"));
    }
    if (route === "migrate-local") {
      const old = z
        .object({
          version: z.literal(1),
          topics: z.array(z.record(z.string(), z.unknown())).max(5000),
          platforms: z.array(z.record(z.string(), z.unknown())).max(1000),
        })
        .parse(input);
      db.transaction(() => {
        old.topics.forEach((t) => {
          if (typeof t.id !== "string" || typeof t.title !== "string")
            throw new AppError("旧选题格式无效");
          if (!db.get("legacy", t.id))
            db.put("legacy", t.id, {
              ...t,
              legacyTags: old.platforms,
              migratedAt: now(),
            });
        });
      });
      return json({ count: old.topics.length });
    }
    if (route === "distill") {
      const value = z
        .object({ id: z.string(), kind: z.enum(["topic", "idea"]) })
        .parse(input);
      return json(await distill(db, value.id, value.kind, req.signal));
    }
    if (route === "chat") {
      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      const stream = new ReadableStream({
        start(c) {
          let open = true;
          const emit = (event: unknown) => {
            if (open)
              try {
                c.enqueue(
                  new TextEncoder().encode(JSON.stringify(event) + "\n"),
                );
              } catch {
                open = false;
                controller.abort();
              }
          };
          void discussion(db, input, controller.signal, emit)
            .catch((e) =>
              emit({
                type: "error",
                message: e instanceof AppError ? e.message : "讨论请求失败。",
              }),
            )
            .finally(() => {
              if (open) {
                open = false;
                c.close();
              }
            });
        },
        cancel() {
          controller.abort();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson;charset=utf-8",
          "cache-control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    throw new AppError("接口不存在", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return json(
        {
          error:
            "数据格式不符合协议：" +
            e.issues
              .slice(0, 3)
              .map((i) => i.path.join(".") + " " + i.message)
              .join("；"),
        },
        400,
      );
    return json(
      {
        error:
          e instanceof AppError
            ? e.message
            : "服务处理失败，请查看本地运行状态后重试。",
      },
      e instanceof AppError ? e.status : 500,
    );
  }
}
