// R10.24：external 三重裂缝门控（analyze/jobs skipped + 按钮已隐藏）+ planMode 兜底 collect
// + 向量事件线（R10.23）无 REDIS_URL 时全链降级 no-op——主链（组写回/大纲写入）不受影响。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1024-"));
delete process.env.REDIS_URL; // 向量线降级路径必须在未配置 Redis 的环境下验证
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { searchVectors, findSemanticDuplicate, indexEventGroups } = await import("../core/vector-store");

const request = (route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) => {
  const [pathPart, query] = route.split("?");
  return handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || methodOf(data),
      headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
};
function methodOf(data?: unknown) { return data === undefined ? "GET" : data === null ? "PATCH" : "POST"; }
async function jsonReq(route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) {
  const r = await request(route, data, headers, method);
  return { status: r.status, body: await r.json() };
}

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.24-1① external 默认：POST plans/:id/analyze 返回 skipped，不入队不跑内置链", async () => {
  const db = store();
  assert.equal(db.get("config", "consumerMode") || "external", "external");
  const r = await jsonReq("plans/p-any/analyze", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, true);
  assert.match(String(r.body.reason), /外部 Agent/);
  assert.equal(db.list<any>("jobs").length, 0);
});

test("R10.24-1② external：POST /jobs 同门控（建议/重试入口都封死）", async () => {
  const r = await jsonReq("jobs", { planId: "p-any" });
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, true);
});

test("R10.24-1③ builtin 模式放行：门控后走到既有校验（不存在的策略 404 而非 skipped）", async () => {
  const db = store();
  db.put("config", "consumerMode", "builtin");
  const r = await jsonReq("plans/p-missing/analyze", {});
  assert.equal(r.status, 404);
  db.put("config", "consumerMode", "external");
});

test("R10.24-1③ planMode 路由读实值（活库矫正为 collect 后 GET 即 collect，不吞不谎）", async () => {
  const db = store();
  db.put("config", "planMode", "collect");
  const r = await jsonReq("planMode");
  assert.equal(r.status, 200);
  assert.equal(r.body.planMode || r.body, "collect");
});

test("R10.24-5 向量线降级：无 REDIS_URL 时检索/去重/索引全部 no-op", async () => {
  const db = store();
  assert.equal(await searchVectors(db, "eventline", "测试文本"), null);
  // R10.27-F：降级语义显式化——findSemanticDuplicate 无 Redis 返回 {degraded:true}（写入方打标记用）
  assert.deepEqual(await findSemanticDuplicate(db, "任何标题"), { degraded: true });
  await indexEventGroups(db, "j1", [{ id: "g1", title: "t" }]); // 不抛即通过
});

test("R10.24-5 向量线降级：agent/vectors/search 返回 degraded 空结果而非报错", async () => {
  const db = store();
  const token = db.createConnection("r10向量作者", ["suggest", "read"]).token;
  const r = await jsonReq("agent/vectors/search", { index: "eventline", text: "AI播放器" }, { Authorization: "Bearer " + token });
  assert.equal(r.status, 200);
  assert.equal(r.body.degraded, true);
  assert.deepEqual(r.body.hits, []);
  const bad = await jsonReq("agent/vectors/search", { index: "nope", text: "x" }, { Authorization: "Bearer " + token });
  assert.equal(bad.status, 400);
});

test("R10.24-5 向量线降级：组写回与大纲写入主链不受影响（照常落库）", async () => {
  const db = store();
  const token = db.createConnection("r10主链作者", ["suggest", "read"]).token;
  const auth = { Authorization: "Bearer " + token };
  db.put("discovery", "collectall-vt", { jobId: "collectall-vt", at: new Date().toISOString(), planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [] });
  const g = await jsonReq("agent/triage/groups", { jobId: "collectall-vt", groups: [{ id: "g1", title: "AI播放器爆火", attention: "strong" }] }, auth, "PUT");
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const c = await jsonReq("agent/clusters", { topic: "向量线主链簇", memberIds: [], kind: "news" }, auth, "PUT");
  assert.equal(c.status, 201);
  const o = await jsonReq("agent/outlines", { clusterId: c.body.id, platform: "gzh", contentType: "长文", title: "向量线主链大纲标题" }, auth, "PUT");
  assert.equal(o.status, 201, JSON.stringify(o.body));
});
