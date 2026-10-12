// 新站发现路由（第五轮 §2，批 2a）：site-launches 的 UI 只读口 + 手动刷新触发口。
// 支持读口 ?motive=&source=&clash=true&q=&limit（默认 100 上限 300），首见降序；
// 响应附计数（六类/来源/撞词）供 tab 角标。刷新写 manual 请求，worker tick 越日闸重跑。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { now } from "../store";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "site-launches/refresh",
    handler: ({ db }) => {
      const done = db.get<any>("meta", "site-launches-done:" + new Date().toISOString().slice(0, 10));
      db.put("meta", "site-launches-manual", { at: now() });
      return json({ ok: true, note: done ? "刷新请求已写入，worker tick 将越闸重跑（补抓新增/补判定/重刷撞词标注，约 1-2 分钟）。" : "抓取尚未跑过，worker tick 将立即执行首跑。" });
    },
  },
  {
    methods: ["GET"],
    pattern: "site-launches",
    handler: ({ db, query }) => {
      const motive = query.get("motive") || "";
      const source = query.get("source") || "";
      const clash = query.get("clash") === "true";
      const q = (query.get("q") || "").trim().toLowerCase().slice(0, 80);
      const limit = Math.min(300, Math.max(1, Number(query.get("limit")) || 100));
      const all = db.list<any>("site-launches").sort((a, b) => String(b.firstFoundAt).localeCompare(String(a.firstFoundAt)));
      const items = all.filter((l) =>
        (!motive || (l.motive || "unclear") === motive) &&
        (!source || l.source === source) &&
        (!clash || (l.clashTerms || []).length > 0) &&
        (!q || [l.host, l.title, l.titleZh, ...(l.keywords || [])].join(" ").toLowerCase().includes(q)),
      ).slice(0, limit);
      const counts = {
        total: all.length,
        judged: all.filter((l) => l.titleZh).length,
        clash: all.filter((l) => (l.clashTerms || []).length > 0).length,
        crossLinked: all.filter((l) => l.crossLinked).length,
        bySource: { showhn: all.filter((l) => l.source === "showhn").length, producthunt: all.filter((l) => l.source === "producthunt").length },
        byMotive: Object.fromEntries(["keyword", "pain", "others", "hobby", "business", "unclear"].map((m) => [m, all.filter((l) => (l.motive || "unclear") === m).length])),
      };
      return json({ items, total: all.length, limit, counts, last: db.get("meta", "site-launches-last") || null });
    },
  },
];
