// 平台与题材目录（第六轮批 A）：选题体系的双标注轴。
// 平台五值（§0②）：gzh 公众号 / tiebuhao 贴图号 / xhs-note 小红书笔记 / xhs-video 小红书视频笔记 / threads（第 5 合法值，存量保留）。
// 题材六值（§0⑤）：newtech / news / oss / selfproduct / thinking / hot。
// 旧值（公众号/小红书/Threads）由 normalizePlatform 映射到新枚举——迁移 outline-platform-v1
// 与外部 Agent 提交共用此入口，落库只存新枚举键。

export type PlatformKey = "gzh" | "tiebuhao" | "xhs-note" | "xhs-video" | "threads";
export const PLATFORM_KEYS: PlatformKey[] = ["gzh", "tiebuhao", "xhs-note", "xhs-video", "threads"];

export const PLATFORM_LABELS: Record<string, string> = {
  gzh: "公众号",
  tiebuhao: "贴图号",
  "xhs-note": "小红书笔记",
  "xhs-video": "小红书视频笔记",
  threads: "Threads",
};

export function platformLabel(v: string | undefined): string {
  if (!v) return "";
  return PLATFORM_LABELS[v] || v; // 未知值原样显示（不吞信息）
}

export function normalizePlatform(v: string): PlatformKey | undefined {
  const t = String(v || "").trim();
  if (!t) return undefined;
  if ((PLATFORM_KEYS as string[]).includes(t)) return t as PlatformKey;
  // 旧值映射（存量 outlines/artifacts 62+ 条的迁移口径）
  if (t === "公众号") return "gzh";
  if (t === "小红书") return "xhs-note";
  if (t === "Threads") return "threads";
  // 中文标签反查（外部 Agent 可能直接提交标签）
  const byLabel = Object.entries(PLATFORM_LABELS).find(([k, label]) => label === t && (PLATFORM_KEYS as string[]).includes(k));
  return byLabel ? (byLabel[0] as PlatformKey) : undefined;
}

export type CategoryKey = "newtech" | "news" | "oss" | "selfproduct" | "thinking" | "hot";
export const CATEGORY_KEYS: CategoryKey[] = ["newtech", "news", "oss", "selfproduct", "thinking", "hot"];

export const CATEGORY_LABELS: Record<string, string> = {
  newtech: "AI 新技术",
  news: "新资讯",
  oss: "开源工具",
  selfproduct: "自研产品",
  thinking: "个人思考",
  hot: "社会热点",
};

export function categoryLabel(v: string | undefined): string {
  if (!v) return "";
  return CATEGORY_LABELS[v] || v;
}

export function normalizeCategory(v: string): CategoryKey | undefined {
  const t = String(v || "").trim();
  if (!t) return undefined;
  if ((CATEGORY_KEYS as string[]).includes(t)) return t as CategoryKey;
  const byLabel = Object.entries(CATEGORY_LABELS).find(([, label]) => label === t);
  return byLabel ? (byLabel[0] as CategoryKey) : undefined;
}
