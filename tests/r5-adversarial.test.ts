// 第五轮终验·第三层对抗边界（测试进程真实执行完整代码路径）
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "dd-r5-adv-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const req = async (route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) => {
  const [p, q] = route.split("?");
  const r = await handle(new Request("http://127.0.0.1:5173/api/v1/" + p + (q ? "?" + q : ""), {
    method: method || (data === undefined ? "GET" : "POST"),
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), p.split("/"));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
after(() => { store().close(); rmSync(dir, { recursive: true, force: true }); });

test("跨零点窗：00:01 新批无组 → GROUPS_MISSING；昨日 23:59 批有组不阻断", async () => {
  const db = store();
  const T = db.createConnection("r5零点", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + T };
  const t00 = new Date(); t00.setHours(0, 1, 0, 0);
  const t23 = new Date(Date.now() - 86400000); t23.setHours(23, 59, 0, 0);
  db.put("discovery", "collectall-yday", { jobId: "collectall-yday", at: t23.toISOString(), planName: "P", limit: 6, mode: "analysis", sources: [], candidates: [] });
  db.put("candidate-groups", "tg-collectall-yday", { jobId: "collectall-yday", planName: "P", day: "d", at: t23.toISOString(), groups: [], shards: 0, calls: 0, tokens: 0, merges: 0 });
  db.put("clusters", "clu-x0", { id: "clu-x0", topic: "零点簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  const a = await req("agent/outlines", { clusterId: "clu-x0", platform: "gzh", contentType: "长文", title: "r5零点A昨日组放行" }, auth, "PUT");
  assert.equal(a.status, 201, "昨日批有组 → 放行（跨零点不误杀）");
  db.put("discovery", "collectall-today", { jobId: "collectall-today", at: t00.toISOString(), planName: "P", limit: 6, mode: "analysis", sources: [], candidates: [] });
  const b = await req("agent/outlines", { clusterId: "clu-x0", platform: "gzh", contentType: "长文", title: "r5零点B新批无组应拦" }, auth, "PUT");
  assert.equal(b.status, 400);
  assert.equal(b.body.code, "GROUPS_MISSING");
  await req("agent/triage/groups", { jobId: "collectall-today", groups: [{ id: "g0", title: "零点组", attention: "strong" }] }, auth, "PUT");
  const c = await req("agent/outlines", { clusterId: "clu-x0", platform: "gzh", contentType: "长文", title: "r5零点C组后放行" }, auth, "PUT");
  assert.equal(c.status, 201);
  const dup = await req("agent/outlines", { clusterId: "clu-x0", platform: "xhs-note", contentType: "长文", title: "r5零点A昨日组放行" }, auth, "PUT");
  assert.equal(dup.body.duplicate, true, "48h 跨零点同题仍命中");
});

test("重放攻击：同批二次 PUT 幂等 + 缩减重放不重置判级", async () => {
  const db = store();
  const T = db.createConnection("r5重放", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + T };
  db.put("discovery", "r5replay", { jobId: "r5replay", at: new Date().toISOString(), planName: "P", limit: 6, mode: "analysis", sources: [], candidates: [
    { url: "https://r5/u1", sourceId: "s", status: "watch" }, { url: "https://r5/u2", sourceId: "s", status: "watch" }] });
  const g1 = { id: "g1", title: "重放组一", attention: "strong", reason: "r", memberUrls: ["https://r5/u1"] };
  const g2 = { id: "g2", title: "重放组二", attention: "potential", reason: "r", memberUrls: ["https://r5/u2"] };
  await req("agent/triage/groups", { jobId: "r5replay", groups: [g1, g2] }, auth, "PUT");
  const again = await req("agent/triage/groups", { jobId: "r5replay", groups: [g1, g2] }, auth, "PUT");
  assert.equal(again.body.groups, 2, "同批二次 PUT 幂等（不翻倍）");
  const shrink = await req("agent/triage/groups", { jobId: "r5replay", groups: [g2] }, auth, "PUT");
  assert.equal(shrink.body.groups, 2, "缩减重放保留前组");
  const disc = db.get<any>("discovery", "r5replay");
  const u1 = (disc.candidates || []).find((c: any) => c.url === "https://r5/u1");
  assert.equal(u1.attention, "strong", "缩减重放不重置未认领候选判级");
});

test("畸形输入：emoji/超长标题、200 组批量边界", async () => {
  const db = store();
  const T = db.createConnection("r5畸形", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + T };
  db.put("clusters", "clu-emoji", { id: "clu-emoji", topic: "emoji 簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  db.put("discovery", "collectall-r5f", { jobId: "collectall-r5f", at: new Date().toISOString(), planName: "P", limit: 6, mode: "analysis", sources: [], candidates: [] });
  await req("agent/triage/groups", { jobId: "collectall-r5f", groups: [{ id: "g", title: "组", attention: "strong" }] }, auth, "PUT");
  const emoji = await req("agent/outlines", { clusterId: "clu-emoji", platform: "gzh", contentType: "长文", title: "🤖AI 发布会🎉实测" }, auth, "PUT");
  assert.equal(emoji.status, 201, "emoji 标题可写");
  const emojiDup = await req("agent/outlines", { clusterId: "clu-emoji", platform: "xhs-note", contentType: "长文", title: "🤖ai 发布会🎉实测" }, auth, "PUT");
  assert.equal(emojiDup.body.duplicate, true, "emoji 大小写变体仍命中归一化去重");
  const longTitle = "超长".repeat(160);
  const lt = await req("agent/outlines", { clusterId: "clu-emoji", platform: "gzh", contentType: "长文", title: longTitle }, auth, "PUT");
  assert.equal(lt.status, 400, "超 300 字标题 zod 拒绝");
  const many = Array.from({ length: 200 }, (_, i) => ({ id: "mg" + i, title: "批量组" + i, attention: "potential" as const }));
  db.put("discovery", "collectall-r5m", { jobId: "collectall-r5m", at: new Date().toISOString(), planName: "P", limit: 6, mode: "analysis", sources: [], candidates: [] });
  const bulk = await req("agent/triage/groups", { jobId: "collectall-r5m", groups: many }, auth, "PUT");
  assert.equal(bulk.status, 200, "200 组批量上限内通过");
  assert.equal(bulk.body.groups, 200);
  const over = await req("agent/triage/groups", { jobId: "collectall-r5m", groups: [...many, { id: "mgX", title: "超", attention: "potential" }] }, auth, "PUT");
  assert.equal(over.status, 400, "201 组被 zod 拒绝");
});

test("并发写：两路同时 PUT outlines 同簇（各自不同标题）→ 双落库无半写", async () => {
  const db = store();
  const T = db.createConnection("r5并发", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + T };
  db.put("clusters", "clu-cc", { id: "clu-cc", topic: "并发簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  const [a, b] = await Promise.all([
    req("agent/outlines", { clusterId: "clu-cc", platform: "gzh", contentType: "长文", title: "r5并发写入甲" }, auth, "PUT"),
    req("agent/outlines", { clusterId: "clu-cc", platform: "gzh", contentType: "长文", title: "r5并发写入乙" }, auth, "PUT"),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 201), `两路均 201: ${a.status}/${b.status}`);
  const rows = db.list<any>("outlines").filter((o) => String(o.title).startsWith("r5并发写入"));
  assert.equal(rows.length, 2, "双落库");
  assert.ok(rows.every((o) => o.clusterId === "clu-cc" && o.decision === "pending"), "字段完整无半写");
});

test("02:00 预演：external 下 worker 关键 tick 真实跑一轮（门控零动作+锁无残留）", async () => {
  const db = store();
  db.put("config", "consumerMode", "external");
  const { triageTick } = await import("../core/triage");
  const { seenJudgeTick } = await import("../core/seen-judge");
  const { opportunityTick } = await import("../core/opportunity");
  const { collectAllTick } = await import("../core/collect-all");
  await triageTick(db);
  seenJudgeTick(db, (async () => { throw new Error("不应发起网络请求"); }) as never, { now: new Date() });
  opportunityTick(db);
  await collectAllTick(db);
  assert.equal(db.get("meta", "collect-all-running"), undefined, "锁已释放无残留");
});
