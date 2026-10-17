// 平台与题材目录（第六轮批 A 起；R10.2 扩 9 值）：选题体系的双标注轴 + 机会产品形态目录。
// 平台九值：gzh / tiebuhao / xhs-note / xhs-video（视频后置）/ threads / x / facebook / instagram / linkedin。
// 本模块是客户端共享目录（零 node 依赖）——平台、题材、机会形态的枚举与标签唯一定义处。
// 总纲：不做旧值映射（旧中文值已随数据归档，提交侧只认当前枚举键或当前显示标签）。

export type PlatformKey = "gzh" | "tiebuhao" | "xhs-note" | "xhs-video" | "threads" | "x" | "facebook" | "instagram" | "linkedin";
export const PLATFORM_KEYS: PlatformKey[] = ["gzh", "tiebuhao", "xhs-note", "xhs-video", "threads", "x", "facebook", "instagram", "linkedin"];

export const PLATFORM_LABELS: Record<string, string> = {
  gzh: "公众号",
  tiebuhao: "贴图号",
  "xhs-note": "小红书笔记",
  "xhs-video": "小红书视频（后置）",
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export function platformLabel(v: string | undefined): string {
  if (!v) return "";
  return PLATFORM_LABELS[v] || v; // 未知值原样显示（不吞信息）
}

export function normalizePlatform(v: string): PlatformKey | undefined {
  const t = String(v || "").trim();
  if (!t) return undefined;
  if ((PLATFORM_KEYS as string[]).includes(t)) return t as PlatformKey;
  // 当前显示标签反查（提交侧可直接给 UI 标签，如 "Instagram"）
  const byLabel = Object.entries(PLATFORM_LABELS).find(([k, label]) => label === t && (PLATFORM_KEYS as string[]).includes(k));
  return byLabel ? (byLabel[0] as PlatformKey) : undefined;
}

// ---- 机会产品形态目录（R10 六值带变现，唯一定义处）----
export type OpportunityForm = "web-app" | "site-group" | "mobile-app" | "mini-program" | "tool" | "open-source";
export const FORM_KEYS: OpportunityForm[] = ["web-app", "site-group", "mobile-app", "mini-program", "tool", "open-source"];
export const FORM_LABELS: Record<OpportunityForm, string> = {
  "web-app": "Web 应用", "site-group": "站群", "mobile-app": "移动 App", "mini-program": "小程序",
  tool: "工具站", "open-source": "开源引流",
};
export const FORM_MONETIZATION: Record<OpportunityForm, string> = {
  "web-app": "订阅/买断", "site-group": "展示广告/联盟", "mobile-app": "订阅/内购",
  "mini-program": "广告/增值服务", tool: "广告/付费功能", "open-source": "引流/赞助",
};
// 严格六值（总纲：不做旧值映射/自由文本兼容）
export function normalizeForm(value: unknown): OpportunityForm | undefined {
  return FORM_KEYS.includes(value as OpportunityForm) ? (value as OpportunityForm) : undefined;
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

// ---- 按平台拍板（第六轮批 B §2①）----
// 聚合优先序：分化时取最前进的正向状态展示（published > drafting > approved > rejected > deferred > pending）。
export const DECISION_PRIORITY = ["published", "drafting", "approved", "rejected", "deferred", "pending"] as const;
export type OutlineDecision = (typeof DECISION_PRIORITY)[number];

export function aggregateOutlineDecision(o: { decision?: string; perPlatformDecision?: Record<string, string> }): OutlineDecision {
  const per = Object.values(o.perPlatformDecision || {}) as OutlineDecision[];
  if (per.length) {
    for (const s of DECISION_PRIORITY) if (per.includes(s)) return s;
  }
  return (o.decision as OutlineDecision) || "pending";
}
