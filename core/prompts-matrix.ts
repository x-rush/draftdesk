// 提示词矩阵（第六轮批 B §2④）：skills/prompts/outline-matrix.md 是单一来源，
// 内置 AI（outlineDraftTick）与外部 Agent（skill-bundle 随包分发）共用。
// 组合生成：平台模板节 + 题材角度节 + 选题素材——不硬编码 4×6=24 组合。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizePlatform, normalizeCategory, platformLabel, categoryLabel } from "./platforms";

type Matrix = { platforms: Record<string, string>; categories: Record<string, string> };

let cache: { mtimeMs: number; matrix: Matrix } | undefined;

function matrixPath(): string {
  return path.join(process.cwd(), "skills", "prompts", "outline-matrix.md");
}

// 解析「### key 标签」小节；文件缺失/改坏时返回空表（compose 降级为通用提示词，不炸管线）。
export function loadPromptMatrix(): Matrix {
  const file = matrixPath();
  try {
    const stat = statOf(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.matrix;
    const text = readFileSync(file, "utf8");
    const matrix: Matrix = { platforms: {}, categories: {} };
    let section = "";
    let current: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (/^## 平台模板/.test(line)) { section = "p"; current = undefined; continue; }
      if (/^## 题材角度/.test(line)) { section = "c"; current = undefined; continue; }
      const head = line.match(/^### (\S+)/);
      if (head) { current = head[1]; if (current) matrix[section === "p" ? "platforms" : "categories"][current] = ""; continue; }
      if (current && line.trim()) matrix[section === "p" ? "platforms" : "categories"][current] += (matrix[section === "p" ? "platforms" : "categories"][current] ? "\n" : "") + line.trim();
    }
    cache = { mtimeMs: stat.mtimeMs, matrix };
    return matrix;
  } catch {
    return { platforms: {}, categories: {} };
  }
}

function statOf(file: string): { mtimeMs: number } {
  return statSync(file);
}

export function composeOutlinePrompt(platform: string, category: string | undefined, subject: string, keyPoints: string[] = []): string {
  const m = loadPromptMatrix();
  const pKey = normalizePlatform(platform) ?? platform;
  const cKey = category ? normalizeCategory(category) ?? category : undefined;
  const template = m.platforms[pKey] || "按目标平台的通行结构组织内容（标题/正文/标签/视觉位）。";
  const angle = cKey ? m.categories[cKey] : undefined;
  const points = keyPoints.length ? `\n\n写作要点（必须覆盖）：\n${keyPoints.map((k) => `- ${k}`).join("\n")}` : "";
  // R10.32-2：三路一致化——内置链注入小拾关键口径（标题=选题句/平台适配/跨日去重意识）
  const stance = `\n\n【编辑口径（与外部 Agent 主分析同源）】\n- 标题必须是选题句（带判断/承诺/角度），不是主题词：「换掉 X 前先看 Y」优于「X 发布」。\n- 平台适配：gzh=完整论证；tiebuhao=图卡组（3-6 张，首图即观点，每张 ≤54 字）；xhs-note=清单体/教程体（标题带可收藏价值点）；threads=中文选题的英文短评改写（不是新选题）。\n- 跨日去重意识：选题来自多日连续事件时，标题体现本轮新进展（如「第三轮调整后…」），不重炒旧闻。`;
  return `为选题「${subject}」写第一版内容大纲（${platformLabel(pKey) || pKey}${cKey ? ` · ${categoryLabel(cKey) || cKey}` : ""}）。

【平台结构要求】\n${template}${angle ? `\n\n【题材角度要求】\n${angle}` : ""}${points}${stance}

【输出格式】只输出 JSON 对象（不要 markdown 代码块）：
{"keyPoints":["要点1","要点2","要点3"],"outline":["第一部分标题","第二部分标题","第三部分标题"],"draftBody":"按平台结构要求写好的完整初稿（Markdown）"}
keyPoints 3-5 条；outline 3-8 段；draftBody 为可直接发布的完整初稿文本。`;
}
