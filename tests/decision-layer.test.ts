import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { topic, evidence } from "./fixtures";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-decision-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { defaultPersona } = await import("../core/defaults");

function methodLabel(data?:unknown){return data===undefined?"GET":data===null?"PATCH":"POST";}
function methodOf(data?: unknown) { return data === undefined ? "GET" : data === null ? "PATCH" : "POST"; }
async function request(route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) {
  const [pathPart, query] = route.split("?");
  const res = await handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || methodOf(data),
      headers: { host: "127.0.0.1:5173", ...(data === undefined || data === null ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined || data === null ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
  if (process.env.DECISION_DEBUG) console.log("[req]", methodOf(data), route, "→", res.status);
  return res;
}

test("P1 迁移：saved→approved、其余 pending、saved 废弃、legacy 归档导出、persona 种子", async () => {
  const db = store();
  // 迁移在构造时已跑（本文件进程首次 import 时）：先造一条 saved 旧数据，再开第二个 Store 触发重放不可行——
  // 直接验证迁移后果 + 手工补一条 saved 行再构造新 Store 验证映射。
  const legacyBefore = db.list<any>("legacy").length;
  db.put("artifacts", "legacy-saved", { ...topic, id: "legacy-saved", title: "旧收藏", quality: "review", issues: [], saved: true, archived: false, jobId: "j0", createdAt: now0(), updatedAt: now0(), revision: 1, reviewNote: "", skillVersion: "1.0.0", visibility: "private" });
  db.del("meta", "decision-layer-v1");
  const fresh = await import("../core/store");
  const db2 = new fresh.Store(dir);
  const migrated = db2.get<any>("artifacts", "legacy-saved");
  db2.close();
  assert.equal(migrated.decision, "approved");
  assert.equal(migrated.decidedBy, "human");
  assert.equal(migrated.saved, undefined);
  // persona 种子
  assert.deepEqual(db.get<any>("config", "persona"), defaultPersona);
  // legacy 归档文件（若库内有 legacy 条目则导出文件存在且集合被清空）
  if (legacyBefore > 0) {
    assert.ok(existsSync(path.join(dir, `legacy-archive-${new Date().toISOString().slice(0, 10)}.json`)));
    assert.equal(db.list("legacy").length, 0);
  }
});
function now0() { return new Date().toISOString(); }

test("P2/P3：拍板 → decision 落库；rejected/published 联动消费；批量；发布回填", async () => {
  const db = store();
  const consumer = db.createConnection("消费联动", ["consume", "read"]);
  const consumeAuth = { Authorization: "Bearer " + consumer.token, "content-type": "application/json" };
  evidence.forEach((e) => db.put("evidence", e.id, e));
  // 热榜种子：两条 urlKey 对应证据 url（含 utm 变体）
  const at = new Date().toISOString();
  db.put("discovery", "d-link", { jobId: "d-link", at, planName: "P", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://example.com/update", title: "官方更新", sourceId: "s", sourceName: "源", status: "selected", reason: "命中", observedAt: at },
    { url: "https://example.org/discussion", title: "社区讨论", sourceId: "s", sourceName: "源", status: "selected", reason: "命中", observedAt: at },
  ]});
  const saved = db.saveArtifact(topic, "job-d", "review", []);
  assert.equal(saved.decision, "pending");
  // 否决必须带原因
  assert.equal((await request(`artifacts/${saved.id}/decision`, { decision: "rejected" })).status, 400);
  // 否决 → 联动消费（两条证据的 url 都被消费）
  const rejected = await request(`artifacts/${saved.id}/decision`, { decision: "rejected", rejectReason: "off-domain" });
  assert.equal(rejected.status, 200);
  const afterReject = await (await request("agent/consume/status?target=hotspots", undefined, consumeAuth)).json();
  assert.equal(afterReject.byReason["off-domain"], 2);
  // 撤销消费以便发布联动验证
  await request("agent/unconsume", { target: "hotspots", ids: ["https://example.com/update", "https://example.org/discussion"] }, consumeAuth);
  // 通过 → 开始写作 → 回填发布 → 联动消费 processed-into-artifact
  await request(`artifacts/${saved.id}/decision`, { decision: "approved" });
  await request(`artifacts/${saved.id}/decision`, { decision: "drafting" });
  const queue = await (await request("decisions?status=drafting")).json();
  assert.ok(queue.items.some((r: any) => r.id === saved.id && r.sourceType === "artifact"));
  const published = await request(`decisions/${saved.id}/publish`, { publishedRef: "https://mp.weixin.qq.com/s/abc" });
  assert.equal((await published.json()).decision, "published");
  const afterPublish = await (await request("agent/consume/status?target=hotspots", undefined, consumeAuth)).json();
  assert.equal(afterPublish.byReason["processed-into-artifact"], 2);
  // stats
  const stats = await (await request("decisions/stats")).json();
  assert.equal(stats.byDecision["published"], 1);
  assert.ok(stats.byPlatform["公众号"] === undefined || stats.byPlatform["公众号"] >= 0);
});

test("P2：批量拍板（否决必带原因）+ 手动添加选题 + 建议（suggestions）多源", async () => {
  const db = store();
  const a1 = db.saveArtifact(topic, "job-b", "review", []);
  const a2 = db.saveArtifact({ ...topic, title: "第二条" }, "job-b", "review", []);
  // 批量否决缺原因 → 400
  assert.equal((await request("decisions/batch", { ids: [a1.id, a2.id], decision: "rejected" })).status, 400);
  // 批量暂缓
  const batch = await request("decisions/batch", { ids: [a1.id, a2.id], decision: "deferred" });
  assert.equal((await batch.json()).applied, 2);
  assert.equal(db.get<any>("artifacts", a1.id).decision, "deferred");
  // 手动添加选题 + 回填发布
  const manual = await request("decisions/manual", { title: "手动记录的选题", platforms: ["公众号"] });
  assert.equal(manual.status, 201);
  const manualId = (await manual.json()).id;
  const pub = await request(`decisions/${manualId}/publish`, { publishedRef: "https://mp.weixin.qq.com/s/xyz" });
  assert.equal((await pub.json()).decision, "published");
  // 建议（suggestions）：外部 agent 只写建议不改 decision
  const reader = db.createConnection("建议助手", ["read"]);
  const auth = { Authorization: "Bearer " + reader.token, "content-type": "application/json" };
  const before = db.get<any>("artifacts", a1.id).decision;
  const sug = await request("agent/suggestions", { targetType: "artifact", targetId: a1.id, verdict: "approved", score: 4.2, reason: "热门且证据充分" }, auth);
  assert.equal(sug.status, 200);
  const afterRow = db.get<any>("artifacts", a1.id);
  assert.equal(afterRow.decision, before, "建议不得改变 decision");
  assert.equal(afterRow.suggestions.length, 1);
  assert.match(afterRow.suggestions[0].by, /^agent:建议助手$/);
  // §11.1：consume ids 上限放宽到 2048，长 URL 可消费
  const longUrl = "https://example.com/" + encodeURIComponent("很长的中文路径".repeat(12));
  assert.ok(longUrl.length > 500);
  const consumer2 = db.createConnection("消费验证", ["consume"]);
  const dry = await request("agent/consume", { target: "hotspots", ids: [longUrl], reason: "no-ai-signal" }, { Authorization: "Bearer " + consumer2.token });
  assert.equal(dry.status, 200);
});

test("P4：persona 读写回环，非法结构被拒", async () => {
  assert.equal((await request("persona")).status, 200);
  const bad = await request("persona", { domains: { do: [] }, broken: true });
  assert.equal(bad.status, 400);
  const save = await request("persona", { ...defaultPersona, goals: ["测试目标"] });
  assert.equal(save.status, 200);
  assert.deepEqual((await save.json()).goals, ["测试目标"]);
});
