// 站群立项（信息架构 v2-5）：推进 = 立项建站。新集合 site-projects（不动 config）。
// 幂等：同 term 只立一项，重复推进返回既有项。UI 无令牌路由（human）。
// 站点发现 GET（收尾批 §3②）：默认「可参考度」排序——命中我们高分词 > 非品牌 >
// 有明确功能（有命中词）> 其余，同级首见降序；?sort=first 切回首见降序。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";
import { clashTermsOf, seenHighScoreTerms } from "../site-launches";

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
    // 站点发现（海外定位批 6）：SERP 竞争度查询产出的独立站集合。
    // 支持 ?limit&offset&brand=true|false&q（host/命中词搜索）&sort=ref|first（默认可参考度）。
    methods: ["GET"],
    pattern: "site-discoveries",
    handler: ({ db, query }) => {
      const limit = Math.min(200, Math.max(1, Number(query.get("limit")) || 100));
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      const brand = query.get("brand") || "";
      const q = (query.get("q") || "").trim().toLowerCase().slice(0, 80);
      const sort = query.get("sort") === "first" ? "first" : "ref";
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
        ...params, 400, 0,
      );
      let items = rows.map((r: any) => JSON.parse(String(r.body)));
      if (sort === "ref") {
        // 可参考度：撞词(命中高分词)×4 > 非品牌×2 > 有命中词×1，同级首见降序；
        // portfolio 降权折叠（排序垫底，字段仍返回供 UI 折叠展示）。
        const highScores = seenHighScoreTerms(db);
        const score = (d: any) => {
          const clash = clashTermsOf(d.terms || [], highScores).length > 0 ? 4 : 0;
          const clean = d.brand ? 0 : 2;
          const functional = (d.terms || []).length > 0 ? 1 : 0;
          const penalty = d.portfolio ? -3 : 0;
          return clash + clean + functional + penalty;
        };
        items = items.map((d) => ({ ...d, refScore: score(d), clashTerms: clashTermsOf(d.terms || [], highScores) }))
          .sort((a, b) => b.refScore - a.refScore || String(b.firstFoundAt).localeCompare(String(a.firstFoundAt)));
      }
      return json({ items: items.slice(offset, offset + limit), total, limit, offset, sort });
    },
  },
];
