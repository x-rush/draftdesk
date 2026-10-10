// 站群立项（信息架构 v2-5）：推进 = 立项建站。新集合 site-projects（不动 config）。
// 幂等：同 term 只立一项，重复推进返回既有项。UI 无令牌路由（human）。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "site-projects",
    handler: async ({ db, readBody }) => {
      const { term } = z.object({ term: z.string().trim().min(1).max(80) }).strict().parse(await readBody());
      const id = "site-" + term.toLowerCase().replace(/\s+/g, "-").slice(0, 60);
      const existing = db.get<any>("site-projects", id);
      if (existing) return json({ ...existing, existed: true });
      const project = { id, term, status: "pending" as const, createdAt: now(), producedBy: "human" };
      db.put("site-projects", id, project);
      return json(project, 201);
    },
  },
  {
    methods: ["GET"],
    pattern: "site-projects",
    handler: ({ db }) => json({ items: db.list("site-projects") }),
  },
];
