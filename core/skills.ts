import { readFileSync } from "node:fs";
import path from "node:path";
import { hash } from "./store";
export const skillCatalog = [
  {
    id: "evidence-curator",
    name: "证据整理员",
    purpose: "去重、时间、地域、原话与来源独立性",
  },
  {
    id: "editorial-research",
    name: "资讯与选题编辑",
    purpose: "个人影响、原创切口、公众号与小红书双版本",
  },
  {
    id: "trend-research",
    name: "趋势观察员",
    purpose: "热榜、搜索意图、指标口径与反证",
  },
  {
    id: "opportunity-research",
    name: "应用机会研究员",
    purpose: "用户任务、替代方案、一周验证与停止条件",
  },
  {
    id: "people-research",
    name: "人物与作者观察员",
    purpose: "公开作品、身份消歧、时间线和选题启发",
  },
  {
    id: "quality-editor",
    name: "证据与质量审稿员",
    purpose: "拒绝宏大空话、伪造实测、无证据结论",
  },
  {
    id: "discussion-partner",
    name: "研究讨论搭档",
    purpose: "围绕已有证据迭代观点与应用设计",
  },
  {
    id: "draftdesk-submit",
    name: "外部智能体提交",
    purpose: "Hermes、OpenClaw 等使用统一收件协议",
  },
];
export const skillReferences: Record<string, string[]> = {
  "draftdesk-submit": ["references/agent-workflow.md"],
  "evidence-curator": ["references/source-assessment.md"],
  "editorial-research": ["references/editorial-decisions.md"],
  "trend-research": ["references/trend-decisions.md"],
  "opportunity-research": ["references/opportunity-decisions.md"],
  "quality-editor": ["references/review-rubric.md"],
  "people-research": ["references/identity-checks.md"],
  "discussion-partner": ["references/working-dialogue.md"],
};
export function loadSkill(id: string) {
  if (!skillCatalog.some((s) => s.id === id)) throw new Error("未知技能");
  const entry = readFileSync(
    path.join(process.cwd(), "skills", id, "SKILL.md"),
    "utf8",
  );
  const version = entry.match(/^\s+version:\s*["']?([\d.]+)["']?\s*$/m)?.[1];
  if (!version) throw new Error(`技能缺少版本：${id}`);
  const references = (skillReferences[id] || []).map((file) => ({
    file,
    content: readFileSync(path.join(process.cwd(), "skills", id, file), "utf8"),
  }));
  const content = entry + references.map((r) => `\n\n---\n参考规程 ${r.file}\n${r.content}`).join("");
  return { content, version, references: references.map((r) => r.file), digest: hash(content).slice(0, 12) };
}
