import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store";
import { urlKey } from "./hotspots";

// 数据保留策略（消费接口文档 §6）：worker 每日跑一次 janitor，把超过窗口且未被引用的
// 原始条目自动置为已消费（reason=outdated，consumedBy=janitor）。只加状态层不删除记录；
// 被任何产物引用的证据永不自动消费；同一天内只跑一次（meta 节流）。
export const RETENTION = {
  hotspots: { autoConsumeOlderThanDays: 7 },
  evidence: { autoConsumeOlderThanDays: 30 },
  // 热词词库（热词掘金 v3）：archived 超 90 天清理出库，活跃词库目标 5000-8000 条量级。
  seenTerms: { purgeArchivedAfterDays: 90 },
};

export type JanitorBackup = { file: string; bytes: number } | { skipped: string };
export function runJanitor(db: Store): { day: string; at: string; hotspots: number; evidence: number; clustersArchived?: number; seenPurged?: number; backup?: JanitorBackup; skipped?: boolean } | null {
  const stamp = new Date().toISOString();
  const today = stamp.slice(0, 10);
  if (db.get<any>("meta", "janitor")?.day === today) return null;
  // consumerMode=external：消费与回收由外部 Agent 负责，内置 janitor 停用（§4.2 干净分解）。
  const seenPurged = purgeArchivedSeenTerms(db);
  // 备份通道（存储根治批）：volume 内的库每日快照到 bind mount backups/；失败不阻塞主流程。
  let backup: JanitorBackup;
  try { backup = runDailyBackup(db); }
  catch (e) { backup = { skipped: e instanceof Error ? e.message : String(e) }; }
  if ((db.get<any>("config", "consumerMode") || "external") === "external") {
    db.put("meta", "janitor", { day: today, at: stamp, hotspots: 0, evidence: 0, seenPurged, backup, skipped: true });
    return { day: today, at: stamp, hotspots: 0, evidence: 0, seenPurged, backup, skipped: true };
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
  // 簇归档：状态驱动而非日期驱动（v1 反馈 §① 修正）。
  // 归档条件 = 该簇全部 outline 的 decision 均为 published/rejected（无待做事项）。
  // 存在 pending/approved/drafting/deferred outline 的簇永不自动归档（安全阀）。
  // window 是素材采集时间范围，仅展示用，不参与归档判定。
  let clustersArchived = 0;
  for (const c of db.list<any>("clusters")) {
    if (c.status === "archived") continue;
    const outlines = db.list<any>("outlines").filter((o: any) => o.clusterId === c.id);
    if (!outlines.length) continue; // 无大纲的簇暂不归档（可能是新建的）
    const allDecided = outlines.every((o: any) => ["published", "rejected"].includes(o.decision));
    if (!allDecided) continue;
    db.put("clusters", c.id, { ...c, status: "archived" });
    clustersArchived++;
  }
  const result = { day: today, at: stamp, hotspots: hotspotIds.length, evidence: evidenceIds.length, clustersArchived, seenPurged, backup };
  db.put("meta", "janitor", result);
  return result;
}

// 每日库快照（存储根治批）：VACUUM INTO 导出一致性好（含 wal 合并），文件名带日期；
// 目录为 bind mount（纯追加写、无文件扩展，无截断风险）；保留最近 14 份。回滚路径：
// compose 改回 bind mount 后用最新快照覆盖 data/draftdesk.sqlite 即可。
export function runDailyBackup(db: Store): JanitorBackup {
  const dir = process.env.DRAFTDESK_BACKUP_DIR || path.join(process.cwd(), "backups");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `draftdesk-${date}.sqlite`);
  rmSync(file, { force: true });
  db.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const bytes = statSync(file).size;
  const all = readdirSync(dir).filter((f) => /^draftdesk-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) {
    try { rmSync(path.join(dir, old)); } catch { /* best effort */ }
  }
  return { file, bytes };
}
// seen-terms 归档出库：status=archived 且最后更新超窗口的直接删除（清理出库，非软删）。
export function purgeArchivedSeenTerms(db: Store): number {
  const cutoff = Date.now() - RETENTION.seenTerms.purgeArchivedAfterDays * 86400000;
  let purged = 0;
  for (const t of db.list<any>("seen-terms")) {
    if (t.status !== "archived") continue;
    const at = Date.parse(t.updatedAt || t.lastSeenAt || "");
    if (Number.isFinite(at) && at < cutoff) { db.del("seen-terms", t.id); purged++; }
  }
  if (purged) {
    // 出库后失效三区缓存（版本消费方在 core/seen-terms.ts）
    const prev = db.get<{ n: number }>("meta", "seen-terms-version");
    db.put("meta", "seen-terms-version", { n: (prev?.n ?? 0) + 1 });
  }
  return purged;
}
