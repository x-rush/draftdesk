// 决策层：quality=证据可信度由 AI 判；decision=要不要写由人拍板。两层永不互相推导。
// setDecision 的 rejected/published 联动消费经参数注入（consumption 模块），不反向依赖。
import { now } from "./helpers";
import { AppError } from "../errors";
import { urlKey } from "../hotspots";
import type { KV } from "./kv";

export function createDecisions(kv: KV, consumeIdentities: Consumption["consumeIdentities"]) {
  function decisionTarget(id: string): { collection: "artifacts" | "outlines" | "decisions"; row: any } {
    for (const collection of ["artifacts", "outlines", "decisions"] as const) {
      const row = kv.get<any>(collection, id);
      if (row) return { collection, row };
    }
    throw new AppError("决策对象不存在", 404);
  }
  return {
    decisionTarget,
    // 拍板。联动规则（P3）：rejected/published 自动消费该产物证据对应的热榜；
    // approved/drafting/deferred 不消费（避免把待办藏起来）。手动题（decisions）无热榜映射，不消费。
    setDecision(id: string, input: { decision: string; platforms?: string[]; rejectReason?: string; publishedRef?: string; decidedBy?: "human" | "agent" }) {
      const { collection, row } = decisionTarget(id);
      if (collection === "artifacts" && row.archived) throw new AppError("已归档产物不可再拍板。");
      const next: any = {
        ...row,
        decision: input.decision,
        decidedBy: input.decidedBy ?? "human",
        decidedAt: now(),
        ...(input.platforms ? { platforms: input.platforms } : {}),
        ...(input.rejectReason !== undefined ? { rejectReason: input.rejectReason } : {}),
        ...(input.publishedRef !== undefined ? { publishedRef: input.publishedRef } : {}),
      };
      if (collection === "artifacts") { next.revision = (row.revision ?? 0) + 1; next.updatedAt = now(); }
      kv.put(collection, id, next);
      // 联动消费：rejected/published 时消费对应条目（P0-2 返工：按形态分支）。
      // artifacts 的 evidenceIds 是 ev-xxx 证据 ID（去 evidence 集合拿 url）；
      // outlines 的 evidenceRefs 直接就是热点 url（urlKey 归一化后即消费身份）。
      if (input.decision === "rejected" || input.decision === "published") {
        const idset = new Set<string>();
        for (const ref of row.evidenceIds || row.evidenceRefs || []) {
          if (/^https?:\/\//i.test(ref)) {
            try { idset.add(urlKey(ref)); } catch { /* 非 https 跳过 */ }
          } else {
            const e = kv.get<any>("evidence", ref);
            if (e?.url) { try { idset.add(urlKey(e.url)); } catch { /* 跳过 */ } }
          }
        }
        const ids = [...idset];
        let consumedCount = 0;
        if (ids.length) {
          if (input.decision === "published") {
            const r = consumeIdentities("hotspots", ids, "processed-into-artifact", "decision", next.publishedRef, false);
            consumedCount = r.toConsume;
          } else {
            const map: Record<string, string> = { "no-ai-signal": "no-ai-signal", "off-domain": "off-domain", "已写过": "processed-into-artifact", "写不透": "no-ai-signal", "不感兴趣": "off-domain", "其他": "no-ai-signal" };
            const r = consumeIdentities("hotspots", ids, map[next.rejectReason || "其他"] || "no-ai-signal", "decision", undefined, false);
            consumedCount = r.toConsume;
          }
        }
        next.consumedCount = consumedCount;
      }
      return next;
    },
    // 建议（suggestions）多源并存、互不覆盖：内置 AI 与外部 Agent 都只能写这里，不能直接改 decision。
    addSuggestion(id: string, suggestion: { by: string; verdict: string; score?: number; platforms?: string[]; reason?: string }) {
      const { collection, row } = decisionTarget(id);
      if (row.archived) throw new AppError("已归档产物不再接受建议。");
      const suggestions = [...(row.suggestions || []), { ...suggestion, at: now() }];
      kv.put(collection, id, { ...row, suggestions });
      return kv.get<any>(collection, id);
    },
    // 决策队列：产物 + 大纲 + 手动题合并（决策挂在原条目上；手动题是唯一的独立记录形态）。
    decisionsQueue(status?: string) {
      const rows: any[] = [];
      for (const a of kv.list<any>("artifacts")) {
        if (a.archived || (a.kind as string) === "person") continue;
        rows.push({ sourceType: "artifact", id: a.id, kind: a.kind, title: a.title, summary: a.summary, quality: a.quality || "review", evidenceQuality: a.quality || "review",
          decision: a.decision || "pending", platforms: a.platforms, suggestions: a.suggestions, rejectReason: a.rejectReason,
          publishedRef: a.publishedRef, draftBody: a.draftBody, createdAt: a.createdAt, evidenceCount: (a.evidenceIds || []).length });
      }
      for (const o of kv.list<any>("outlines"))
        rows.push({ sourceType: "outline", id: o.id, kind: o.contentType, title: o.title, summary: (o.keyPoints || []).join("；"), clusterId: o.clusterId,
          decision: o.decision, platforms: [o.platform], suggestions: o.suggestions, rejectReason: o.rejectReason, publishedRef: o.publishedRef, producedBy: o.producedBy, draftBody: o.draftBody, createdAt: o.createdAt });
      for (const d of kv.list<any>("decisions"))
        rows.push({ sourceType: "manual", id: d.id, kind: "manual", title: d.title, summary: d.notes, decision: d.decision,
          platforms: d.platforms, suggestions: d.suggestions, rejectReason: d.rejectReason, publishedRef: d.publishedRef, producedBy: d.producedBy || "human", draftBody: d.draftBody, createdAt: d.createdAt });
      return rows.filter((r) => !status || r.decision === status)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    decisionsStats() {
      const rows = this.decisionsQueue();
      const byDecision: Record<string, number> = {}, byRejectReason: Record<string, number> = {}, byPlatform: Record<string, number> = {};
      for (const r of rows) {
        byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
        if (r.decision === "rejected" && r.rejectReason) byRejectReason[r.rejectReason] = (byRejectReason[r.rejectReason] || 0) + 1;
        for (const p of r.platforms || []) byPlatform[p] = (byPlatform[p] || 0) + 1;
      }
      const decided = rows.filter((r) => r.decision !== "pending").length;
      const positive = rows.filter((r) => ["approved", "drafting", "published"].includes(r.decision)).length;
      return { total: rows.length, byDecision, byRejectReason, byPlatform, passRate: decided ? +(positive / decided).toFixed(3) : null };
    },
  };
}

type Consumption = { consumeIdentities: (target: "hotspots" | "evidence", identities: string[], reason: string, consumedBy: string, producedRef?: string, dryRun?: boolean) => { ok: boolean; toConsume: number; alreadyConsumed: number } };

export type Decisions = ReturnType<typeof createDecisions>;
