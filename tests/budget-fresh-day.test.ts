// 预算域回归（用户实弹抓到）：全新库（无任何 budgets 行）第一次 reserve
// 必须成功建行——生产 schema 带 used NOT NULL 而迁移/INSERT 停在两列老结构，
// 雕刻重建库与 fresh clone 的每个新一天首次模型调用都会 NOT NULL 炸。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("空 budgets 表首次 reserve 成功建行 used=0；重复 reserve 累加", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-budget-fresh-"));
  try {
    const db = new Store(dir);
    db.reserve(1234);
    const row = db.db.prepare("SELECT day,reserved,used FROM budgets WHERE reserved=1234").get() as any;
    assert.ok(row, "reserve 后应有当日行");
    assert.equal(row.used, 0);
    db.reserve(10);
    const total = (db.db.prepare("SELECT SUM(reserved) s FROM budgets").get() as any).s;
    assert.equal(total, 1244);
    assert.ok(db.dayBudget().reserved >= 1244);
  } finally { cleanup(dir); }
});
