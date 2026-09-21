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
} from "./schema";
import { skillCatalog, loadSkill } from "./skills";
import { requestModel } from "./model";
import { discussion, distill } from "./chat";
import { skillBundle } from "./skill-bundle";
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
    if (req.headers.has("authorization") && route !== "intake")
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
      if (route === "workspace") return json(db.snapshot());
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
        });
      if (route === "legacy") return json(db.list("legacy"));
      if (route === "export") {
        return json({
          schemaVersion: "2.0",
          exportedAt: now(),
          artifacts: db.list("artifacts"),
          evidence: db.list("evidence"),
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
    if (route === "sources") {
      const source = sourceSchema.parse(input);
      if (source.type === "rss" && !source.url)
        throw new AppError("RSS 需要来源地址");
      db.put("sources", source.id, source);
      return json(source);
    }
    if (route === "plans") {
      const plan = planSchema.parse(input);
      if (plan.sourceIds.some((id) => !db.get("sources", id)))
        throw new AppError("策略引用未知来源");
      if (plan.scheduleEnabled && !db.config().apiKey)
        throw new AppError("请配置模型后再开启定时任务。");
      db.put("plans", plan.id, plan);
      return json(plan);
    }
    if (route === "jobs") {
      const value = z
        .object({
          planId: z.string(),
          evidenceIds: z.array(z.string()).max(60).default([]),
        })
        .parse(input);
      if (value.evidenceIds.some((id) => !db.get("evidence", id)))
        throw new AppError("证据不存在");
      return json(db.enqueue(value.planId, value.evidenceIds), 202);
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
