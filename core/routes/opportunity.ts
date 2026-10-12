// 机会引擎路由（第五轮 §1）：opportunity 统一记录的读口与生成触发口。
// 生成是外部 Agent 的主路径（consumerMode=external 时内置不自动跑）：
// UI 按钮 / curl POST /opportunities/generate?source=agent 触发，规则与 builtin tick 同一套。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { generateOpportunities, SIGNAL_LABELS, KIND_LABELS } from "../opportunity";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "opportunities/generate",
    handler: async ({ db, query, readBody }) => {
      let source = query.get("source") || "";
      if (!source) {
        const body = await readBody(4096).catch(() => ({}));
        source = String(body?.source || "");
      }
      const parsed = z.object({ source: z.enum(["auto", "agent"]).default("agent") }).safeParse({ source: source || "agent" });
      const run = generateOpportunities(db, { source: parsed.success ? parsed.data.source : "agent" });
      const note = run.created === 0 && run.merged === 0
        ? "四信号源扫完没有新机会（已有卡片覆盖或素材不足）——watch 池与词库有新料后再试。"
        : `新增 ${run.created} 张机会卡${run.merged ? `、合并 ${run.merged} 张既有卡信号` : ""}。`;
      return json({ ok: true, ...run, note });
    },
  },
  {
    // UI 只读口：?kind=app|site&signal=complaint|newtech|news|trend&source=auto|agent&limit（默认 100 上限 300）
    methods: ["GET"],
    pattern: "opportunities",
    handler: ({ db, query }) => {
      const kind = query.get("kind") || "";
      const signal = query.get("signal") || "";
      const source = query.get("source") || "";
      const limit = Math.min(300, Math.max(1, Number(query.get("limit")) || 100));
      const all = db.list<any>("opportunities").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const items = all.filter((o) =>
        (!kind || o.kind === kind) &&
        (!source || o.source === source) &&
        (!signal || (o.signals || []).includes(signal)),
      ).slice(0, limit);
      const counts = {
        total: all.length,
        byKind: { app: all.filter((o) => o.kind === "app").length, site: all.filter((o) => o.kind === "site").length },
        bySource: { auto: all.filter((o) => o.source === "auto").length, agent: all.filter((o) => o.source === "agent").length },
        bySignal: Object.fromEntries(Object.keys(SIGNAL_LABELS).map((s) => [s, all.filter((o) => (o.signals || []).includes(s as any)).length])),
      };
      return json({ items, total: all.length, limit, counts, labels: { signals: SIGNAL_LABELS, kinds: KIND_LABELS } });
    },
  },
];
