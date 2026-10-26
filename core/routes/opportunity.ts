// 机会引擎路由（第五轮 §1）：opportunity 统一记录的读口与组卡转卡口。
// R10.25-4②：POST /opportunities/generate 批量触发口已删——注释声称外部 Agent 触发
// 但从未接线（外部写卡走 PUT /agent/opportunities 已闭环）；UI「按四信号源生成」按钮同批移除。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { SIGNAL_LABELS, KIND_LABELS } from "../opportunity";
import { FORM_LABELS } from "../platforms";

export const routes: RouteDef[] = [
  {
    // R10.7 P0-2：单组转机会卡（UI 组卡按钮；drafts 与 generateFromGroups 同源）
    // R10.25：内容线草案不再出卡（内容线选题走 outlines），只出应用线
    methods: ["POST"],
    pattern: "opportunities/from-group",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ jobId: z.string().min(1).max(64), groupId: z.string().min(1).max(40) }).strict().parse(await readBody());
      const record = db.get<any>("candidate-groups", "tg-" + parsed.jobId);
      const group = record && (record.groups || []).find((g: any) => g.id === parsed.groupId);
      if (!group) throw new AppError("组不存在（批次未初筛或组已恢复）。", 404);
      const { groupOpportunityDrafts } = await import("../opportunity");
      // R10.25 口径：groupOpportunityDrafts 只出 appGap 应用卡（内容线走大纲链路）
      const drafts = groupOpportunityDrafts(group);
      if (!drafts.length) throw new AppError("该组无 appGap 应用缺口，无可出的卡；内容线选题请走大纲链路（生成大纲）。", 400);
      const { upsertOpportunityDrafts } = await import("../opportunity");
      const r = upsertOpportunityDrafts(db, drafts, "agent");
      return json({ ok: true, ...r, note: `新增 ${r.created} 张${r.merged ? `、合并 ${r.merged} 张信号` : ""}（应用 ${drafts.length} 条草案；内容线走大纲链路）。` });
    },
  },
  {
    // UI 只读口：?kind=app|site&form=六值&signal=…&source=…&limit（默认 100 上限 300）
    // R10.25：content-line 虚拟形态已删（内容线选题走 outlines，存量组卡已归档）
    methods: ["GET"],
    pattern: "opportunities",
    handler: ({ db, query }) => {
      const kind = query.get("kind") || "";
      const signal = query.get("signal") || "";
      const source = query.get("source") || "";
      const form = query.get("form") || "";
      const limit = Math.min(300, Math.max(1, Number(query.get("limit")) || 100));
      const all = db.list<any>("opportunities").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const items = all.filter((o) =>
        (!kind || o.kind === kind) &&
        (!source || o.source === source) &&
        (!form || o.form === form) &&
        (!signal || (o.signals || []).includes(signal)),
      ).slice(0, limit);
      const counts = {
        total: all.length,
        byKind: { app: all.filter((o) => o.kind === "app").length, site: all.filter((o) => o.kind === "site").length },
        bySource: { auto: all.filter((o) => o.source === "auto").length, agent: all.filter((o) => o.source === "agent").length },
        bySignal: Object.fromEntries(Object.keys(SIGNAL_LABELS).map((s) => [s, all.filter((o) => (o.signals || []).includes(s as any)).length])),
        byForm: Object.fromEntries(Object.keys(FORM_LABELS).map((f) => [f, all.filter((o) => o.form === f).length])),
      };
      return json({ items, total: all.length, limit, counts, labels: { signals: SIGNAL_LABELS, kinds: KIND_LABELS, forms: FORM_LABELS } });
    },
  },
];
