// HTTP 唯一入口：解析 path → 查路由表 → 按 scope 保序执行（鉴权/participants/方法守卫）→ 统一错误处理。
// 保序矩阵与旧 if 链逐条对齐（见重构清单）：改这里 = 改对外行为，务必先跑测试与实测。
import { z } from "zod";
import { store } from "../store";
import { AppError } from "../errors";
import { json, checkRequest, body, enforceParticipants } from "./middleware";
import { RouteRegistry, type HttpMethod, type RouteContext, type RouteDef } from "./router";
import { routes as agentWriteRoutes } from "../routes/agent-write";
import { routes as agentRoutes } from "../routes/agent";
import { routes as consumeRoutes } from "../routes/consume";
import { routes as decisionsRoutes } from "../routes/decisions";
import { routes as clustersRoutes } from "../routes/clusters";
import { routes as connectionsRoutes } from "../routes/connections";
import { routes as activityRoutes } from "../routes/activity";
import { routes as sourcesRoutes } from "../routes/sources";
import { routes as intakeRoutes } from "../routes/intake";
import { routes as configRoutes } from "../routes/config";
import { routes as jobsRoutes } from "../routes/jobs";
import { routes as artifactsRoutes } from "../routes/artifacts";
import { routes as chatRoutes } from "../routes/chat";
import { routes as miscRoutes } from "../routes/misc";
import { routes as siteProjectRoutes } from "../routes/site-projects";
import { routes as hotspotCategoryRoutes } from "../routes/hotspot-categories";
import { routes as seoTermRoutes } from "../routes/seo-terms";
import { routes as activityCategoryRoutes } from "../routes/activity-categories";

export { checkRequest } from "./middleware";

const registry = new RouteRegistry();
// 顺序即优先级：agent-write 必须先于 agent——POST agent/clusters 等方法不符的
// fallback 要落进 suggest 定义（先鉴权后 405），而不是 read 定义（先 405）；
// consume 必须先于 agent——agent 的 :rest... 兜底会 pattern 截胡 agent/consume/status。
for (const def of [...agentWriteRoutes, ...consumeRoutes, ...hotspotCategoryRoutes, ...seoTermRoutes, ...activityCategoryRoutes, ...agentRoutes, ...decisionsRoutes, ...clustersRoutes, ...connectionsRoutes, ...activityRoutes, ...sourcesRoutes, ...intakeRoutes, ...configRoutes, ...jobsRoutes, ...artifactsRoutes, ...chatRoutes, ...miscRoutes, ...siteProjectRoutes])
  registry.register(def as RouteDef);

const TOKEN_MSG = "提交令牌只允许写入收件接口。";
const NOT_FOUND_MSG = "接口不存在";
const METHOD_MSG = "方法不支持";

export async function handle(req: Request, path: string[]) {
  try {
    checkRequest(req);
    const db = store();
    const route = path.join("/");
    const query = new URL(req.url).searchParams;
    const method = req.method as HttpMethod;
    const hasToken = req.headers.has("authorization");
    const readBody = (maxBytes?: number) => body(req, maxBytes);
    const ctx: RouteContext = { db, req, route, params: {}, query, readBody };

    const matched = registry.matchPath(method, path);
    if (!matched) {
      // 全局兜底 = 旧链尾语义：GET 带令牌 403；非 POST 405；POST 先解析 body（坏 JSON 400 先于 404）
      if (method === "GET") throw new AppError(hasToken ? TOKEN_MSG : NOT_FOUND_MSG, hasToken ? 403 : 404);
      if (method !== "POST") throw new AppError(METHOD_MSG, 405);
      if (hasToken) throw new AppError(TOKEN_MSG, 403);
      await readBody();
      throw new AppError(NOT_FOUND_MSG, 404);
    }
    const { def, params } = matched;
    ctx.params = params;
    if (def.preAuth405) throw new AppError(METHOD_MSG, 405);
    const scope = def.scope ?? "none";

    if (scope === "none" || scope === "submit") {
      if (scope === "none" && hasToken) throw new AppError(TOKEN_MSG, 403);
      if (!def.methods.includes(method)) {
        // UI/收件方法不符 = 旧长尾语义：POST 先解析 body 再 404，GET 404，其余 405
        if (method === "POST") { await readBody(); throw new AppError(NOT_FOUND_MSG, 404); }
        throw new AppError(method === "GET" ? NOT_FOUND_MSG : METHOD_MSG, method === "GET" ? 404 : 405);
      }
      if (scope === "submit") ctx.connection = db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), "submit");
      return await def.handler(ctx);
    }

    // read / consume / suggest：方法守卫与鉴权的先后按命名空间保序
    if (def.methodGuardFirst && !def.methods.includes(method)) throw new AppError(METHOD_MSG, 405);
    const connection = db.authenticate((req.headers.get("authorization") || "").replace(/^Bearer /, ""), scope, route);
    if (def.participants) enforceParticipants(db, connection);
    if (!def.methodGuardFirst && !def.methods.includes(method)) throw new AppError(METHOD_MSG, 405);
    return await def.handler({ ...ctx, connection });
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
          code: "INVALID_PAYLOAD",
        },
        400,
      );
    return json(
      {
        error:
          e instanceof AppError
            ? e.message
            // 本机自托管应用：直接透出异常类型与消息，便于排障，不再只报通用失败。
            : `服务处理失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        code: e instanceof AppError ? e.code || undefined : e instanceof Error && e.name === "SyntaxError" ? "INVALID_PAYLOAD" : undefined,
      },
      e instanceof AppError ? e.status : 500,
    );
  }
}
