// 组结构共享载体（R10.27-C#19/#20）——triage ↔ opportunity 模块环的解耦点 + zod/TS 单一定义源。
// 此前 TriageRecord/ATTENTION_LABELS 在 triage.ts，opportunity.ts 静态导入 triage、
// triage 反向动态 import opportunity 逃逸（混合环）；组卡 zod 在 triage.ts:142 与
// agent-write.ts:25 逐字符双维护。现统一从本文件导出，三方（triage/opportunity/routes）引用。
import { z } from "zod";

export type Attention = "strong" | "potential" | "none";
export const ATTENTION_LABELS: Record<Attention, string> = { strong: "强", potential: "潜力", none: "无" };

export type TriageGroup = {
  id: string;
  title: string;
  attention: Attention;
  reason: string;
  memberUrls: string[];
  representativeUrl: string;
  sources: string[];
  angles: { platform: string; angle: string }[];
  appGap?: string;
};

// candidate-groups 集合：一个采集批次一条归组记录（tg-{jobId}）。
export type TriageRecord = {
  jobId: string;
  planName: string;
  day: string;
  at: string;
  groups: TriageGroup[];
  shards: number;
  calls: number;
  tokens: number;
  merges: number;
};

// 内容角度平台（xhs-video 视频后置，不进角度草案；唯一数组定义处）
export const ANGLE_PLATFORMS = ["gzh", "tiebuhao", "xhs-note", "threads", "x", "facebook", "instagram", "linkedin"] as const;

// 组内 angles 的 zod 形状——triage 分片输出与 PUT /agent/triage/groups 请求体共用（单一来源）
export const triageAnglesSchema = z.array(z.object({ platform: z.string().max(30), angle: z.string().max(150) })).max(8);
