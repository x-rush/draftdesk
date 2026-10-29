import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store";
import { shanghaiDayOf } from "./tick-guard";
import { urlKey } from "./hotspots";

// 数据保留策略（消费接口文档 §6）：worker 每日跑一次 janitor，把超过窗口且未被引用的
// 原始条目自动置为已消费（reason=outdated，consumedBy=janitor）。只加状态层不删除记录；
// 被任何产物引用的证据永不自动消费；同一天内只跑一次（meta 节流）。
export const RETENTION = {
  hotspots: { autoConsumeOlderThanDays: 7 },
  evidence: { autoConsumeOlderThanDays: 30 },
  // 热词词库（热词掘金 v3）：archived 超 90 天清理出库，活跃词库目标 5000-8000 条量级。
  seenTerms: { purgeArchivedAfterDays: 90 },
  // 模型调用台账（成本纪律批 7）：看板只看近 7 天，留一个月余量后清理。
  modelMetrics: { purgeAfterDays: 35 },
  // 毒标题台账（第三轮 4）：诊断数据留 30 天。
  toxicSamples: { purgeAfterDays: 30 },
  // 研究任务（R10.25-5④）：终态 job（completed/failed/cancelled）7 天后出库——
  // builtin 停摆后 jobs 无清理机制堆积（77 条全是历史终态）；external 模式也跑（与消费模式无关）。
  jobs: { purgeTerminalAfterDays: 7 },
  // 订单时效（R10.34-1 v2：老大拍板物理归档）：pending 大纲/产物满 7 天物理移入
  // *-archive（archivedAt+expiredReason），主集合删除——审查台零噪音，归档可查可恢复。
  orderExpire: { expirePendingAfterDays: 7 },
  // 采集批次（R10.34-3）：discovery 批次含候选快照（过程数据），超 30 天清理；
  // 产物（candidate-groups 组结构 / outlines / decisions / opportunities）不受影响。
  discovery: { purgeAfterDays: 30 },
};

export type JanitorBackup = { file: string; bytes: number } | { skipped: string };
export function runJanitor(db: Store): { day: string; at: string; hotspots: number; evidence: number; clustersArchived?: number; seenPurged?: number; metricsPurged?: number; jobsPurged?: number; auditPurged?: number; legacyPurged?: number; ordersArchived?: { outlines: number; artifacts: number }; discoveryPurged?: number; integrity?: string; backup?: JanitorBackup; skipped?: boolean } | null {
  const stamp = new Date().toISOString();
  // R10.27-F：每日节流键统一上海日（原 UTC 日与 snapshotCollectionsReport 的上海日口径分裂，
  // 凌晨窗口可能双写/漏写 collections-report）
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  if (db.get<any>("meta", "janitor")?.day === today) return null;
  // R10.27-F：external 模式下本函数仍执行采集侧清理（seen/metrics/jobs/budget-audit/meta 键族
  // + 完整性自检 + 快照 + 备份）；仅 hotspots/evidence 回收与簇归档（下方 builtin 段）停用——由外部 Agent 负责。
  const seenPurged = purgeArchivedSeenTerms(db);
  const metricsPurged = purgeOldModelMetrics(db);
  const jobsPurged = purgeTerminalJobs(db);
  const auditPurged = purgeBudgetAuditKeys(db);
  const legacyPurged = purgeLegacyIntake(db);
  const ordersArchived = archiveExpiredOrders(db);
  const discoveryPurged = purgeOldDiscovery(db);
  // 挂载期保险丝批 8：每日库完整性自检 + 全集合行数快照（设置页「昨日 vs 今日」异动看板）
  const integrity = integrityCheck(db);
  snapshotCollectionsReport(db);
  // 备份通道（存储根治批）：volume 内的库每日快照到 bind mount backups/；失败不阻塞主流程。
  let backup: JanitorBackup;
  try { backup = runDailyBackup(db); }
  catch (e) { backup = { skipped: e instanceof Error ? e.message : String(e) }; }
  if ((db.get<any>("config", "consumerMode") || "external") === "external") {
    db.put("meta", "janitor", { day: today, at: stamp, hotspots: 0, evidence: 0, seenPurged, metricsPurged, jobsPurged, auditPurged, legacyPurged, ordersArchived, discoveryPurged, integrity, backup, skipped: true });
    return { day: today, at: stamp, hotspots: 0, evidence: 0, seenPurged, metricsPurged, jobsPurged, auditPurged, legacyPurged, ordersArchived, discoveryPurged, integrity, backup, skipped: true };
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
  const result = { day: today, at: stamp, hotspots: hotspotIds.length, evidence: evidenceIds.length, clustersArchived, seenPurged, metricsPurged, jobsPurged, auditPurged, legacyPurged, ordersArchived, discoveryPurged, integrity, backup };
  db.put("meta", "janitor", result);
  return result;
}

// 每日库快照（存储根治批）：VACUUM INTO 导出一致性好（含 wal 合并），文件名带日期；
// 目录为 bind mount（纯追加写、无文件扩展，无截断风险）；保留最近 14 份。回滚路径：
// compose 改回 bind mount 后用最新快照覆盖 data/draftdesk.sqlite 即可。
export function runDailyBackup(db: Store): JanitorBackup {
  // R10.34-4 P0：备份目录从 Store 库目录推导（<库目录>/../backups）——原 cwd 兜底让
  // 测试进程（cwd=项目根）把空库快照写进真实 backups/，按日期名覆盖当天真实备份，
  // 灾难恢复实质归零。DRAFTDESK_BACKUP_DIR 保留显式覆盖（compose 设置 /app/backups）。
  const dir = process.env.DRAFTDESK_BACKUP_DIR || path.join(path.dirname(db.directory), "backups");
  mkdirSync(dir, { recursive: true });
  const date = shanghaiDayOf(); // R10.31：上海日（每日一份备份的翻界口径）
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

// 模型调用台账清理（成本纪律批 7）：超窗口的按日台账直接删除（id=YYYY-MM-DD 词典序可比）。
export function purgeOldModelMetrics(db: Store): number {
  const cutoff = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date(Date.now() - RETENTION.modelMetrics.purgeAfterDays * 86400000));
  let purged = 0;
  for (const m of db.list<any>("model-metrics")) {
    if (String(m.id) < cutoff) { db.del("model-metrics", m.id); purged++; }
  }
  const toxicCutoff = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date(Date.now() - RETENTION.toxicSamples.purgeAfterDays * 86400000));
  for (const t of db.list<any>("toxic-samples")) {
    if (String(t.id).slice(0, 10) < toxicCutoff) { db.del("toxic-samples", t.id); purged++; }
  }
  return purged;
}

// 终态任务出库（R10.25-5④ + R10.26-4④）：completed/failed/cancelled 超 7 天直接删；
// 同键级联清四个伴生集合（job-context/job-draft/job-validation/job-verification——
// 删 job 不删伴生会成永久孤儿，库与备份单调膨胀）。
export function purgeTerminalJobs(db: Store): number {
  const cutoff = Date.now() - RETENTION.jobs.purgeTerminalAfterDays * 86400000;
  let purged = 0;
  for (const j of db.list<any>("jobs")) {
    if (!["completed", "failed", "cancelled"].includes(j.state)) continue;
    const at = Date.parse(j.finishedAt || j.updatedAt || "");
    if (Number.isFinite(at) && at < cutoff) {
      db.del("jobs", j.id);
      db.del("job-context", j.id);
      db.del("job-draft", j.id);
      db.del("job-validation", j.id);
      db.del("job-verification", j.id);
      purged++;
    }
  }
  return purged;
}

// 订单时效（R10.34-1 v2）：pending 大纲/产物满 7 天（上海日日差）→ 物理移入
// outlines-archive / artifacts-archive（保留原记录 + archivedAt + expiredReason），主集合删除。
// decisionsQueue 只扫主集合三源，归档自然零显示；归档集合可查可手动恢复。
// 不做软过期（rejected 混在已拍里）——数据设计终版：审查台只见活跃窗口。
export function archiveExpiredOrders(db: Store, nowDate: Date = new Date()): { outlines: number; artifacts: number } {
  const todayMs = Date.parse(shanghaiDayOf(nowDate) + "T00:00:00+08:00");
  const cutoff = RETENTION.orderExpire.expirePendingAfterDays;
  const out = { outlines: 0, artifacts: 0 };
  for (const [collection, archive] of [["outlines", "outlines-archive"], ["artifacts", "artifacts-archive"]] as const) {
    // db.list 只回 body 拿不到键名（历史坑）——SELECT 直取 id
    const rows = db.db.prepare(`SELECT id, body FROM documents WHERE collection='${collection}'`).all() as Array<{ id: string; body: string }>;
    for (const r of rows) {
      const o = JSON.parse(r.body) as { decision?: string; createdAt?: string };
      if (o.decision !== "pending") continue;
      const createdMs = Date.parse(String(o.createdAt || "").slice(0, 10) + "T00:00:00+08:00");
      if (!Number.isFinite(createdMs)) continue;
      if (Math.floor((todayMs - createdMs) / 86400000) < cutoff) continue;
      db.put(archive, r.id, { ...o, archivedAt: nowDate.toISOString(), expiredReason: "expired-7d" });
      db.del(collection, r.id);
      out[collection === "outlines" ? "outlines" : "artifacts"]++;
    }
  }
  return out;
}

// 采集批次清理（R10.34-3）：discovery 批次（含候选快照=过程数据）超 30 天出库。
// 组结构（candidate-groups）/大纲/decisions/机会卡是产物，独立集合，不受影响。
export function purgeOldDiscovery(db: Store, nowDate: Date = new Date()): number {
  const todayMs = Date.parse(shanghaiDayOf(nowDate) + "T00:00:00+08:00");
  const rows = db.db.prepare("SELECT id, body FROM documents WHERE collection='discovery'").all() as Array<{ id: string; body: string }>;
  let purged = 0;
  for (const r of rows) {
    const d = JSON.parse(r.body) as { at?: string };
    const at = String(d.at || "").slice(0, 10);
    const atMs = Date.parse(at + "T00:00:00+08:00");
    if (!Number.isFinite(atMs)) continue;
    const ageDays = Math.floor((todayMs - atMs) / 86400000);
    if (ageDays >= RETENTION.discovery.purgeAfterDays) { db.del("discovery", r.id); purged++; }
  }
  return purged;
}

// legacy 迁入清理（R10.27-C1）：POST /migrate-local 的 legacy 集合与脚本 legacy-research——
// 一次性迁移 decision-layer-v1 已转正存量，后续再迁入的 30 天后出库（无 reader，防永久滞留）
export function purgeLegacyIntake(db: Store): number {
  // R10.29-2：30 天偏移（原 cutoff=今天→迁入次日即删）
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  // R10.30-C：kv.list 只回 body 拿不到键名（body 无 id/term 字段→原实现永远删空键、
  // 计数虚报，R10.29-2 因此白修）——LIKE 直查 documents 表取真键（同 purgeBudgetAuditKeys 先例）
  let purged = 0;
  for (const c of ["legacy", "legacy-research"]) {
    const rows = db.db.prepare("SELECT id, body FROM documents WHERE collection=?").all(c) as Array<{ id: string; body: string }>;
    for (const r of rows) {
      const doc = JSON.parse(r.body) as { receivedAt?: string; migratedAt?: string; createdAt?: string };
      const at = String(doc.receivedAt || doc.migratedAt || doc.createdAt || "").slice(0, 10);
      if (at && at < cutoff) { db.del(c, r.id); purged++; }
    }
  }
  return purged;
}

// budget-audit 小时键出库（R10.26-4⑤）：每小时 1 条无上限增长（9 天 221 条）——
// 清 7 天前小时键（键形如 budget-audit:YYYY-MM-DD, HH；kv.list 只回 body 拿不到键名，直接查 documents）
// R10.27-B#14 扩面：各 tick 的 done:日期 键族与 seo-api-used:*:日期 预算池键同窗清理。
export function purgeBudgetAuditKeys(db: Store): number {
  const cutoffDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date(Date.now() - 7 * 86400000));
  const patternDay = (id: string, prefixes: string[]) => {
    for (const p of prefixes) {
      if (!id.startsWith(p)) continue;
      const rest = id.slice(p.length);
      const m = rest.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    }
    return null;
  };
  const rows = db.db.prepare(
    "SELECT id FROM documents WHERE collection='meta' AND (id LIKE 'budget-audit:%' OR id LIKE '%-done:%' OR id LIKE 'seo-api-used:%' OR id LIKE 'triage-auto:%')",
  ).all() as Array<{ id: string }>;
  let purged = 0;
  for (const r of rows) {
    const day = r.id.startsWith("budget-audit:")
      ? r.id.slice("budget-audit:".length, "budget-audit:".length + 10)
      : r.id.startsWith("triage-auto:")
        ? r.id.slice("triage-auto:".length, "triage-auto:".length + 10)
        : patternDay(r.id, ["seo-api-used:tier:", "seo-api-used:metrics:", "seo-api-used:collect:"]) || patternDaySuffix(r.id);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay) { db.del("meta", r.id); purged++; }
  }
  return purged;
}
// X-done:YYYY-MM-DD 形态（done 在中间）：定位最后一个 done: 后的日期段
function patternDaySuffix(id: string): string | null {
  const m = id.match(/-done:(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// 库完整性自检（保险丝批 8）：每日 PRAGMA integrity_check；异常 console 告警并记录结果。
export function integrityCheck(db: Store): string {
  try {
    const row = db.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const result = String(row?.integrity_check ?? "unknown");
    if (result !== "ok") console.error(`[janitor] integrity_check 异常：${result}`);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[janitor] integrity_check 执行失败：${message}`);
    return "error: " + message;
  }
}

// 全集合行数快照（保险丝批 8）：documents 表 GROUP BY collection，
// 存 collections-report 集合（id=上海日期），供设置页「昨日 vs 今日」异动对比；保留 14 天。
export function snapshotCollectionsReport(db: Store): Record<string, number> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const rows = db.db.prepare("SELECT collection, COUNT(*) c FROM documents GROUP BY collection").all() as Array<{ collection: string; c: number }>;
  const counts: Record<string, number> = Object.fromEntries(rows.map((r) => [String(r.collection), Number(r.c)]));
  db.put("collections-report", today, { id: today, at: new Date().toISOString(), counts });
  const cutoff = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date(Date.now() - 14 * 86400000));
  for (const doc of db.list<any>("collections-report")) {
    if (String(doc.id) < cutoff) db.del("collections-report", doc.id);
  }
  return counts;
}
