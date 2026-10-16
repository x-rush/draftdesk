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
