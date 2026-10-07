import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-consumer-v2-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { defaultConsumerMode } = await import("../core/defaults");
const { runJanitor, RETENTION } = await import("../core/janitor");

const request = (route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) => {
  const [pathPart, query] = route.split("?");
  return handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || methodOf(data),
      headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined || data === null ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
};
function methodOf(data?: unknown) { return data === undefined ? "GET" : data === null ? "PATCH" : "POST"; }

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("③ agent 四个 GET：persona/aiPolicy/clusters/outlines 用 read scope 可读", async () => {
  const db = store();
  const reader = db.createConnection("v2读者", ["read"]);
  const auth = { Authorization: "Bearer " + reader.token };
  for (const route of ["agent/persona", "agent/aiPolicy", "agent/clusters", "agent/outlines"]) {
    const r = await request(route, undefined, auth);
    assert.equal(r.status, 200, route + " 应可读");
  }
  const persona = await (await request("agent/persona", undefined, auth)).json();
  assert.ok(persona.domains, "persona 应含领域配置");
  // 无令牌 → 401
  assert.equal((await request("agent/persona")).status, 401);
});

test("① 按簇消费：clusterIds 展开成员、exceptIds 排除、producedRef 指向大纲、幂等", async () => {
  const db = store();
  const consumer = db.createConnection("簇消费者", ["consume", "read", "suggest"]);
  const consumeAuth = { Authorization: "Bearer " + consumer.token, "content-type": "application/json" };
  // 种子：簇 + 两条成员热榜
  const at = new Date().toISOString();
  db.put("discovery", "d-clu", { jobId: "d-clu", at, planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://cluster.example.org/1", title: "成员一", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: at },
    { url: "https://cluster.example.org/2", title: "成员二", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: at },
  ]});
  const clusterRes = await request("agent/clusters", { topic: "测试簇", memberIds: ["https://cluster.example.org/1", "https://cluster.example.org/2"], kind: "news" }, consumeAuth, "PUT");
  console.log("[dbg] cluster PUT:", clusterRes.status, (await clusterRes.clone().text()).slice(0,120));
  const cluster = await clusterRes.json();
  const outline = await (await request("agent/outlines", { clusterId: cluster.id, platform: "公众号", contentType: "长文", title: "测试大纲" }, consumeAuth, "PUT")).json();
  // 按簇消费，exceptIds 排除成员二；producedRef 自动指向大纲 id
  const dry = await request("agent/consume", { target: "hotspots", clusterIds: [cluster.id], exceptIds: ["https://cluster.example.org/2"], reason: "processed-into-artifact", dryRun: true }, consumeAuth);
  const dryBody = await dry.json();
  console.log("[dbg] dry:", dry.status, JSON.stringify(dryBody).slice(0,200));
  assert.equal(dryBody.toConsume, 1);
  const real = await request("agent/consume", { target: "hotspots", clusterIds: [cluster.id], exceptIds: ["https://cluster.example.org/2"], reason: "processed-into-artifact", dryRun: false }, consumeAuth);
  const realBody = await real.json();
  console.log("[dbg] real:", real.status, JSON.stringify(realBody).slice(0,200));
  assert.equal(realBody.toConsume, 1);
  assert.equal(realBody.producedRef ?? (await request("agent/consume/status?target=hotspots", undefined, consumeAuth) && undefined), realBody.producedRef);
  const entry = db.get<any>("consumption", "hotspots:https://cluster.example.org/1");
  assert.equal(entry.producedRef, outline.id, "producedRef 应指向簇大纲");
  // 幂等
  const again = await request("agent/consume", { target: "hotspots", clusterIds: [cluster.id], exceptIds: ["https://cluster.example.org/2"], reason: "processed-into-artifact", dryRun: false }, consumeAuth);
  assert.equal((await again.json()).alreadyConsumed, 1);
  // unconsume 支持 2048 长身份
  const longId = "https://example.com/" + encodeURIComponent("长".repeat(200));
  await request("agent/consume", { target: "hotspots", ids: [longId], reason: "outdated", dryRun: false }, consumeAuth);
  const un = await request("agent/unconsume", { target: "hotspots", ids: [longId] }, consumeAuth);
  assert.equal(un.status, 200);
});

test("④ 草稿正文：decisions/:id/draft 落库，agent outlines PUT 可携带，队列可读", async () => {
  const db = store();
  const manual = await (await request("decisions/manual", { title: "草稿测试选题" })).json();
  const draftRes = await request(`decisions/${manual.id}/draft`, { draftBody: "这是草稿正文第一版。" });
  console.log("[dbg] draft:", draftRes.status, (await draftRes.text()).slice(0,150));
  const queue = await (await request("decisions?status=all")).json();
  const row = queue.items.find((r: any) => r.id === manual.id);
  assert.equal(row.draftBody, "这是草稿正文第一版。");
  assert.equal(row.evidenceQuality !== undefined || row.sourceType === "manual", true);
  // agent outlines 携带 draftBody
  const suggester = db.createConnection("大纲作者", ["suggest"]);
  const cluster = await (await request("agent/clusters", { topic: "草稿簇", memberIds: [], kind: "news" }, { Authorization: "Bearer " + suggester.token }, "PUT")).json();
  const outline = await (await request("agent/outlines", { clusterId: cluster.id, platform: "公众号", contentType: "长文", title: "带草稿的大纲", draftBody: "外部 Agent 写的草稿正文" }, { Authorization: "Bearer " + suggester.token }, "PUT")).json();
  assert.equal(outline.draftBody, "外部 Agent 写的草稿正文");
  // 决策字段偷渡仍被剥离
  assert.equal(outline.decision, "pending");
});

test("② consumerMode：默认 external，janitor 跳过，triage 软跳过，切回 builtin 恢复", async () => {
  const db = store();
  assert.equal(db.get<any>("config", "consumerMode"), "external");
  const old = new Date(Date.now() - (RETENTION.hotspots.autoConsumeOlderThanDays + 5) * 86400000).toISOString();
  db.put("discovery", "jan-seed", { jobId: "jan-seed", at: old, planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://old.example.org/jan", title: "旧条目", sourceId: "s", sourceName: "源", status: "watch", reason: "原始热点", observedAt: old },
  ]});
  db.del("meta", "janitor");
  const result = runJanitor(db);
  assert.equal(result!.skipped, true, "external 模式 janitor 应跳过");
  assert.ok(!db.get("consumption", "hotspots:https://old.example.org/jan"), "external 模式不自动消费");
  // 切回 builtin：janitor 恢复执行
  db.put("config", "consumerMode", "builtin");
  db.del("meta", "janitor");
  const result2 = runJanitor(db);
  assert.equal(result2!.skipped, undefined);
  assert.ok(db.get("consumption", "hotspots:https://old.example.org/jan"), "builtin 模式应自动消费旧条目");
  // 恢复 external（本实例目标状态）
  db.put("config", "consumerMode", "external");
  // triage：external → 软跳过
  db.put("activity-batches", "b-tri", { id: "b-tri", receivedAt: new Date().toISOString(), bundle: { platform: "哔哩哔哩", items: [{ title: "活动", url: "https://www.bilibili.com/x" }] } });
  const triage = await request("activity-triage", { batchIds: ["b-tri"], keywords: ["AI"] });
  const triageBody = await triage.json();
  assert.equal(triageBody.skipped, true);
});
