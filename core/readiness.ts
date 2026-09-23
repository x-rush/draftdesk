import type { ArtifactDraft, Evidence, Plan } from "./schema";

export type EvidenceCheck = {
  key: string; label: string; status: "candidate" | "missing";
  evidenceIds: string[]; reason: string; action: string; query: string;
};
const problem = /求助|困扰|麻烦|手工|手动|耗时|漏掉|遗漏|漏一|无法|不能|不好用|太贵|失败|workaround|struggl|manual|frustrat|can't|cannot|pain point/i;
const concrete = (e: Evidence) => e.contentLevel !== "headline" && e.excerpt.trim().length >= 20;
const keyText = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const canonical = (value: string) => { const u = new URL(value); u.searchParams.sort(); return u.origin + u.pathname.replace(/\/$/, "") + u.search; };
export function problemCandidates(evidence: Evidence[]) {
  return evidence.filter(e => e.sourceType === "community" && concrete(e) && problem.test(e.excerpt));
}

// These are observable material checks, never a semantic verifier or market score.
export function evidenceReadiness(item: ArtifactDraft, all: Evidence[]): EvidenceCheck[] {
  const evidence = all.filter(e => item.evidenceIds.includes(e.id));
  const checks: EvidenceCheck[] = [];
  const add = (key: string, label: string, candidates: Evidence[], reason: string, action: string, query: string) =>
    checks.push({key, label, status: candidates.length ? "candidate" : "missing", evidenceIds: candidates.map(e=>e.id), reason, action, query});
  const subject = item.kind === "trend" ? item.details.keyword : item.kind === "person" ? item.details.name : item.title;
  const searchSubject = item.tags.filter(t=>!["公众号","小红书","待验证"].includes(t)).slice(0,3).join(" ") || subject.slice(0,60);
  const quoted = (e: Evidence) => item.claims.some(c => c.evidenceIds.includes(e.id) && !!c.quote && e.excerpt.includes(c.quote));
  if (item.kind === "idea") {
    add("problem", "真实问题样本", problemCandidates(evidence).filter(e=>item.claims.some(c=>c.evidenceIds.includes(e.id) && !!c.quote && e.excerpt.includes(c.quote) && problem.test(c.quote))),
      "社区标签和点赞不能证明需求；检查是否引用了材料中的问题原话，相关性仍需人工核对。",
      "找一条包含具体任务、当前做法和障碍的原始讨论，把原话逐字关联到陈述。",
      `${searchSubject} 求助 手动 替代方案`);
    add("alternative", "替代方案材料", evidence.filter(e => concrete(e) && ["product", "official"].includes(e.sourceType)),
      "列出竞品名称不等于已经比较能力、价格和使用限制。",
      "核对一个最强替代的功能及限制，用同一个任务比较；现有方案足够时允许不开发。",
      `${searchSubject} 现有工具 功能 限制`);
    add("payment", "实际付费行为线索", evidence.filter(e => e.sourceType === "community" && quoted(e) && /已付费|付过费|订阅了|购买了|花了|I paid|I bought|paying for/i.test(e.excerpt)),
      "付费行为线索仍需核对上下文；没有材料时，付费意愿必须保留为假设。",
      "验证用户是否为当前替代付费及为何付费；报价实验需另行安排，不能编造访谈。",
      `${searchSubject} 付费 订阅 使用反馈`);
  } else if (item.kind === "person") {
    const name = keyText(item.details.name);
    add("identity", "姓名与一手材料关联", evidence.filter(e => e.sourceType === "official" && concrete(e) && keyText(e.title + e.excerpt).includes(name)),
      "同名与来源标签都不能完成身份认证，只检查是否有带姓名的一手材料候选。",
      "核对本人主页、组织署名或作品归属的互链；未消歧时不要合并履历。", `${subject} 本人 官方主页 作品`);
    const linked = item.details.publicChannels.filter(channel => evidence.some(e => canonical(e.url) === canonical(channel)));
    add("channels", "公开渠道可追溯", linked.length === item.details.publicChannels.length ? evidence.filter(e=>linked.some(c=>canonical(c)===canonical(e.url))) : [],
      "每个公开渠道都应有对应的已采集页面；同一个域名不是同一个账号。",
      "补采缺失的公开渠道页面，或移除没有材料支持的账号地址。", `${subject} 作品 个人主页`);
  } else if (item.kind === "trend") {
    add("metric", "原始指标", evidence.filter(e => item.details.signalEvidenceIds.includes(e.id) && !!e.metric),
      "没有指标就是讨论线索；一次热榜或分桶数值不能证明增长。",
      "采集同一词、同一来源与地域的连续观测，保留数值、单位和周期。", `${subject} 搜索指数 ${item.details.region}`);
    add("intent", "实际搜索意图材料", problemCandidates(evidence),
      "热词名称无法独自证明用户想做什么，更不能证明愿意付费。",
      "找这个词对应的具体问题、操作或替代需求，再决定写内容还是设计应用。", `${subject} 怎么用 求助 替代`);
  } else {
    add("primary", "一手变化来源", evidence.filter(e => e.sourceType === "official" && concrete(e)),
      "聚合摘要可以发现线索；功能、开放范围与限制应回到原始来源。",
      "补查对应的官方更新、帮助文档或定价页面，再核对读者现在是否能使用。", `${subject} 官方 更新 可用范围`);
    const critical = item.claims.filter(c=>c.type === "fact" && /免费|收费|价格|开放|上线|发布|限制|可用|price|available|launch/i.test(c.statement));
    if (critical.length) {
      const supported = critical.every(c => !!c.quote && c.evidenceIds.some(id => evidence.some(e => e.id===id && e.sourceType==="official" && e.excerpt.includes(c.quote!))));
      add("critical", "关键事实的原文锚点", supported ? evidence.filter(e=>critical.some(c=>c.evidenceIds.includes(e.id))) : [],
        "原文匹配只证明引文存在，不证明推断成立；价格、范围、时间应逐项核对。",
        "为关键事实补上官方原文短引及引用；查不到时改成未知或待验证假设。", `${subject} 官方 定价 开放 限制`);
    }
  }
  return checks;
}

// Deterministic gaps supplement the curator rather than trusting it to notice all omissions.
export function collectionGaps(plan: Plan, evidence: Evidence[]) {
  const missing: string[] = [];
  if (plan.kind === "opportunity" && !problemCandidates(evidence).length) missing.push("具体用户问题原话和现有替代方案缺失");
  if (plan.kind === "people" && !evidence.some(e=>e.sourceType==="official" && concrete(e))) missing.push("人物身份对应的本人主页或作品出处缺失");
  if (plan.kind === "editorial" && !evidence.some(e=>e.sourceType==="official" && concrete(e))) missing.push("官方更新和使用限制的原始出处缺失");
  if (plan.kind === "trends" && !evidence.some(e=>e.metric)) missing.push("热词原始指标及地域时间口径缺失");
  return missing;
}
