// R10.38 性能下推验收：生成列+索引基座 + 高频路径 SQL 下推。
// ①基准：2 万行词库下 pushdown vs 全量 parse（收益随规模放大，断言宽松阈值防 flaky）；
// ②EXPLAIN QUERY PLAN 索引命中断言——DDL 将来改动若让查询退化全扫，这里响亮报错；
// ③语义等价：窗口/未判/strong 候选的下推结果与全量过滤一致（含 NULL 字段行）；
// ④KV 构造幂等（生成列 ALTER 与索引 IF NOT EXISTS 重复启动不炸）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1038-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { store } = await import("../core/store");
const { KV } = await import("../core/store/kv");

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.38 ①：基准——2 万行词库 relevance 过滤，下推显著快于全量 parse", () => {
  const db = store();
  // 灌 20000 行：strong 10% / weak 20% / 未判 20% / off 50%
  const batch = [] as Array<[string, any]>;
  for (let i = 0; i < 20000; i++) {
    const relevance = i % 10 === 0 ? "strong" : i % 5 === 0 ? "weak" : i % 5 === 1 ? undefined : "off";
    batch.push(["t" + i, { id: "t" + i, term: "词" + i, relevance, status: i % 97 === 0 ? "archived" : "active", createdAt: new Date().toISOString() }]);
  }
  db.kv.transaction(() => { for (const [id, body] of batch) db.kv.put("seen-terms", id, body); });
  const t0 = process.hrtime.bigint();
  const full = db.list<any>("seen-terms").filter((t) => t.status !== "archived" && t.relevance === "strong");
  const fullMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const pushed = db.kv.selectWhere<any>("seen-terms", `"relevance" = 'strong'`).map((r) => r.body).filter((t) => t.status !== "archived");
  const pushMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(pushed.length, full.length, "结果集一致");
  console.log(`[r1038 基准] 全量 parse+滤: ${fullMs.toFixed(1)}ms | 索引下推: ${pushMs.toFixed(1)}ms | 行数 ${full.length}`);
  assert.ok(pushMs < fullMs * 0.6, `下推应明显更快（全量 ${fullMs.toFixed(1)}ms vs 下推 ${pushMs.toFixed(1)}ms）`);
});

test("R10.38 ②：EXPLAIN 断言索引命中（防 DDL 演进悄悄退化全扫）", () => {
  const db = store();
  const plans = (sql: string) => (db.db.prepare("EXPLAIN QUERY PLAN " + sql).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  const withIdx = plans(`SELECT id, body FROM documents WHERE collection='seen-terms' AND "relevance"='strong'`);
  assert.match(withIdx, /USING INDEX idx_doc_relevance/, "relevance 查询命中生成列索引: " + withIdx);
  const created = plans(`SELECT id, body FROM documents WHERE collection='outlines' AND "createdAt">='2026-01-01'`);
  assert.match(created, /USING INDEX idx_doc_created/, "createdAt 范围查命中索引: " + created);
  const clu = plans(`SELECT id, body FROM documents WHERE collection='outlines' AND "clusterId"='clu-x'`);
  assert.match(clu, /USING INDEX idx_doc_cluster/, "clusterId 点查命中索引: " + clu);
  const atOrder = plans(`SELECT body FROM documents WHERE collection='discovery' ORDER BY "at" DESC LIMIT 60`);
  assert.match(atOrder, /USING INDEX idx_doc_at/, "discovery at 排序命中索引: " + atOrder);
});

test("R10.38 ③：语义等价——下推候选与全量过滤结果一致（含 NULL relevance/缺失 createdAt 行）", () => {
  const db = store();
  db.put("seen-terms", "s-null", { id: "s-null", term: "未判词", status: "active" }); // relevance 缺失=未判
  db.put("seen-terms", "s-off", { id: "s-off", term: "已判 off", relevance: "off", status: "active" });
  const pushed = new Set(db.kv.selectWhere<any>("seen-terms", `("relevance" IS NULL OR "relevance" NOT IN ('strong','weak','off'))`).map((r) => r.id));
  const full = new Set(db.list<any>("seen-terms").filter((t) => t.status !== "archived" && t.relevance !== "strong" && t.relevance !== "weak" && t.relevance !== "off").map((t) => t.id));
  // 全量口径排除 archived，下推后未滤 status——补对齐后再比（seen-extract 实际用法带 status 精滤）
  const pushedAligned = new Set(db.kv.selectWhere<any>("seen-terms", `("relevance" IS NULL OR "relevance" NOT IN ('strong','weak','off'))`).map((r) => r.body).filter((t) => t.status !== "archived").map((t) => t.id));
  assert.ok(pushedAligned.has("s-null"), "缺失 relevance 计入未判");
  assert.ok(!pushedAligned.has("s-off"), "已判 off 不进未判池");
  for (const id of full) assert.ok(pushedAligned.has(id), "全量命中 " + id + " 在下推集合内");
  for (const id of pushedAligned) assert.ok(full.has(id), "下推命中 " + id + " 在全量集合内");
  void pushed;
});

test("R10.38 ④：KV 构造幂等——生成列/索引重复建不炸（重启路径）", async () => {
  const sub = mkdtempSync(path.join(tmpdir(), "dd-kv-idem-"));
  try {
    const kv1 = new KV(sub);
    kv1.put("outlines", "o1", { id: "o1", decision: "pending", createdAt: new Date().toISOString() });
    kv1.close();
    const kv2 = new KV(sub); // 二次构造=重启：ALTER 检查跳过 + IF NOT EXISTS 索引
    assert.equal(kv2.get<any>("outlines", "o1").id, "o1");
    kv2.close();
  } finally {
    // Windows 下 SQLite 句柄释放有延迟，rmSync 可能 EPERM——重试一次，仍失败留给 OS 临时目录清理
    try { rmSync(sub, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 150)); try { rmSync(sub, { recursive: true, force: true }); } catch { /* 临时目录，OS 兜底 */ } }
  }
});
