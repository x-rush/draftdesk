// R10.35 验收：一个选题一条大纲（老大 2026-10-30 拍板）
// —— 大纲不再按平台各写一份：platforms 标注适合投放的平台，recommendation 承载推荐建议；
//    审查台按选题身份（clusterId）聚合；存量多平台行可安全合并（不丢平台、不动已拍板）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1035-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { ensureTiebuhaoClones } = await import("../core/outline-draft");

const request = (route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) => {
  const [pathPart, query] = route.split("?");
  return handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || (data === undefined ? "GET" : data === null ? "PATCH" : "POST"),
      headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
};
async function jsonReq(route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) {
  const r = await request(route, data, headers, method);
  return { status: r.status, body: await r.json() };
}

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

function seedCluster(db: any, id: string) {
  db.put("clusters", id, { id, topic: "选题 " + id, memberIds: [], kind: "news", createdAt: new Date().toISOString() });
}

test("R10.35 ①：一条大纲可声明多个适合平台，platforms[0] 即主平台", async () => {
  const db = store();
  const token = db.createConnection("r1035作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-multi");
  const res = await jsonReq("agent/outlines", {
    clusterId: "clu-multi",
    platforms: ["gzh", "xhs-note", "threads"],
    recommendation: "主投公众号做深度论证，小红书出清单体，Threads 发英文短评引流",
    contentType: "长文",
    title: "一个选题，三个平台各取所需",
    keyPoints: ["平台差异写进推荐建议"],
  }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh", "xhs-note", "threads"]);
  assert.equal(res.body.platform, "gzh", "platform 退化为 platforms[0]");
  assert.equal(res.body.recommendation.includes("公众号做深度论证"), true);
  // 只有一条记录，不是三条
  const all = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-multi");
  assert.equal(all.length, 1, "一个选题只落一条大纲，不再按平台拆行");
});

test("R10.35 ②：平台值归一与去重（中文标签可传、重复平台去掉）", async () => {
  const db = store();
  const token = db.createConnection("r1035b作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-norm");
  const res = await jsonReq("agent/outlines", {
    clusterId: "clu-norm",
    platforms: ["公众号", "gzh", "小红书笔记"],
    contentType: "长文",
    title: "中文标签与重复值归一",
  }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh", "xhs-note"], "中文标签归一成键、重复平台去重保序");
  assert.equal(res.body.platform, "gzh");
});

test("R10.35 ③：未知平台 400，platforms 与 platform 全空 400", async () => {
  const db = store();
  const token = db.createConnection("r1035c作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-bad");
  const bad = await jsonReq("agent/outlines", { clusterId: "clu-bad", platforms: ["知乎"], contentType: "长文", title: "未知平台" }, auth, "PUT");
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /未知平台/);
  const empty = await jsonReq("agent/outlines", { clusterId: "clu-bad", contentType: "长文", title: "没给平台" }, auth, "PUT");
  assert.equal(empty.status, 400);
  assert.match(String(empty.body.error), /至少给一个/);
});

test("R10.35 ④：只给 platform 的老调用照常工作（platforms 收敛成 [platform]）", async () => {
  const db = store();
  const token = db.createConnection("r1035d作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-legacy");
  const res = await jsonReq("agent/outlines", { clusterId: "clu-legacy", platform: "gzh", contentType: "长文", title: "旧调用兼容" }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh"]);
  assert.equal(res.body.platform, "gzh");
  assert.equal(res.body.recommendation, undefined, "未给推荐建议时不留空字段");
});

test("R10.35 ⑤：审查台队列按选题聚合——platforms 透传、summary 来自 keyPoints", async () => {
  const db = store();
  const token = db.createConnection("r1035e作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-queue");
  await jsonReq("agent/outlines", {
    clusterId: "clu-queue", platforms: ["gzh", "xhs-note"], recommendation: "两平台分发",
    contentType: "长文", title: "审查台读口透传", keyPoints: ["要点一", "要点二"],
  }, auth, "PUT");
  // decisions 是 none-scope（仅 UI 会话可达），直接调 store 的队列构造验证透传字段
  const row = db.decisionsQueue("pending").find((r: any) => r.clusterId === "clu-queue");
  assert.ok(row, "队列里能找到该选题");
  assert.deepEqual(row.platforms, ["gzh", "xhs-note"], "platforms 全集透传（前端据此渲染适合平台徽章）");
  assert.equal(row.platform, "gzh");
  assert.equal(row.recommendation, "两平台分发");
  assert.equal(row.summary, "要点一；要点二");
});

test("R10.35 ⑥：资讯类选题补挂贴图号 = 补平台而非克隆新行", () => {
  const db = store();
  seedCluster(db, "clu-tbh");
  const stamp = new Date().toISOString();
  db.put("outlines", "out-tbh-new", {
    id: "out-tbh-new", clusterId: "clu-tbh", platform: "gzh", platforms: ["gzh"],
    category: "news", contentType: "长文", title: "资讯类选题", outline: [], keyPoints: [],
    evidenceRefs: [], decision: "pending", createdAt: stamp,
  });
  const n = ensureTiebuhaoClones(db);
  assert.ok(n >= 1, "有动作");
  const rows = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh");
  assert.equal(rows.length, 1, "新模型下不克隆新行");
  assert.deepEqual(rows[0].platforms, ["gzh", "tiebuhao"], "贴图号补进适合平台");
  // 幂等：再跑一次不再补
  const before = rows[0].platforms.length;
  ensureTiebuhaoClones(db);
  const after2 = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh")[0];
  assert.equal(after2.platforms.length, before, "重复运行幂等");
});

test("R10.35 ⑦：存量老数据（无 platforms）仍走克隆路径，不破坏既有语义", () => {
  const db = store();
  seedCluster(db, "clu-tbh-legacy");
  const stamp = new Date().toISOString();
  db.put("outlines", "out-tbh-legacy", {
    id: "out-tbh-legacy", clusterId: "clu-tbh-legacy", platform: "gzh",
    category: "news", contentType: "长文", title: "老数据资讯选题", outline: [], keyPoints: [],
    evidenceRefs: [], decision: "pending", createdAt: stamp,
  });
  ensureTiebuhaoClones(db);
  const rows = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh-legacy");
  assert.equal(rows.length, 2, "老数据保持原克隆行为");
  const clone = rows.find((o: any) => o.id === "out-tbh-legacy-tbh");
  assert.ok(clone, "克隆行存在");
  assert.equal(clone.platform, "tiebuhao");
});
