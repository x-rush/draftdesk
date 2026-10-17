// 选题去重记忆（第七轮批3 W7-9.5，语义级防重复的降级实现）：
// 建簇时对簇心 topic 与「已拍板选题」库（outlines 进入 approved/drafting/published 的标题+结构）
// 做核心词重合度检查：重合 ≥2/3 即标 coveredVariant（已覆盖变体），不再重复出选题。
// 中文无分词基建——中文段按「贪心最长匹配」算覆盖（共享片段字符数/段长，共享片段 ≥2 字），
// 英文按词元重合；两者加权为总重合比。embedding 相似度（>0.85）留作后续基建接入点。
import type { Store } from "./store";

const STOP_EN = new Set(["the", "a", "an", "of", "for", "and", "or", "to", "is", "are", "was", "were", "how", "what", "why", "which", "when", "where", "who", "will", "can", "does", "do", "should", "with", "on", "in", "at", "by", "from", "your", "you", "it", "its", "that", "this", "best", "top", "vs"]);

// 英文词元（≥3 字母数字，滤停用词）
function englishWords(text: string): string[] {
  return String(text || "").toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !STOP_EN.has(w));
}

// 中文段（≥2 连续汉字）
function chineseSegments(text: string): string[] {
  return String(text || "").match(/[一-龥]{2,}/g) || [];
}

// 切词器（导出供测试与调用方）：英文词元 + 中文整段（无分词基建；重合检查另有贪心匹配）
export function tokenize(text: string): string[] {
  return [...englishWords(String(text)), ...chineseSegments(String(text))];
}

// 中文段在对照文本中的贪心最长匹配覆盖率（共享片段 ≥2 字）
function segmentCoverage(seg: string, originText: string): number {
  let covered = 0, i = 0;
  while (i < seg.length) {
    let matched = 0;
    for (let len = Math.min(12, seg.length - i); len >= 2; len--) {
      if (originText.includes(seg.slice(i, i + len))) { matched = len; break; }
    }
    if (matched) { covered += matched; i += matched; } else i++;
  }
  return covered / seg.length;
}

export type Coverage = { originId: string; originTitle: string; matched: number; total: number; ratio: number };

// 簇心与一个已拍板选题的核心词重合度：英文词重合 + 中文段贪心覆盖，加权平均
export function coverageOf(topic: string, origin: { id: string; title: string; text: string }): Coverage | undefined {
  const originText = origin.text.toLowerCase();
  const enWords = englishWords(topic);
  const cnSegs = chineseSegments(topic);
  const parts = enWords.length + cnSegs.length;
  if (!parts) return undefined;
  const originWords = new Set(englishWords(originText));
  const enHit = enWords.filter((w) => originWords.has(w)).length;
  const cnHit = cnSegs.reduce((acc, seg) => acc + segmentCoverage(seg, originText), 0);
  // 千分位取整后比较（≥2/3）：浮点累加在边界值（如 8/12 恰=2/3）会误杀
  const ratio = Math.round(((enHit + cnHit) / parts) * 1000) / 1000;
  if (ratio * 3 < 2) return undefined;
  return { originId: origin.id, originTitle: origin.title, matched: Math.round((enHit + cnHit) * 100) / 100, total: parts, ratio };
}

// 已拍板选题库：outlines 的 decision 进入 approved/drafting/published（拍板流转后的所有在途与完成态）。
// P0-2 修复（社区审查）：生产全链写的是 decision 字段（agent-write/decisions/outline-draft），
// 旧代码读 o.status 恒 undefined → decidedTopics 永远为空、去重记忆从未生效。
export function decidedTopics(db: Store): { id: string; title: string; text: string }[] {
  return db.list<any>("outlines")
    .filter((o) => ["approved", "drafting", "published"].includes(String(o.decision || "")) && o.title)
    .map((o) => ({ id: String(o.id), title: String(o.title), text: `${o.title} ${(o.outline || []).join(" ")}` }));
}

// 建簇写入口调用：簇 topic 与已拍板选题比对，命中返回 covered（调用方把 coveredVariant
// 合进簇文档再落库——新簇尚无 doc，本函数不做写库）。已有标注的簇幂等跳过。
export function markCoveredVariants(db: Store, cluster: { topic: string; coveredVariant?: unknown }): { covered?: Coverage } {
  if (!cluster?.topic || cluster.coveredVariant) return {};
  for (const origin of decidedTopics(db)) {
    const hit = coverageOf(String(cluster.topic), origin);
    if (hit) return { covered: hit };
  }
  return {};
}

// 标注文档组装（调用方共用的 shape，method 恒定便于检索）
export function coveredVariantDoc(covered: Coverage): Record<string, unknown> {
  return { ...covered, at: new Date().toISOString(), method: "keyword-2of3" };
}
