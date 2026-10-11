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
  {
    // 站点发现（海外定位批 6）：DDG 竞争度查询顺便产出的独立站集合。
    // 支持 ?limit&offset&brand=true|false&q（host/命中词搜索），首见降序。
    methods: ["GET"],
    pattern: "site-discoveries",
    handler: ({ db, query }) => {
      const limit = Math.min(200, Math.max(1, Number(query.get("limit")) || 100));
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      const brand = query.get("brand") || "";
      const q = (query.get("q") || "").trim().toLowerCase().slice(0, 80);
      const where = [
        "collection='site-discoveries'",
        "(?='' OR json_extract(body,'$.brand')=?)",
        "(?='' OR json_extract(body,'$.id') LIKE '%'||?||'%' OR json_extract(body,'$.terms') LIKE '%'||?||'%')",
      ].join(" AND ");
      const brandVal = brand === "" ? "" : brand === "true" ? "true" : "false";
      // 占位符 5 个（brand 2 + like 3）：q 要同时喂 id 与 terms 两处 LIKE。
      // 此前漏绑第 5 个导致 node:sqlite 错位绑定（LIMIT 值落进 LIKE 参数）→ 列表恒空。
      const params = [brandVal, brandVal, q, q, q];
      const total = (db.kv.sqlRows(`SELECT COUNT(*) c FROM documents WHERE ${where}`, ...params)[0] as { c: number }).c;
      const rows = db.kv.sqlRows(
        `SELECT body FROM documents WHERE ${where} ORDER BY json_extract(body,'$.firstFoundAt') DESC LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      );
      return json({ items: rows.map((r: any) => JSON.parse(String(r.body))), total, limit, offset });
    },
  },
];
