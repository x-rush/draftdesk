// 应用内会话鉴权（R10.39 上线前置）：部署到公网 HTTPS 时的 UI 访问门。
// 设计：DRAFTDESK_ACCESS_CODE 设置时启用——POST /api/v1/session 用访问码换
// HttpOnly 会话 cookie（30 天），UI 命名空间 API 与页面需要有效会话；
// agent/intake 等带 scope 的路由凭 Bearer 令牌鉴权，不经此层。
// 不设码（本机默认）= 行为完全不变。PWA 场景 cookie 自动携带，体验无缝
//（BasicAuth 在 standalone 下反复弹窗，弃）。
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";

const COOKIE = "dd_session";
const SESSION_DAYS = 30;

export function accessCodeEnabled(): boolean {
  return !!process.env.DRAFTDESK_ACCESS_CODE;
}

/** 常数时间比较访问码（防时序侧信道） */
function codeMatches(given: string): boolean {
  const real = String(process.env.DRAFTDESK_ACCESS_CODE || "");
  const a = Buffer.from(given);
  const b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 会话校验：cookie → sessions 集合 → 未过期即有效；过期顺带惰性清理 */
export function validSession(kv: { get<T>(c: string, id: string): T | undefined; del(c: string, id: string): void }, req: Request): boolean {
  if (!accessCodeEnabled()) return true;
  const cookie = req.headers.get("cookie") || "";
  const token = cookie.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1];
  if (!token) return false;
  const session = kv.get<any>("sessions", token);
  if (!session) return false;
  if (Date.parse(session.expiresAt || "") < Date.now()) {
    kv.del("sessions", token);
    return false;
  }
  return true;
}

const secureOf = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export const routes: RouteDef[] = [
  {
    // 探测：前端与登录页联动的状态口（无 cookie 也可访问，只报形态不泄露数据）
    methods: ["GET"],
    pattern: "session",
    handler: ({ db, req }) => {
      const enabled = accessCodeEnabled();
      return json({ enabled, authenticated: enabled ? validSession(db.kv, req) : true });
    },
  },
  {
    methods: ["POST"],
    pattern: "session",
    handler: async ({ db, req, readBody }) => {
      if (!accessCodeEnabled()) throw new AppError("未设置 DRAFTDESK_ACCESS_CODE，会话鉴权未启用。", 400, "SESSION_DISABLED");
      const body = (await readBody(64 * 1024)) as { code?: unknown };
      const code = typeof body?.code === "string" ? body.code : "";
      if (!code || !codeMatches(code)) throw new AppError("访问码不正确。", 401, "SESSION_DENIED");
      const token = randomBytes(24).toString("hex");
      db.kv.put("sessions", token, {
        createdAt: now(),
        expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
        ua: (req.headers.get("user-agent") || "").slice(0, 120),
      });
      // 顺带清理过期会话（登录时一次，防 sessions 集合只进不出）——
      // sessions 不在生成列索引清单，小集合用 json_extract 内联即可
      for (const r of db.kv.sqlRows(`SELECT id FROM documents WHERE collection='sessions' AND json_extract(body,'$.expiresAt') < ?`, new Date().toISOString()) as Array<{ id: string }>)
        db.kv.del("sessions", r.id);
      return new Response(JSON.stringify({ ok: true, authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureOf(req) ? "; Secure" : ""}` },
      });
    },
  },
  {
    methods: ["DELETE"],
    pattern: "session",
    handler: ({ db, req }) => {
      const cookie = req.headers.get("cookie") || "";
      const token = cookie.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1];
      if (token) db.kv.del("sessions", token);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureOf(req) ? "; Secure" : ""}` },
      });
    },
  },
];
