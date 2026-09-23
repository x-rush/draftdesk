import { createHash } from "node:crypto";
import type { Evidence } from "./schema";
import type { Store } from "./store";
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const normalized = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
export type ResearchEvent = {id: string; title: string; evidenceIds: string[]; firstSeen: string; lastSeen: string; revisions: {evidenceId: string; at: string; change: "new" | "update" | "duplicate"}[]};
export type MetricSnapshot = {id: string; seriesId: string; evidenceId: string; title: string; url: string; region: string; at: string; name: string; unit: string; period: string; cadence?: string; value: string; numeric: number | null};
function sameText(a: string, b: string) {
  const x = normalized(a), y = normalized(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 120) return false;
  const shingles = (s: string) => new Set(Array.from({length: s.length - 11}, (_, i) => s.slice(i, i + 12)));
  const left = shingles(x), right = shingles(y);
  return [...left].filter(s => right.has(s)).length / Math.min(left.size, right.size) >= .85;
}
export function recordHistory(db: Store, evidence: Evidence, observedAt = evidence.collectedAt) {
  const previous = db.list<Evidence>("evidence");
  const events = db.list<ResearchEvent>("events");
  const event = events.find(event => event.evidenceIds.some(id => {
    const old = previous.find(e => e.id === id);
    return old && (old.url === evidence.url || normalized(old.title) === normalized(evidence.title) || sameText(old.excerpt, evidence.excerpt));
  }));
  const record: ResearchEvent = event || {id: "event-" + digest(evidence.url), title: evidence.title, evidenceIds: [], firstSeen: observedAt, lastSeen: observedAt, revisions: []};
  const duplicate = record.evidenceIds.some(id => { const old = previous.find(e => e.id === id); return old && sameText(old.excerpt, evidence.excerpt) && JSON.stringify(old.metric) === JSON.stringify(evidence.metric); });
  if (!record.evidenceIds.includes(evidence.id)) {
    record.revisions.push({evidenceId: evidence.id, at: observedAt, change: !record.evidenceIds.length ? "new" : duplicate ? "duplicate" : "update"});
    record.evidenceIds.push(evidence.id);
  }
  record.lastSeen = [record.lastSeen, observedAt].sort().at(-1)!;
  db.put("events", record.id, record);
  if (evidence.metric) {
    const m = evidence.metric;
    const seriesId = digest([evidence.url, normalized(evidence.title), evidence.region, m.name, m.unit, m.cadence || "unknown"].join("|"));
    // Same source period is a correction of one observation, not another sample.
    const id = digest(seriesId + "|" + m.period);
    const value = m.value.trim();
    const numeric = /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
    db.put<MetricSnapshot>("metrics", id, {id, seriesId, evidenceId: evidence.id, title: evidence.title, url: evidence.url, region: evidence.region, at: observedAt, ...m, numeric});
  }
  return record;
}
export function metricComparison(history: MetricSnapshot[], current: MetricSnapshot) {
  if (!current.region.trim() || /^(未知|unknown|未说明)$/i.test(current.region))
    return {percent:null, reason:"地域未知，不能确认两次观测属于同一市场。"};
  if (/排名|rank|position|榜单名次/i.test(current.name + " " + current.unit))
    return {percent:null, reason:"排名是顺序指标，名次差不能换算为热度或需求增长率。"};
  const prior = history.filter(s => s.seriesId === current.seriesId && s.period !== current.period && Date.parse(s.period) < Date.parse(current.period))
    .sort((a,b) => Date.parse(b.period) - Date.parse(a.period))[0];
  if (!prior || !current.cadence || current.numeric === null || prior.numeric === null || prior.numeric <= 0)
    return { percent: null, reason: "缺少两期同口径精确数值，或基数为零；不计算增速。" };
  const gap = Date.parse(current.period) - Date.parse(prior.period);
  const expected = current.cadence === "day" ? 86400000 : current.cadence === "week" ? 7 * 86400000 : null;
  if (!Number.isFinite(gap) || gap <= 0 || (expected && gap !== expected))
    return {percent: null, reason: "指标时间窗口不连续，不能作为相邻期增长率。"};
  return {percent: Math.round((current.numeric - prior.numeric) / prior.numeric * 10000) / 100, reason: `${prior.period} → ${current.period}；仅表示 ${current.name} 的变化，不等于市场需求增长。`};
}
