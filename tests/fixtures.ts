import type { ArtifactDraft, Evidence, Plan } from "../core/schema";
import { defaultPlans } from "../core/defaults";
export const evidence: Evidence[] = [
  {
    id: "ev-one",
    title: "官方产品更新",
    url: "https://example.com/update",
    excerpt:
      "此测试版本支持导出带有负责人字段的会议记录。免费范围未在公告中说明。",
    publishedAt: "2026-09-20T00:00:00Z",
    collectedAt: "2026-09-21T00:00:00Z",
    sourceType: "official",
    region: "全球",
    language: "zh",
    contentLevel: "excerpt",
    provenance: "test",
    fingerprint: "one",
  },
  {
    id: "ev-two",
    title: "用户的公开问题",
    url: "https://example.org/discussion",
    excerpt: "我每周整理访谈，需要逐条核对负责人；现在手工处理总会漏一项。",
    publishedAt: "2026-09-20T00:00:00Z",
    collectedAt: "2026-09-21T00:00:00Z",
    sourceType: "community",
    region: "中国",
    language: "zh",
    contentLevel: "excerpt",
    provenance: "test",
    fingerprint: "two",
  },
];
export const topic: Extract<ArtifactDraft, { kind: "topic" }> = {
  kind: "topic",
  title: "把会议纪要变成可核对的任务清单",
  summary:
    "一个待验证的内容角度：用同一份会议样例检查 AI 提取任务时是否遗漏负责人和截止时间。",
  audience: "需要整理会议记录的普通职场人",
  whyNow: "公开更新提到导出能力，可设计可复现的对照实验。",
  personalImpact: "帮助读者检查待办是否能交付，避免只得到一段摘要。",
  tags: ["公众号", "小红书", "AI工作流"],
  evidenceIds: ["ev-one", "ev-two"],
  claims: [
    {
      statement: "测试材料提及负责人字段",
      type: "fact",
      evidenceIds: ["ev-one"],
      quote: "此测试版本支持导出带有负责人字段的会议记录。",
    },
    {
      statement: "可能减少检查负担，尚待实测",
      type: "hypothesis",
      evidenceIds: [],
    },
  ],
  unknowns: ["价格与免费范围未核实"],
  nextActions: ["准备一份无敏感信息的会议样例"],
  details: {
    angle: "检查任务完整性，而非只比较摘要长度",
    readerPromise: "能用三项标准检查会议任务是否完整",
    outline: [
      "准备同一份公开样例",
      "检查负责人和截止日期",
      "记录遗漏并说明限制",
    ],
    materialChecklist: ["实际操作截图", "当前套餐价格"],
    platforms: [
      {
        name: "公众号",
        titles: ["别只看摘要：核对一份会议纪要的三个问题"],
        hook: "纪要写得流畅，任务却仍无人认领。",
        structure: ["展示样例", "演示核对流程", "列出限制与检查清单"],
      },
      {
        name: "小红书",
        titles: ["AI 会议纪要，先核对这三项"],
        hook: "保存这张核对清单，下次开会后试一次。",
        structure: ["封面问题", "负责人检查", "截止日期检查", "限制与样例"],
      },
    ],
  },
};
export const plan: Plan = { ...defaultPlans[0], maxTokens: 200000 };
export const envelope = () => ({
  schemaVersion: "1.0",
  submissionId: "test-batch",
  producer: { name: "hermes", version: "1" },
  evidence: evidence.map(({ provenance, fingerprint, ...e }) => e),
  drafts: [topic],
});
