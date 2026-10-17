// 语义初筛路由（R9-6）：外部 Agent/小拾的显式触发口与结果读口。
// POST /triage/generate 置 meta 请求，worker tick 消费（失败补跑同通道）；
// GET /triage/groups 读归组结果；GET /triage/status 看单批状态。
import { z } from "zod";
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError } from "../store";
import { requestTriage, ATTENTION_LABELS } from "../triage";

export const routes: RouteDef[] = [
  {
    methods: ["POST"],
    pattern: "triage/generate",
    handler: async ({ db, query, readBody }) => {
      let jobId = query.get("jobId") || "";
      if (!jobId) {
        const body = await readBody(4096).catch(() => ({}));
        jobId = String(body?.jobId || "");
      }
      const parsed = z.string().max(64).optional().safeParse(jobId || undefined);
      requestTriage(db, parsed.success ? parsed.data : undefined);
      return json({ ok: true, queued: true, jobId: jobId || null, note: jobId ? `已请求补跑批次 ${jobId}` : "已请求对最近未初筛批次补跑；worker tick 数秒内消费。" }, 202);
    },
  },
  {
    // ?jobId= 指定批次；缺省返回最近一条有归组的批次
    methods: ["GET"],
    pattern: "triage/groups",
    handler: ({ db, query }) => {
      const jobId = query.get("jobId") || "";
      const record = jobId
        ? db.get<any>("candidate-groups", "tg-" + jobId)
        : db.list<any>("candidate-groups").sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
      if (!record) throw new AppError("该批次还没有语义初筛结果（未跑、off 或失败待补跑）。", 404);
      const discovery = db.get<any>("discovery", record.jobId);
      return json({
        jobId: record.jobId,
        planName: record.planName,
        at: record.at,
        shards: record.shards,
        calls: record.calls,
        tokens: record.tokens,
        merges: record.merges,
        groups: (record.groups || []).map((g: any) => ({
          ...g,
          attentionLabel: ATTENTION_LABELS[g.attention as keyof typeof ATTENTION_LABELS] || g.attention,
          members: (discovery?.candidates || []).filter((c: any) => (g.memberUrls || []).includes(c.url)).map((c: any) => ({ title: c.title, url: c.url, sourceName: c.sourceName, status: c.status })),
        })),
      });
    },
  },
  {
    // R10 第2段：归档队列（判无注意力的组）可查可恢复——「没有价值的需要归档」的明示动作留痕
    methods: ["GET"],
    pattern: "triage/archive",
    handler: ({ db, query }) => {
      const jobId = query.get("jobId") || "";
      const rows = jobId
        ? db.list<any>("triage-archive").filter((r) => r.jobId === jobId)
        : db.list<any>("triage-archive").sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 14);
      return json({ items: rows.map((r) => ({ jobId: r.jobId, day: r.day, at: r.at, groups: (r.groups || []).map((g: any) => ({ id: g.id, title: g.title, reason: g.reason, members: (g.memberUrls || []).length })) })), total: db.list<any>("triage-archive").length });
    },
  },
  {
    methods: ["POST"],
    pattern: "triage/restore",
    handler: async ({ db, readBody }) => {
      const parsed = z.object({ jobId: z.string().min(1).max(64), groupId: z.string().max(40).optional() }).strict().parse(await readBody());
      const { restoreArchived } = await import("../collect-all");
      const r = restoreArchived(db, parsed.jobId, parsed.groupId);
      return json({ ok: true, ...r, ...(r.restored ? {} : { note: "无匹配归档记录或成员已不在归档态" }) });
    },
  },
  {
    methods: ["GET"],
    pattern: "triage/status",
    handler: ({ db, query }) => {
      const jobId = query.get("jobId");
      const fail = jobId ? db.get<any>("meta", "triage-fail:" + jobId) : null;
      const triaged = jobId ? !!db.get<any>("candidate-groups", "tg-" + jobId) : false;
      const state = triaged ? "done" : fail ? "failed" : "pending";
      return json({
        jobId: jobId || null,
        state,
        ...(fail ? { failedAt: fail.at, error: fail.error } : {}),
        ...(jobId && triaged ? { groupsUrl: "/api/v1/triage/groups?jobId=" + jobId } : {}),
      });
    },
  },
];
