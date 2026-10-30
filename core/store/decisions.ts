// 决策层：quality=证据可信度由 AI 判；decision=要不要写由人拍板。两层永不互相推导。
// setDecision 的 rejected/published 联动消费经参数注入（consumption 模块），不反向依赖。
import { now } from "./helpers";
import { AppError } from "../errors";
import { urlKey } from "../hotspots";
import { normalizePlatform } from "../platforms";
import type { KV } from "./kv";

export function createDecisions(kv: KV, consumeIdentities: Consumption["consumeIdentities"], unconsumeIdentities: Consumption["unconsumeIdentities"]) {
  // 关联热点身份键：artifacts 的 evidenceIds 是 ev-xxx（查证据拿 url）；outlines 的 evidenceRefs 直接是 url。
  function linkedHotspotIds(row: any): string[] {
    const idset = new Set<string>();
    for (const ref of row.evidenceIds || row.evidenceRefs || []) {
      if (/^https?:\/\//i.test(ref)) {
        try { idset.add(urlKey(ref)); } catch { /* 非 https 跳过 */ }
      } else {
        const e = kv.get<any>("evidence", ref);
        if (e?.url) { try { idset.add(urlKey(e.url)); } catch { /* 跳过 */ } }
      }
    }
    return [...idset];
  }
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
      // rejected/deferred→pending 翻转（信息架构 v2-C + R10.37 C①：deferred 对齐徽章 cycle）：
      // 拍错可反悔。rejected 翻回自动撤销联动消费（unconsume 30 天窗口；已撤销过/身份不存在
      // 的条目静默跳过并计入 notFound）；deferred 从未消费，直接翻。再次 rejected 时消费幂等重放。
      if (input.decision === "pending") {
        if (row.decision !== "rejected" && row.decision !== "deferred") throw new AppError("只有已否决或已暂缓的条目可以翻回待定。", 400, "INVALID_PAYLOAD");
        let unconsumedCount = 0, unconsumeExpired = 0, unconsumeNotFound = 0;
        if (row.decision === "rejected" && (collection === "outlines" || collection === "decisions" || collection === "artifacts")) {
          const ids = linkedHotspotIds(row);
          if (ids.length) {
            const r = unconsumeIdentities("hotspots", ids, false);
            unconsumedCount = r.revived;
            unconsumeExpired = r.expired;
            unconsumeNotFound = r.notFound ?? 0;
          }
        }
        // R10.35 裁决：翻回 pending 同时清 perPlatformDecision——不清会让按平台徽章停在
        // rejected 而行级已 pending（或反向），合并行（一选题多平台）上两套状态互相打架。
        const reverted: any = { ...row, decision: "pending", decidedBy: input.decidedBy ?? "human", decidedAt: now(), rejectReason: undefined, perPlatformDecision: undefined, unconsumedCount, unconsumeExpired, unconsumeNotFound };
        kv.put(collection, id, reverted);
        return reverted;
      }
      const next: any = {
        ...row,
        decision: input.decision,
        decidedBy: input.decidedBy ?? "human",
        decidedAt: now(),
        ...(input.platforms ? { platforms: input.platforms.map((p) => normalizePlatform(p) ?? p) } : {}),
        ...(input.rejectReason !== undefined ? { rejectReason: input.rejectReason } : {}),
        ...(input.publishedRef !== undefined ? { publishedRef: input.publishedRef } : {}),
      };
      if (collection === "artifacts") { next.revision = (row.revision ?? 0) + 1; next.updatedAt = now(); }
      // R10.37 A-1（同根修 P2-7）：大纲行级拍板同步写 perPlatformDecision——行级 decision 与
      // 平台徽章永远一致（旧语义只改 decision，主行 approved 后徽章仍全 pending 呈矛盾态）。
      // 平台键全集 = platforms ∪ [platform] ∪ per 既有键；全部置为本次拍板值。
      if (collection === "outlines") {
        const base = (next.platforms as string[] | undefined) || row.platforms || [];
        const keys = [...new Set([...base, row.platform, ...Object.keys(row.perPlatformDecision || {})].filter(Boolean))] as string[];
        if (keys.length) next.perPlatformDecision = Object.fromEntries(keys.map((k) => [k, input.decision]));
      }
      kv.put(collection, id, next);
      // 联动消费：rejected/published 时消费对应条目（P0-2 返工：按形态分支）。
      // artifacts 的 evidenceIds 是 ev-xxx 证据 ID（去 evidence 集合拿 url）；
      // outlines 的 evidenceRefs 直接就是热点 url（urlKey 归一化后即消费身份）。
      if (input.decision === "rejected" || input.decision === "published") {
        const ids = linkedHotspotIds(row);
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
    decisionsQueue(status?: string, opts?: { includeAll?: boolean }) {
      // R10.38 下推：默认窗口先在 SQL 层过滤（decision/createdAt 生成列索引），只 parse 命中行；
      // JS 侧窗口链保留作第二道带（语义兜底，双滤零成本）。includeAll 走原全量。
      const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
      const fetchRows = (collection: string) => opts?.includeAll
        ? kv.list<any>(collection)
        : kv.selectWhere<any>(collection, `"decision" IN ('approved','drafting','deferred') OR "createdAt" >= ? OR "createdAt" IS NULL`, cutoff7d).map((r) => r.body);
      const rows: any[] = [];
      for (const a of fetchRows("artifacts")) {
        if (a.archived || (a.kind as string) === "person") continue;
        rows.push({ sourceType: "artifact", id: a.id, kind: a.kind, title: a.title, summary: a.summary, quality: a.quality || "review", evidenceQuality: a.quality || "review",
          decision: a.decision || "pending", platforms: a.platforms, suggestions: a.suggestions, rejectReason: a.rejectReason,
          publishedRef: a.publishedRef, draftBody: a.draftBody, createdAt: a.createdAt, evidenceCount: (a.evidenceIds || []).length });
      }
      for (const o of fetchRows("outlines"))
        rows.push({ sourceType: "outline", id: o.id, kind: o.contentType, title: o.title, summary: (o.keyPoints || []).join("；"), clusterId: o.clusterId,
          decision: o.decision, platform: o.platform, // R10.35：platform 为主平台（=platforms[0]），platforms 为适合平台全集
          platforms: o.platforms?.length ? o.platforms : [o.platform], recommendation: o.recommendation, category: o.category, perPlatformDecision: o.perPlatformDecision, outline: o.outline,
          suggestions: o.suggestions, rejectReason: o.rejectReason, publishedRef: o.publishedRef, producedBy: o.producedBy, draftBody: o.draftBody, createdAt: o.createdAt });
      for (const d of fetchRows("decisions"))
        rows.push({ sourceType: "manual", id: d.id, kind: "manual", title: d.title, summary: d.notes, decision: d.decision,
          platforms: d.platforms, suggestions: d.suggestions, rejectReason: d.rejectReason, publishedRef: d.publishedRef, producedBy: d.producedBy || "human", draftBody: d.draftBody, createdAt: d.createdAt });
      // R10.34-2 + R10.37 A-2：审查台只见活跃数据——pending/终态（rejected/published）超 7 天出窗
      // （janitor 物理归档为主，此窗是归档未跑时的第二道带）；在途态（approved/drafting/deferred）
      // 不设窗（超期在途项由 janitor 30 天归档 staled-* 兜底，不静默消失）。includeAll 覆盖。
      const windowMs = 7 * 86400000;
      const inFlight = (d: string) => d === "approved" || d === "drafting" || d === "deferred";
      return rows
        .filter((r) => !status || r.decision === status)
        .filter((r) => opts?.includeAll || inFlight(r.decision) || !Number.isFinite(Date.parse(r.createdAt)) || Date.now() - Date.parse(r.createdAt) <= windowMs)
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

type Consumption = { unconsumeIdentities: (target: "hotspots" | "evidence", identities: string[], dryRun?: boolean) => { ok: boolean; revived: number; expired: number; notFound?: number }; consumeIdentities: (target: "hotspots" | "evidence", identities: string[], reason: string, consumedBy: string, producedRef?: string, dryRun?: boolean) => { ok: boolean; toConsume: number; alreadyConsumed: number } };

export type Decisions = ReturnType<typeof createDecisions>;
