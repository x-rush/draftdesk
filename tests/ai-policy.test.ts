import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-ai-policy-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { defaultAiPolicy } = await import("../core/defaults");
const { topic, evidence } = await import("./fixtures");

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
function methodOf(data?: unknown) { return data === undefined ? "GET" : data === null ? "PATCH" : data === "PUT_MARKER" ? "PUT" : "POST"; }

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("aiPolicy 种子默认全 off + external（需求 §15.3 作者倾向），可经 API 修改", async () => {
  const db = store();
  assert.deepEqual(db.get<any>("config", "aiPolicy"), defaultAiPolicy);
  assert.equal(defaultAiPolicy.triage, "off");
  assert.equal(defaultAiPolicy.outline, "off");
  assert.equal(defaultAiPolicy.draft, "off");
  assert.equal(defaultAiPolicy.aiWriter, "external");
  const updated = await request("aiPolicy", { ...defaultAiPolicy, triage: "cheap", aiWriter: "both" });
  assert.equal((await updated.json()).triage, "cheap");
  assert.equal((await request("aiPolicy", { ...defaultAiPolicy, triage: "bogus" } as any)).status, 400);
  await request("aiPolicy", { ...defaultAiPolicy });
  assert.deepEqual(db.get<any>("config", "aiPolicy"), defaultAiPolicy);
});

test("suggest scope：写回 clusters/outlines 带 producedBy，decision 字段被剥离；read 令牌 403", async () => {
  const db = store();
  const suggester = db.createConnection("聚合助手", ["suggest", "read"]);
  const suggestAuth = { Authorization: "Bearer " + suggester.token, "content-type": "application/json" };
  const reader = db.createConnection("纯读", ["read"]);
  // read 令牌写 clusters → 403
  assert.equal((await request("agent/clusters", { topic: "x", memberIds: [], kind: "news" }, { Authorization: "Bearer " + reader.token }, "PUT")).status, 403);
  // suggest 令牌创建簇；payload 混入 decision 字段也不影响（显式挑字段）
  const cluster = await request("agent/clusters", { topic: "本周 AI 模型动态", memberIds: ["a1", "a2"], kind: "news", decision: "published" } as any, suggestAuth, "PUT");
  assert.equal(cluster.status, 201);
  const clusterRow = await cluster.json();
  assert.equal(clusterRow.producedBy, "agent:聚合助手");
  assert.equal(clusterRow.id.startsWith("clu-"), true);
  // 大纲：携带 decision/draftRef/publishedRef 也被剥离，保持 pending
  const outline = await request("agent/outlines", { clusterId: clusterRow.id, platform: "Threads", contentType: "英文短评", title: "Weekly AI models", decision: "published", draftRef: "hack" } as any, suggestAuth, "PUT");
  const outlineRow = await outline.json();
  assert.equal(outline.status, 201);
  assert.equal(outlineRow.decision, "pending");
  assert.equal(outlineRow.producedBy, "agent:聚合助手");
  assert.equal(outlineRow.draftRef, undefined);
  // 更新（带 id）保留原 decision
  const updated = await request("agent/outlines", { id: outlineRow.id, clusterId: clusterRow.id, platform: "公众号", contentType: "长文", title: "周更 AI 动态" } as any, suggestAuth, "PUT");
  assert.equal((await updated.json()).decision, "pending");
  // 建议 PATCH 别名
  db.put("evidence", "ev-s", { ...evidence[0], id: "ev-s" });
  const a = db.saveArtifact(topic, "job", "review", []);
  const sug = await request("agent/suggestions", { targetType: "artifact", targetId: a.id, verdict: "deferred", reason: "未实测" }, suggestAuth, "PATCH");
  assert.equal(sug.status, 200);
  assert.equal(db.get<any>("artifacts", a.id).decision, "pending", "建议不得改变 decision");
  // 外部 Agent 尝试写 decision（内部拍板路由带 Bearer）→ 403
  assert.equal((await request(`artifacts/${a.id}/decision`, { decision: "published" }, { Authorization: "Bearer " + suggester.token })).status, 403);
});

test("aiPolicy.triage=off：活动初筛软跳过，不调用模型不报错", async () => {
  const db = store();
  // 默认即 off
  const batches = db.list<any>("activity-batches");
  if (!batches.length) {
    db.put("activity-batches", "b-off", { id: "b-off", receivedAt: new Date().toISOString(), bundle: { platform: "哔哩哔哩", items: [{ title: "活动", url: "https://www.bilibili.com/x" }] } });
  }
  const response = await request("activity-triage", { batchIds: ["b-off"], keywords: ["AI"] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.skipped, true);
  assert.match(body.reason, /triage=off/);
});
