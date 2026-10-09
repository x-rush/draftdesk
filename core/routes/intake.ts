// 收件域：submit 令牌唯一可写面（intake / intake-check，含 probe 探测）+ 免登录的
// 校验/导入/旧数据迁移。收件令牌被刻意限权：除收件接口外不能触达任何变更接口。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import { validateIntake } from "../intake-validation";

export const routes: RouteDef[] = [
  {
    // 探测模式只验权限不入库；正式校验返回体检报告（400 = 未通过，仍是合法响应）
    methods: ["POST"],
    pattern: "intake-check",
    scope: "submit",
    handler: async ({ db, readBody }) => {
      const input = await readBody();
      if (input.probe === true) return json({ ok: true, permission: "intake-only", note: "连接和令牌通过；未验证外部搜索工具，未入库。" });
      const report = validateIntake(input);
      return json(report, report.ok ? 200 : 400);
    },
  },
  {
    methods: ["POST"],
    pattern: "intake",
    scope: "submit",
    handler: async ({ db, connection, readBody }) => json(db.intake(await readBody(), connection!.id), 201),
  },
  {
    methods: ["POST"],
    pattern: "validate-intake",
    handler: async ({ readBody }) => json(validateIntake(await readBody())),
  },
  {
    methods: ["POST"],
    pattern: "import",
    handler: async ({ db, readBody }) => json(db.intake(await readBody(), "manual-import")),
  },
  {
    methods: ["POST"],
    pattern: "migrate-local",
    handler: async ({ db, readBody }) => {
      const old = z
        .object({
          version: z.literal(1),
          topics: z.array(z.record(z.string(), z.unknown())).max(5000),
          platforms: z.array(z.record(z.string(), z.unknown())).max(1000),
        })
        .parse(await readBody());
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
    },
  },
];
