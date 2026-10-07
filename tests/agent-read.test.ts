import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { envelope, topic, evidence } from "./fixtures";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-agent-read-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const request = (
  route: string,
  data?: unknown,
  headers: Record<string, string> = {},
  method?: string,
) => {
  const [pathPart, query] = route.split("?");
  return handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || (data === undefined ? "GET" : "POST"),
      headers: {
        host: "127.0.0.1:5173",
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
};

const get = (route: string, headers: Record<string, string> = {}) => request(route, undefined, headers, "GET");

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("读取 API 令牌鉴权：无令牌 401、仅提交令牌 403、读取令牌放行", async () => {
  const db = store();
  assert.equal((await get("agent/stats")).status, 401);
  const submitOnly = db.createConnection("仅提交");
  assert.ok(submitOnly.token);
  const submitResponse = await get("agent/stats", { Authorization: "Bearer " + submitOnly.token });
  assert.equal(submitResponse.status, 403);
  assert.match((await submitResponse.json()).error, /read 权限/);
  const reader = db.createConnection("读取助手", ["submit", "read"]);
  const ok = await get("agent/stats", { Authorization: "Bearer " + reader.token });
  assert.equal(ok.status, 200);
  const stats = await ok.json();
  assert.ok(stats.artifacts && stats.notice);
  // scope 隔离对 MCP 端点同样生效
  assert.equal(
    (await request("mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer " + submitOnly.token })).status,
    403,
  );
});

test("读取 API 返回带质量分层标签的产物与证据摘要投影", async () => {
  const db = store();
  // 夹具日期是写死的（9-21），随真实时间推移会滑出 14 天回看窗口——种子时改到当前时间
  evidence.forEach((e) => db.put("evidence", e.id, { ...e, collectedAt: new Date().toISOString() }));
  const reader = db.createConnection("读取助手2", ["read"]);
  const auth = { Authorization: "Bearer " + reader.token };
  const saved = db.saveArtifact(topic, "test-job", "review", ["测试样本"]);
  const listResponse = await get("agent/artifacts", auth);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const mine = list.items.find((a: any) => a.id === saved.id);
  assert.ok(mine);
  assert.equal(mine.quality, "review");
  assert.equal(mine.creationStatus, "inbox");
  assert.deepEqual(mine.evidenceIds, ["ev-one", "ev-two"]);
  assert.match(list.notice, /不构成事实认证/);
  const qualityFilter = await get("agent/artifacts?quality=ready", auth);
  assert.equal(((await qualityFilter.json()).items as any[]).find((a) => a.id === saved.id), undefined);
  const detailResponse = await get("agent/artifacts/" + saved.id, auth);
  const detail = await detailResponse.json();
  assert.equal(detail.id, saved.id);
  assert.ok(detail.evidence.some((e: any) => e.id === "ev-one"));
  assert.ok(detail.evidence.every((e: any) => e.excerpt.length <= 2000));
  assert.ok(detail.details && detail.details.platforms);
  assert.equal((await get("agent/artifacts/不存在", auth)).status, 404);
  const evidenceResponse = await get("agent/evidence?q=" + encodeURIComponent("会议"), auth);
  const evidenceList = await evidenceResponse.json();
  console.log("[dbg] evidence:", evidenceResponse.status, JSON.stringify(evidenceList).slice(0,300));
  assert.ok(evidenceList.items.some((e: any) => e.id === "ev-one"));
  assert.ok(evidenceList.items.every((e: any) => e.excerpt.length <= 2000));
});

test("MCP：initialize/tools/list/tools/call 走通，工具错误按 isError 返回", async () => {
  const db = store();
  const reader = db.createConnection("MCP 读取", ["read"]);
  const auth = { Authorization: "Bearer " + reader.token, "content-type": "application/json" };
  const rpc = (method: string, params: unknown, id: unknown) =>
    request("mcp", { jsonrpc: "2.0", id, method, params }, auth).then((r) => r.json());
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" }, 1);
  assert.equal(init.result.serverInfo.name, "draftdesk");
  const tools = await rpc("tools/list", {}, 2);
  assert.equal(tools.result.tools.length, 5);
  const called = await rpc("tools/call", { name: "get_workspace_stats", arguments: {} }, 3);
  const stats = JSON.parse(called.result.content[0].text);
  assert.ok(stats.artifacts);
  const bad = await rpc("tools/call", { name: "get_artifact", arguments: { id: "missing" } }, 4);
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, "产物 missing 不存在");
  // 通知（无 id）返回 202 空体
  const notify = await request("mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
  assert.equal(notify.status, 202);
});

test("读取令牌不能写入收件，提交隔离不被读取权限稀释", async () => {
  const db = store();
  const reader = db.createConnection("只读", ["read"]);
  const intake = await request("intake-check", { probe: true }, { Authorization: "Bearer " + reader.token });
  assert.equal(intake.status, 403);
});

test("消费接口：scope 隔离、dryRun 默认、幂等与状态计数", async () => {
  const db = store();
  const reader = db.createConnection("消费-只读", ["read"]);
  const consumer = db.createConnection("消费助手", ["consume"]);
  const consumeAuth = { Authorization: "Bearer " + consumer.token, "content-type": "application/json" };
  // scope 隔离：read 令牌不能消费；consume 令牌不能读取
  assert.equal((await request("agent/consume", { target: "evidence", ids: ["ev-one"], reason: "no-ai-signal" }, { Authorization: "Bearer " + reader.token })).status, 403);
  assert.equal((await get("agent/stats", { Authorization: "Bearer " + consumer.token })).status, 403);
  assert.equal((await request("intake-check", { probe: true }, { Authorization: "Bearer " + consumer.token })).status, 403);
  // dryRun 默认 true：只报影响面不写库
  const dry = await request("agent/consume", { target: "evidence", ids: ["ev-one"], reason: "no-ai-signal" }, consumeAuth);
  const dryBody = await dry.json();
  assert.equal(dry.status, 200);
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.toConsume, 1);
  assert.ok(!db.get("consumption", "evidence:ev-one"));
  // 正式消费 + 幂等
  const real = await request("agent/consume", { target: "evidence", ids: ["ev-one"], reason: "no-ai-signal", dryRun: false }, consumeAuth);
  assert.equal((await real.json()).toConsume, 1);
  const again = await request("agent/consume", { target: "evidence", ids: ["ev-one"], reason: "no-ai-signal" }, consumeAuth);
  assert.equal((await again.json()).alreadyConsumed, 1);
  assert.ok(db.get("consumption", "evidence:ev-one"));
  // ids 与 filter 都缺 → 400
  assert.equal((await request("agent/consume", { target: "evidence", reason: "no-ai-signal" }, consumeAuth)).status, 400);
  // 撤销复活
  const un = await request("agent/unconsume", { target: "evidence", ids: ["ev-one"] }, consumeAuth);
  assert.equal((await un.json()).revived, 1);
  assert.ok(!db.get("consumption", "evidence:ev-one"));
});

test("消费接口：热榜 filter 批量、状态计数与 UI remaining 联动", async () => {
  const db = store();
  const consumer = db.createConnection("消费助手2", ["consume", "read"]);
  const consumeAuth = { Authorization: "Bearer " + consumer.token, "content-type": "application/json" };
  const readAuth = { Authorization: "Bearer " + consumer.token };
  const at = new Date().toISOString();
  db.put("discovery", "hotspot-test", { jobId: "hotspot-test", at, planName: "测试策略", limit: 10, mode: "analysis",
    candidates: [
      { url: "https://a.example.org/1", title: "条目一", sourceId: "weibo-hotsearch", sourceName: "微博", status: "watch", reason: "原始热点", observedAt: at },
      { url: "https://a.example.org/2", title: "条目二", sourceId: "weibo-hotsearch", sourceName: "微博", status: "filtered", reason: "关键词不符", observedAt: at },
      { url: "https://b.example.org/3", title: "条目三", sourceId: "baidu-hot", sourceName: "百度", status: "watch", reason: "原始热点", observedAt: at },
    ], sources: [] });
  // filter：只消费微博来源的 watch 条目 → 1 条（条目二是 filtered 被排除）
  const filtered = await request("agent/consume", { target: "hotspots", filter: { days: 7, status: "watch", sourceId: "weibo-hotsearch" }, reason: "off-domain" }, consumeAuth);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.dryRun, true);
  assert.equal(filteredBody.matched, 1);
  // 正式执行 + 状态端点
  await request("agent/consume", { target: "hotspots", filter: { days: 7, status: "watch", sourceId: "weibo-hotsearch" }, reason: "off-domain", dryRun: false }, consumeAuth);
  const status = await get("agent/consume/status?target=hotspots", readAuth);
  const statusBody = await status.json();
  assert.equal(statusBody.total, 3);
  assert.equal(statusBody.consumed, 1);
  assert.equal(statusBody.remaining, 2);
  assert.equal(statusBody.byReason["off-domain"], 1);
  // UI 快照 remaining 联动
  const snapshot = db.snapshot(new URLSearchParams("page=1&view=discover")) as any;
  assert.equal(snapshot.stats.hotspotTotal, 3);
  assert.equal(snapshot.stats.hotspotRemaining, 2);
  assert.equal(snapshot.stats.hotspotConsumed, 1);
  // agent stats 一致
  const stats = await (await get("agent/stats", readAuth)).json();
  assert.equal(stats.hotspots.remaining, 2);
  // 过撤销窗口 → 410
  db.put("consumption", "hotspots:" + (await import("node:crypto")).randomUUID(), { target: "hotspots", identity: "https://old.example.org/x", reason: "outdated", consumedBy: "agent", consumedAt: "2026-08-01T00:00:00.000Z", unconsumeUntil: "2026-08-31T00:00:00.000Z" });
  const late = await request("agent/unconsume", { target: "hotspots", ids: ["https://old.example.org/x"] }, consumeAuth);
  assert.equal(late.status, 410);
});
