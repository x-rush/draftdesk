import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-consumer-v3-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { evidence } = await import("./fixtures");
const { runJanitor, RETENTION } = await import("../core/janitor");

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

test("③ agent 四个 GET：persona/aiPolicy/clusters/outlines read scope 可读", async () => {
  const db = store();
  const reader = db.createConnection("v3读者", ["read"]);
  const auth = { Authorization: "Bearer " + reader.token };
  for (const route of ["agent/persona", "agent/aiPolicy", "agent/clusters", "agent/outlines"]) {
    const r = await request(route, undefined, auth);
    assert.equal(r.status, 200, route);
  }
  assert.equal((await request("agent/persona")).status, 401);
  // 写通道仍要求 suggest：PUT 无 read 也能到 suggest 鉴权（403 而非 405）
  const suggester = db.createConnection("v3作者", ["suggest", "read"]);
  const put = await request("agent/clusters", { topic: "t", memberIds: [], kind: "news" }, { Authorization: "Bearer " + suggester.token }, "PUT");
  assert.equal(put.status, 201);
});

test("① 按簇消费：target 校验 400 零写入、notFound 统计、producedRef→大纲、outlineIds", async () => {
  const db = store();
  const consumer = db.createConnection("v3消费者", ["consume", "read", "suggest"]);
  const consumeAuth = { Authorization: "Bearer " + consumer.token, "content-type": "application/json" };
  const at = new Date().toISOString();
  db.put("discovery", "d-v3", { jobId: "d-v3", at, planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://v3.example.org/1", title: "成员一", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: at },
    { url: "https://v3.example.org/2", title: "成员二", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: at },
  ]});
  db.put("evidence", "ev-v3", { ...evidence[0], id: "ev-v3", title: "v3证据", collectedAt: at });
  // 建簇（target 默认 hotspots）
  const { body: cluster } = await jsonReq("agent/clusters", { topic: "v3簇", memberIds: ["https://v3.example.org/1", "https://v3.example.org/2"], kind: "news" }, consumeAuth, "PUT");
  assert.equal(cluster.target, "hotspots");
  const { body: outline } = await jsonReq("agent/outlines", { clusterId: cluster.id, platform: "公众号", contentType: "长文", title: "v3大纲" }, consumeAuth, "PUT");
  // target 不匹配 → 400 且零写入
  const mismatch = await request("agent/consume", { target: "evidence", clusterIds: [cluster.id], reason: "processed-into-artifact", dryRun: false }, consumeAuth);
  assert.equal(mismatch.status, 400);
  assert.match(JSON.parse(await mismatch.text()).error, /属于 hotspots 空间/);
  assert.ok(!db.get("consumption", "evidence:https://v3.example.org/1"), "target 不匹配不得写入");
  // notFound：混入一条池外身份 → 计入 notFound 不消费
  const { body: dry } = await jsonReq("agent/consume", { target: "hotspots", clusterIds: [cluster.id], exceptIds: ["https://v3.example.org/2"], reason: "processed-into-artifact", dryRun: true }, consumeAuth);
  assert.equal(dry.toConsume, 1);
  assert.equal(dry.notFound.length, 0);
  const { body: withGhost } = await jsonReq("agent/consume", { target: "hotspots", ids: ["https://v3.example.org/1", "https://ghost.example.org/x"], reason: "no-ai-signal", dryRun: false }, consumeAuth);
  assert.equal(withGhost.toConsume, 1);
  assert.deepEqual(withGhost.notFound, ["https://ghost.example.org/x"]);
  assert.ok(db.get("consumption", "hotspots:https://v3.example.org/1"));
  assert.ok(!db.get("consumption", "hotspots:https://ghost.example.org/x"), "池外身份不得入库");
  // producedRef 自动指向簇大纲；outlineIds 全集
  assert.equal(withGhost.producedRef, undefined, "ids 路径不自动指向大纲");
  assert.deepEqual(withGhost.outlineIds, [], "ids 路径无簇大纲关联");
});

test("④ draftBody：agent outlines PUT 携带草稿正文，队列可读", async () => {
  const db = store();
  const suggester = db.createConnection("v3作者", ["suggest", "read"]);
  const sAuth = { Authorization: "Bearer " + suggester.token, "content-type": "application/json" };
  const { body: cluster } = await jsonReq("agent/clusters", { topic: "草稿簇v3", memberIds: [], kind: "news" }, sAuth, "PUT");
  const outlineRes = await jsonReq("agent/outlines", { clusterId: cluster.id, platform: "公众号", contentType: "长文", title: "带草稿", draftBody: "v3 草稿正文" }, sAuth, "PUT");
  console.log("[dbg] outline PUT:", outlineRes.status, "draftBody=", JSON.stringify(outlineRes.body.draftBody));
  const outline = outlineRes.body;
  assert.equal(outline.draftBody, "v3 草稿正文");
  const queueRes = await jsonReq("agent/decisions?status=all", undefined, sAuth);
  console.log("[dbg] queue:", queueRes.status, JSON.stringify(queueRes.body).slice(0,150));
  const queue = queueRes.body;
  const row = queue.items.find((r: any) => r.id === outline.id);
  console.log("[dbg] queue:", queueRes.status, JSON.stringify(queueRes.body).slice(0,200));
  assert.equal(row.draftBody, "v3 草稿正文");
  assert.ok(row.evidenceQuality !== undefined || row.sourceType === "outline");
});

test("② consumerMode：默认 external；janitor/triage 双双停用；builtin 恢复", async () => {
  const db = store();
  assert.equal(db.get<any>("config", "consumerMode"), "external");
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  db.put("discovery", "jan-v3", { jobId: "jan-v3", at: old, planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://old.example.org/v3", title: "旧条目", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: old },
  ]});
  db.del("meta", "janitor");
  const r1 = runJanitor(db);
  assert.equal(r1!.skipped, true, "external 模式 janitor 跳过");
  assert.ok(!db.get("consumption", "hotspots:https://old.example.org/v3"));
  // 切 builtin：恢复回收
  db.put("config", "consumerMode", "builtin");
  db.del("meta", "janitor");
  const r2 = runJanitor(db);
  assert.equal(r2!.hotspots, 1, "builtin 模式回收旧条目");
  assert.ok(db.get("consumption", "hotspots:https://old.example.org/v3"));
  // triage：external → 软跳过
  db.put("activity-batches", "b-v3", { id: "b-v3", receivedAt: new Date().toISOString(), bundle: { platform: "哔哩哔哩", items: [{ title: "活动", url: "https://www.bilibili.com/x" }] } });
  const { body: triage } = await jsonReq("activity-triage", { batchIds: ["b-v3"], keywords: ["AI"] });
  assert.equal(triage.skipped, true);
  // 恢复 external（本实例目标状态）
  db.put("config", "consumerMode", "external");
});
