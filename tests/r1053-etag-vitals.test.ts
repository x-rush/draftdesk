// R10.53 验收：①workspace ETag/304——KV 写版本+查询哈希联合校验器，数据无变化时
// 条件请求命中 304（4s 轮询下替代 416KB 全量重传），任一写翻新版本回 200；
// ②GET /agent/opsVitals（read scope）——小拾每日简报的磁盘/内存/备份水位数据源
// （容器共享内核：/proc/meminfo 即宿主真值）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1053-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const req = (route: string, headers: Record<string, string> = {}, method?: string) => {
  const [p, q] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + p + (q ? "?" + q : ""), {
    method: method || "GET",
    headers: { host: "127.0.0.1:5173", ...headers },
  }), p.split("/"));
};

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("R10.53①：workspace ETag——首发 200 带 ETag；同 ETag 条件请求 304；写入后同 ETag 失配回 200", async () => {
  const r1 = await req("workspace?view=decisions");
  assert.equal(r1.status, 200);
  const etag = r1.headers.get("etag");
  assert.ok(etag && etag.startsWith(`W/"ws-`), "弱校验器形态 W/\"ws-<写版本>-<查询哈希>\"");
  assert.equal(r1.headers.get("cache-control"), "no-cache", "存储+强制重验证");
  const body1 = await r1.json();
  assert.ok(body1.config !== undefined, "快照体完整");
  // 同版本 + 同查询 → 304 空体
  const r2 = await req("workspace?view=decisions", { "if-none-match": etag });
  assert.equal(r2.status, 304, "数据无变化命中 304");
  assert.equal(await r2.text(), "", "304 无响应体");
  assert.equal(r2.headers.get("etag"), etag, "304 必须回带 ETag");
  // 任一写入（KV put）→ 写版本翻新 → 旧 ETag 失配 → 200 全量
  store().put("outlines", "o-et", { id: "o-et", clusterId: "c", platform: "gzh", title: "翻新版本", decision: "pending", createdAt: new Date().toISOString() });
  const r3 = await req("workspace?view=decisions", { "if-none-match": etag });
  assert.equal(r3.status, 200, "写入后 ETag 失配回全量");
  const etag3 = r3.headers.get("etag");
  assert.ok(etag3, "新响应带 ETag");
  assert.notEqual(etag3, etag, "新 ETag");
  // 查询串不同 → 哈希不同 → 失配 200（分页/筛选变化不能误命中 304）
  const r4 = await req("workspace?view=decisions&page=2", { "if-none-match": etag3 });
  assert.equal(r4.status, 200, "不同查询串失配");
});

test("R10.53②：GET /agent/opsVitals——read 令牌 200 形状齐；无令牌 401", async () => {
  const noauth = await req("agent/opsVitals");
  assert.equal(noauth.status, 401);
  const db = store();
  const reader = db.createConnection("r1053 读", ["read"]);
  const r = await req("agent/opsVitals", { authorization: "Bearer " + reader.token });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.disk.usedPct > 0 && body.disk.usedPct < 100, "磁盘水位在合理区间");
  // Windows 测试环境无 /proc/meminfo → mem 为 null；Linux/生产为宿主真值
  assert.ok(body.mem === null || (body.mem.totalMb >= 512 && typeof body.mem.availMb === "number"), "内存水位（宿主真值或平台降级 null）");
  assert.ok(typeof body.serverUptimeDays === "number");
  // 本测试库未跑过日批 → backup 可为 null，但字段必须在
  assert.ok("backup" in body);
  assert.ok(body.generatedAt);
});
