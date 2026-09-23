import type { ArtifactDraft, Evidence } from "./schema";
import { qualityIssues } from "./quality";
export const evaluationDimensions = ["读者与任务相关性", "关键事实有证据支持", "行动方案具体可执行", "反证与未知项表达", "没有凑数或虚构需求"];
export function evaluateOutput(items: ArtifactDraft[], evidence: Evidence[]) {
  const ids = new Set(evidence.map(e=>e.id));
  const refs = items.flatMap(a=>[...a.evidenceIds,...a.claims.flatMap(c=>c.evidenceIds)]);
  const quotes = items.flatMap(a=>a.claims.filter(c=>c.quote));
  const factClaims = items.flatMap(a=>a.claims.filter(c=>c.type==="fact"));
  return {
    artifactCount:items.length,
    referenceValidity:refs.length ? refs.filter(id=>ids.has(id)).length / refs.length : null,
    exactQuoteMatch:quotes.length ? quotes.filter(c=>c.evidenceIds.some(id=>evidence.find(e=>e.id===id)?.excerpt.includes(c.quote!))).length / quotes.length : null,
    factCitationCoverage:factClaims.length ? factClaims.filter(c=>c.evidenceIds.length>0 && c.evidenceIds.every(id=>ids.has(id))).length/factClaims.length : null,
    issues:items.map(a=>({title:a.title,issues:qualityIssues(a,evidence)})),
    semanticQuality:null,
    note:"引用存在和原话匹配不代表支持对应论断；相关性、事实蕴含、行动性须盲审。空产物按场景判断，不自动记满分。",
  };
}
