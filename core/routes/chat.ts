// 讨论与知识域（UI）：SSE 讨论、选题提炼、会话回看、技能目录/打包、收件协议 schema。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { discussion, distill } from "../chat";
import { skillCatalog, loadSkill } from "../skills";
import { skillBundle } from "../skill-bundle";
import { intakeSchema } from "../schema";
import type { Conversation } from "../schema";

export const routes: RouteDef[] = [
  {
    // NDJSON 流式讨论：断连透传 abort；emit 失败即收流
    methods: ["POST"],
    pattern: "chat",
    handler: async ({ db, req, readBody }) => {
      const input = await readBody();
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
    },
  },
  {
    methods: ["POST"],
    pattern: "distill",
    handler: async ({ db, req, readBody }) => {
      const value = z
        .object({ id: z.string(), kind: z.enum(["topic", "idea"]) })
        .parse(await readBody());
      return json(await distill(db, value.id, value.kind, req.signal));
    },
  },
  {
    methods: ["GET"],
    pattern: "conversations/:id",
    handler: ({ db, params }) => {
      const c = db.get<Conversation>("conversations", params.id);
      if (!c) throw new AppError("讨论不存在", 404);
      return json(c);
    },
  },
  {
    methods: ["GET"],
    pattern: "skills",
    handler: () => json(skillCatalog.map((s) => ({ ...s, ...loadSkill(s.id) }))),
  },
  {
    methods: ["GET"],
    pattern: "skill-bundle",
    handler: () => new Response(new Uint8Array(skillBundle()), {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition":
          'attachment; filename="draftdesk-skills.tar"',
        "cache-control": "no-store",
      },
    }),
  },
  {
    methods: ["GET"],
    pattern: "schema",
    handler: () => json(z.toJSONSchema(intakeSchema)),
  },
];
