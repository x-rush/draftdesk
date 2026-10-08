import type { Store } from "./store";
import { urlKey } from "./hotspots";

// 数据保留策略（消费接口文档 §6）：worker 每日跑一次 janitor，把超过窗口且未被引用的
// 原始条目自动置为已消费（reason=outdated，consumedBy=janitor）。只加状态层不删除记录；
// 被任何产物引用的证据永不自动消费；同一天内只跑一次（meta 节流）。
export const RETENTION = {
  hotspots: { autoConsumeOlderThanDays: 7 },
  evidence: { autoConsumeOlderThanDays: 30 },
};

export function runJanitor(db: Store): { day: string; at: string; hotspots: number; evidence: number; skipped?: boolean } | null {
  const stamp = new Date().toISOString();
  const today = stamp.slice(0, 10);
  if (db.get<any>("meta", "janitor")?.day === today) return null;
  // consumerMode=external：消费与回收由外部 Agent 负责，内置 janitor 停用（§4.2 干净分解）。
  if ((db.get<any>("config", "consumerMode") || "external") === "external") {
    db.put("meta", "janitor", { day: today, at: stamp, hotspots: 0, evidence: 0, skipped: true });
    return { day: today, at: stamp, hotspots: 0, evidence: 0, skipped: true };
  }
  const consumed = new Map<string, any>();
  for (const c of db.list<any>("consumption")) consumed.set(`${c.target}:${c.identity}`, c);
  // ① 热榜：最近一次观测早于窗口的 url。热榜没有产物反向引用（产物挂证据，不挂热榜 url），无需引用保护。
  const hotspotCutoff = Date.now() - RETENTION.hotspots.autoConsumeOlderThanDays * 86400000;
  const lastSeen = new Map<string, string>();
  for (const record of db.list<any>("discovery"))
    for (const candidate of record.candidates || []) {
      const key = urlKey(candidate.url);
      const seen = candidate.observedAt || record.at;
      const old = lastSeen.get(key);
      if (!old || seen > old) lastSeen.set(key, seen);
    }
  const hotspotIds: string[] = [];
  for (const [key, seen] of lastSeen)
    if (Date.parse(seen) < hotspotCutoff && !consumed.has(`hotspots:${key}`)) hotspotIds.push(key);
  // ② 证据：超过窗口且没有任何产物引用（evidenceIds 反查保护）。
  const referenced = new Set<string>();
  for (const artifact of db.list<any>("artifacts"))
    for (const id of artifact.evidenceIds || []) referenced.add(id);
  const evidenceCutoff = Date.now() - RETENTION.evidence.autoConsumeOlderThanDays * 86400000;
  const evidenceIds: string[] = [];
  for (const e of db.list<any>("evidence")) {
    if (referenced.has(e.id) || consumed.has(`evidence:${e.id}`)) continue;
    const at = Date.parse(e.collectedAt || "");
    if (Number.isFinite(at) && at < evidenceCutoff) evidenceIds.push(e.id);
  }
  db.consumeIdentities("hotspots", hotspotIds, "outdated", "janitor", undefined, false);
  db.consumeIdentities("evidence", evidenceIds, "outdated", "janitor", undefined, false);
  // 簇过期自动归档：window 结束日距今 > 14 天 → status=archived（不删除，审查台可筛）
  let clustersArchived = 0;
  const archiveCutoff = Date.now() - 14 * 86400000;
  for (const c of db.list<any>("clusters")) {
    if (c.status === "archived") continue;
    if (!c.window) continue;
    const endMatch = c.window.match(/~s*(d{4}-d{2}-d{2})/);
    if (!endMatch) continue;
    const endDate = Date.parse(endMatch[1]);
    if (Number.isFinite(endDate) && endDate < archiveCutoff) {
      db.put("clusters", c.id, { ...c, status: "archived" });
      clustersArchived++;
    }
  }
  const result = { day: today, at: stamp, hotspots: hotspotIds.length, evidence: evidenceIds.length, clustersArchived };
  db.put("meta", "janitor", result);
  return result;
}
