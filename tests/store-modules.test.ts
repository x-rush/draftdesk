// PHASE 3 验收：store 拆分后的 digest 索引正确性与迁移幂等性。
// 索引语义：启动全量构建、createConnection 增量插入；撤销走路由侧 kv.put，
// 鉴权命中后重读现值核对 revoked——这里模拟该路径（直接 put revoked:true）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";

// Windows 下 SQLite 句柄释放有延迟，清理失败不掩盖断言结果（临时目录交给系统回收）
function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("digest 索引：100 连接鉴权全对、错令牌 401、撤销后立即失效、增量可见", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-digest-"));
  let db: Store | undefined, db2: Store | undefined;
  try {
    db = new Store(dir);
    const created = Array.from({ length: 100 }, (_, i) =>
      db!.createConnection(`压测-${i}`, i % 3 === 0 ? ["read", "suggest"] : ["submit"]),
    );
    // 全部令牌可用，且 scope 边界正确
    for (const [i, c] of created.entries()) {
      const scope = i % 3 === 0 ? "read" : "submit";
      const conn = db.authenticate(c.token, scope);
      assert.equal(conn.name, `压测-${i}`);
      assert.throws(() => db!.authenticate(c.token, "consume"), /权限/);
    }
    // 错令牌 401（不因连接变多而误命中）
    assert.throws(() => db.authenticate("dd_" + "0".repeat(64), "submit"), /无效或已撤销/);
    assert.throws(() => db.authenticate("", "submit"), /无效或已撤销/);
    // 撤销：模拟路由侧直接 put revoked（不经过 createConnection），索引必须立即失效
    const victim = created[42];
    const row = db.get<any>("connections", victim.id)!;
    db.put("connections", victim.id, { ...row, revoked: true });
    assert.throws(() => db.authenticate(victim.token, "submit"), /无效或已撤销/);
    // 其余令牌不受影响
    assert.equal(db.authenticate(created[0].token, "read").name, "压测-0");
    // createConnection 后新令牌立即可鉴权（增量维护）
    const fresh = db.createConnection("压测增量", ["read"]);
    assert.equal(db.authenticate(fresh.token, "read").name, "压测增量");
    db.close();
    // 启动重建：新实例全量重建索引，其余 99+1 个连接依旧全部可鉴权
    db2 = new Store(dir);
    for (const [i, c] of created.entries()) {
      if (i === 42) continue;
      assert.equal(db2.authenticate(c.token, i % 3 === 0 ? "read" : "submit").name, `压测-${i}`);
    }
  } finally {
    db?.close();
    db2?.close();
    cleanup(dir);
  }
});

test("迁移幂等：同目录二次打开不重跑、不重复种子、数据不变", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-migrations-"));
  let db1: Store | undefined, db2: Store | undefined, db3: Store | undefined;
  try {
    db1 = new Store(dir);
    const plans1 = db1.list<any>("plans").length;
    const sources1 = db1.list<any>("sources").length;
    const artifacts1 = db1.list<any>("artifacts").length;
    
    assert.equal(db1.get<any>("meta", "initialized")?.version, 2);
    assert.ok(db1.get("meta", "enrichment-sources-v1"), "最新迁移标记缺失");
    assert.ok(db1.get<any>("config", "persona"), "persona 未种子");
    db1.close();

    db2 = new Store(dir);
    assert.equal(db2.list<any>("plans").length, plans1, "策略被重复种子");
    assert.equal(db2.list<any>("sources").length, sources1, "来源被重复种子");
    assert.equal(db2.list<any>("artifacts").length, artifacts1, "产物被动过");
    db2.close();

    // 三开验证：迁移重跑不触碰既有行
    db3 = new Store(dir);
    assert.equal(db3.list<any>("plans").length, plans1);
    assert.equal(db3.list<any>("sources").length, sources1);
  } finally {
    db1?.close();
    db2?.close();
    db3?.close();
    cleanup(dir);
  }
});
