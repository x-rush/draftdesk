import { activityIssues } from "./activities";
import {trustedActivityRulesUrl} from "./activity-import";
import type { ArtifactDraft, Evidence } from "./schema";
import { evidenceReadiness } from "./readiness";
// Compare overlapping text, not domain names: syndicated releases are one account.
function shingles(text: string) {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return new Set(Array.from({ length: Math.max(0, normalized.length - 11) }, (_, i) => normalized.slice(i, i + 12)));
}
function likelySyndicated(a: Evidence, b: Evidence) {
  if (Math.min(a.excerpt.length, b.excerpt.length) < 120) return false;
  const left = shingles(a.excerpt), right = shingles(b.excerpt);
  const overlap = [...left].filter((part) => right.has(part)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size)) >= 0.65;
}
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}
export function qualityIssues(item: ArtifactDraft, evidence: Evidence[]) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const issues: string[] = [];
  const referenced = item.evidenceIds.map((id) => byId.get(id));
  const independent: Evidence[] = [];
  for (const source of referenced) {
    if (source && !independent.some((previous) => likelySyndicated(previous, source))) independent.push(source);
  }
  if (referenced.filter(Boolean).length > independent.length)
    issues.push("部分来源疑似同稿转载，不能按不同域名视为独立交叉证据；请核对原始出处。");
  // Evidence can support attributed third-party claims, never an invented author experience.
  const completedExperience = /(?:我们|我本人|本人|我)(?:亲自|已经|已|实际|用|试用|体验|测试|实测)[^。！？\n]{0,45}(?:跑了一遍|试过|测过|测试了|发现|节省了|省了)|实测报告出炉|这篇实测告诉你|实测结果(?:表明|显示|证明)/;
  if(item.kind==="activity")issues.push(...activityIssues(item,evidence));
  const publicationText = [item.title, item.summary, item.personalImpact, ...stringsIn(item.details)];
  if (publicationText.some((text) => completedExperience.test(text)))
    issues.push("包含已完成实测或第一人称体验的表达；工作台没有作者实测记录，请改成待验证计划或明确归属的来源陈述。");
  if(item.kind==="topic"&&item.details.platforms.some(platform=>platform.titles.some(title=>/实测|亲测/.test(title)&&!/未实测|待实测|准备实测|计划实测|如何实测|实测计划|实测方法/.test(title))))
    issues.push("平台标题暗示作者已经实测，但证据没有作者操作记录；改成验证计划或先补真实测试材料。");
  // A narrow announcement can have one primary source; impact/experience still needs review.
  const primaryAnnouncement = (item.kind === "news" || item.kind==="activity") && referenced.length > 0 &&
    referenced.every((e) => e?.sourceType === "official" && (item.kind!=="activity"||trustedActivityRulesUrl(e.url))) &&
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
  if (item.kind!=="activity" && referenced.some((e) => e && !e.publishedAt))
    issues.push("部分来源发布时间未知，请核对时效。");
  issues.push(...evidenceReadiness(item, evidence).filter(c=>c.status === "missing").map(c=>`${c.label}不足：${c.action}`));
  return [...new Set(issues)];
}
