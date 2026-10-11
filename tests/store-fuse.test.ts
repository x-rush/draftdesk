// 挂载期保险丝批 8 守护：迁移前快照（保留 3 份）、每日 integrity_check、
// collections-report 快照与「昨日 vs 今日」读路由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { snapshotFuse } from "../core/store/migrations";
import { integrityCheck, snapshotCollectionsReport, runJanitor } from "../core/janitor";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("快照保险丝：VACUUM INTO 到 volume snapshots/，保留最近 3 份", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-fuse-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("seen-terms", "x", { id: "x", term: "x", status: "new", observations: 1, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    const ctx = { kv: (db as any).kv, directory: dir };
    snapshotFuse(ctx, ["seen-term-region-backfill-v1"]);
    const snapDir = path.join(dir, "snapshots");
    let files = readdirSync(snapDir).filter((f) => /^fuse-.*\.sqlite$/.test(f));
    assert.equal(files.length, 1);
    assert.ok(statSync(path.join(snapDir, files[0])).size > 0, "快照非空");
    for (let i = 0; i < 4; i++) snapshotFuse(ctx, ["m" + i]);
    files = readdirSync(snapDir).filter((f) => /^fuse-.*\.sqlite$/.test(f));
    assert.equal(files.length, 3, "只保留最近 3 份");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("janitor：integrity_check=ok、collections-report 快照与 14 天清理、元数据记录", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-report-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    assert.equal(integrityCheck(db), "ok");
    db.put("seen-terms", "x", { id: "x", term: "x", status: "new", observations: 1, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    const counts = snapshotCollectionsReport(db);
    assert.ok(counts["seen-terms"] >= 1);
    const day = (o: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() - o * 86400000));
    assert.ok(db.get<any>("collections-report", day(0)), "今日快照应存在");
    // 15 天前的旧快照应被清理
    db.put("collections-report", day(15), { id: day(15), at: "", counts: {} });
    snapshotCollectionsReport(db);
    assert.equal(db.get("collections-report", day(15)), undefined, "超 14 天快照清理");
    // runJanitor 全链：元数据带 integrity 与 backup
    const report = runJanitor(db);
    assert.ok(report, "首跑应执行");
    assert.equal(report!.integrity, "ok");
    assert.ok(db.get<any>("collections-report", day(0)), "janitor 内部应再写今日快照");
    assert.equal(runJanitor(db), null, "同日幂等");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
