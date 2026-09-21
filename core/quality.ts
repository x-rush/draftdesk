import type { ArtifactDraft, Evidence } from "./schema";
export function qualityIssues(item: ArtifactDraft, evidence: Evidence[]) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const issues: string[] = [];
  const referenced = item.evidenceIds.map((id) => byId.get(id));
  // A narrow announcement can have one primary source; impact/experience still needs review.
  const primaryAnnouncement = item.kind === "news" && referenced.length > 0 &&
    referenced.every((e) => e?.sourceType === "official") &&
    item.claims.every((c) => c.type === "fact" && c.evidenceIds.length > 0);
  if (referenced.some((x) => !x)) issues.push("存在未知证据引用。");
  if (
    new Set(
      referenced
        .filter(Boolean)
        .map((e) => new URL(e!.url).hostname.replace(/^www\./, "")),
    ).size < 2 && !primaryAnnouncement
  )
    issues.push("仅一个来源域名，缺少独立交叉证据。");
  for (const c of item.claims) {
    if (
      c.evidenceIds.some(
        (id) => !item.evidenceIds.includes(id) || !byId.has(id),
      )
    )
      issues.push("事实引用未列入该内容的证据集。");
    if (c.type === "fact" && !c.evidenceIds.length)
      issues.push("事实陈述没有引用。");
    if (
      c.quote &&
      !c.evidenceIds.some((id) => byId.get(id)?.excerpt.includes(c.quote!))
    )
      issues.push("引用原话无法在所提供材料中找到。");
  }
  if (item.kind === "trend") {
    if (
      item.details.signalEvidenceIds.some(
        (id) => !item.evidenceIds.includes(id),
      )
    )
      issues.push("趋势指标引用超出证据集。");
    if (!item.details.signalEvidenceIds.some((id) => byId.get(id)?.metric))
      issues.push("没有原始指标，只能视为讨论线索，不能视为趋势已验证。");
  }
  if (
    item.kind === "idea" &&
    !referenced.some((e) => e?.sourceType === "community")
  )
    issues.push("没有真实用户问题来源，需求与付费意愿仍是假设。");
  if (referenced.some((e) => e && !e.publishedAt))
    issues.push("部分来源发布时间未知，请核对时效。");
  return [...new Set(issues)];
}
