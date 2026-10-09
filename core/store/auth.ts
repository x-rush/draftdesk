// 连接令牌域：创建 + 鉴权。digest 索引让令牌定位 O(1)——旧实现每次鉴权全表扫描
// timingSafeEqual，26 个连接无感，百连接级起会成为每请求的固定开销。
import { randomUUID, randomBytes } from "node:crypto";
import { AppError } from "../errors";
import { hash, now } from "./helpers";
import type { KV } from "./kv";

export function createAuth(kv: KV) {
  // digest(sha256-hex) → 连接 id。启动时构建，createConnection 增量维护。
  // 撤销走路由侧的 kv.put（不经过本模块），所以命中后必须重读现值核对 revoked——
  // 索引只负责定位，不缓存任何可变字段。digest 是令牌的单向散列，Map 键比较
  // 不泄露令牌时序（与旧逐条 timingSafeEqual 的判定结果等价：digest 全局唯一）。
  const digestIndex = new Map<string, string>();
  for (const c of kv.list<{ id: string; digest: string }>("connections")) digestIndex.set(c.digest, c.id);

  return {
    indexSize: () => digestIndex.size,
    createConnection(name: string, scopes: string[] = ["submit"]) {
      const token = "dd_" + randomBytes(32).toString("hex");
      const c = {
        id: randomUUID(),
        name,
        digest: hash(token),
        scopes: scopes.filter((s) => ["submit", "read", "consume", "suggest"].includes(s)),
        createdAt: now(),
        lastUsedAt: null,
        revoked: false,
      };
      kv.put("connections", c.id, c);
      digestIndex.set(c.digest, c.id);
      return { id: c.id, name, scopes: c.scopes, token };
    },
    authenticate(token: string, scope: "submit" | "read" | "consume" | "suggest" = "submit", from?: string) {
      const id = digestIndex.get(hash(token));
      const c = id ? kv.get<any>("connections", id) : undefined;
      if (!c || c.revoked) throw new AppError("提交令牌无效或已撤销。", 401, "UNAUTHENTICATED");
      // 旧连接无 scopes 字段：视为仅提交（与历史行为一致）
      if (!(c.scopes || ["submit"]).includes(scope))
        throw new AppError(`令牌无 ${scope} 权限；请在工作台创建对应权限的连接令牌。`, 403, "SCOPE_MISMATCH");
      // 回写 lastUsedAt / lastUsedFrom，距上次记录 >5 分钟才写库（防每个 GET 都写一次）。
      const stamp = now();
      if (!c.lastUsedAt || Date.parse(stamp) - Date.parse(c.lastUsedAt) > 5 * 60000) {
        c.lastUsedAt = stamp;
        c.lastUsedFrom = from || scope;
        kv.put("connections", c.id, c);
      }
      return c;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
