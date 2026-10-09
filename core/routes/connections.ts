// 接入令牌（UI 管理）：创建（含 U+FFFD 编码错误拒绝）与撤销。
// 令牌仅创建响应显示一次；列表/最近使用经 /workspace 快照露出。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "connections",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ name: z.string().min(1).max(80), scopes: z.array(z.enum(["submit", "read", "consume", "suggest"])).min(1).max(4).optional() }).parse(await readBody());
      if (/\uFFFD/.test(parsed.name))
        throw new AppError("连接名称包含无效字符（可能是编码错误），请以 UTF-8 重新发送。", 400);
      return json(db.createConnection(parsed.name, parsed.scopes));
    },
  },
  {
    methods: ["POST"],
    pattern: "revoke",
    handler: async ({ db, readBody }) => {
      const id = z.string().parse((await readBody()).id);
      const c = db.get("connections", id);
      if (!c) throw new AppError("连接不存在", 404);
      db.put("connections", id, { ...c, revoked: true });
      return json({ ok: true });
    },
  },
];
