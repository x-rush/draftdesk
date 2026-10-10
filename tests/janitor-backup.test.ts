// 存储根治批守护：janitor 每日备份通道——VACUUM INTO 快照落盘、内容可开、保留 14 份。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../core/store";
import { runDailyBackup, runJanitor } from "../core/janitor";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("每日备份：快照落盘可开且含集合；保留最近 14 份", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backup-"));
  const backupDir = path.join(dir, "backups");
  const previous = process.env.DRAFTDESK_BACKUP_DIR;
  process.env.DRAFTDESK_BACKUP_DIR = backupDir;
  try {
    const db = new Store(dir);
    db.put("seen-terms", "备份验证词", { id: "备份验证词", term: "备份验证词", status: "new", observations: 1 });
    const result = runDailyBackup(db);
    assert.ok("file" in result && "bytes" in result, "应产出备份描述");
    if (!("file" in result)) throw new Error("unreachable");
    assert.ok(result.bytes > 0);
    assert.ok(existsSync(result.file));
    // 快照可独立打开且包含刚写入的行
    const snapshot = new DatabaseSync(result.file, { readOnly: true });
    const row = snapshot.prepare("SELECT body FROM documents WHERE collection='seen-terms' AND id='备份验证词'").get();
    assert.ok(row, "备份快照应包含写入后的行");
    snapshot.close();
    // 保留策略：预置 15 份旧快照（含今日文件共 16）→ 保留 14 份
    const date = new Date().toISOString().slice(0, 10);
    for (let i = 1; i <= 15; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      writeFileSync(path.join(backupDir, `draftdesk-${d}.sqlite`), "stale");
    }
    runDailyBackup(db);
    const kept = readdirSync(backupDir).filter((f) => /^draftdesk-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
    assert.equal(kept.length, 14, `应保留 14 份，实际 ${kept.length}`);
    assert.ok(!existsSync(path.join(backupDir, `draftdesk-${date}.sqlite`)) === false);
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_BACKUP_DIR;
    else process.env.DRAFTDESK_BACKUP_DIR = previous;
    cleanup(dir);
  }
});

test("runJanitor 集成：external 模式也产出备份并记入返回值", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backup-janitor-"));
  const backupDir = path.join(dir, "backups");
  const previous = process.env.DRAFTDESK_BACKUP_DIR;
  process.env.DRAFTDESK_BACKUP_DIR = backupDir;
  try {
    const db = new Store(dir);
    db.put("plans", "p1", { id: "p1", name: "策略", scheduleEnabled: true, dailyTime: "01:00", sourceIds: [], kind: "editorial", maxEvidence: 10, maxQueries: 4, maxModelCalls: 8, maxTokens: 400000 });
    const result = runJanitor(db);
    assert.ok(result, "应执行");
    assert.ok(result.backup && "file" in (result.backup as any), "external 模式返回应带 backup");
    assert.ok(existsSync((result.backup as any).file));
    db.del("meta", "janitor");
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_BACKUP_DIR;
    else process.env.DRAFTDESK_BACKUP_DIR = previous;
    cleanup(dir);
  }
});
