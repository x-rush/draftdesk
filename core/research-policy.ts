import type { Artifact, EvidenceInput, Plan } from "./schema";

export const decisionLabels = { ready: "推荐 · 通过检查", review: "待验证", rejected: "已否决" };
export function decisionOf(a: Pick<Artifact, "quality" | "issues">) {
  return a.quality === "rejected" || a.issues.includes("审稿建议：reject") ? "rejected" : a.quality;
}
export const searchIntents = {
  editorial: ["官方 更新 公告 changelog 可用范围", "使用 限制 收费 定价 实际体验"],
  opportunity: ["用户 求助 手动 麻烦 替代方案", "现有工具 不好用 放弃 使用反馈 反例"],
  trends: ["搜索趋势 指数 地域 时间 原始数据", "热词 用户 搜索意图 下降 季节性"],
  people: ["本人 官方主页 作品 发布", "作者 身份 访谈 原始出处"],
} satisfies Record<Plan["kind"], string[]>;
export function queryPlan(plan: Plan, limit = plan.maxQueries) {
  const keys = plan.keywords.filter(Boolean);
  if (!keys.length) return [];
  const phrases = {
    editorial: ["官方 更新 公告", "定价 使用限制"],
    opportunity: ["求助 手动处理", "替代方案 使用反馈"],
    trends: ["搜索指数 地域", "搜索意图 用户问题"],
    people: ["本人 主页 作品", "署名 访谈"],
  };
  return Array.from({ length: limit }, (_, i) => ({
    query: `${keys[i % keys.length]} ${phrases[plan.kind][Math.floor(i / keys.length) % 2]}`,
    purpose: searchIntents[plan.kind][Math.floor(i / keys.length) % 2],
  }));
}
export function rankEvidence(items: EvidenceInput[], plan: Plan) {
  const preferred = { editorial: ["official", "media"], opportunity: ["community", "product"], trends: ["trend"], people: ["official", "community"] }[plan.kind];
  const score = (e: EvidenceInput) => (preferred.includes(e.sourceType) ? 4 : 0)
    + (e.metric && plan.kind === "trends" ? 3 : 0)
    + (plan.keywords.some(k => (e.title + e.excerpt).toLowerCase().includes(k.toLowerCase())) ? 2 : 0)
    + (e.publishedAt ? 1 : 0)
    + (plan.kind === "editorial" && /introducing|meet the|now everyone|新增|推出|上线|开放|更新/i.test(e.title + " " + e.excerpt) ? 3 : 0)
    + (plan.kind === "opportunity" && e.sourceType === "community" && /求助|手工|手动|困扰|不好用|无法|不能|workaround|manual|struggl/i.test(e.excerpt) ? 4 : 0);
  return [...items].sort((a, b) => score(b) - score(a));
}
export function supplementQueries(clusters: {label: string; missing: string[]}[], kind: Plan["kind"], limit: number) {
  return clusters.flatMap(c => c.missing.filter(m => /收费|价格|免费|开放|可用|地区|地域|时间|日期|限制|身份|用户|需求|替代|指标|出处|price|availability|limit|date/i.test(m))
    .map(m => ({ query: `${c.label.slice(0, 100)} ${m.slice(0, 180)} ${kind === "opportunity" ? "用户反馈 替代方案" : "官方 原始出处"}`, purpose: m })))
    .filter((v, i, all) => all.findIndex(x => x.query === v.query) === i).slice(0, limit);
}
