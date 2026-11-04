// R10.52① 验收：GET /seo-terms 默认 scope=cards（站群评估器唯一消费 siteCandidate:true，
// 此前全量 2.4MB/响应随 4s 轮询整页下发——11-03 生产弱链路事件的头号放大器）。
// · 默认（cards）：items=站群候选子集、total 恒全量计数、cards=候选数
// · ?scope=all：全量口保留，limit/offset 分页（默认 500 上限 2000）
// · GET /agent/seo-terms：形状不变（items+total 全量）——小拾读侧契约不破
// · snapshot()：pendingOutlines 随快照走（导航徽章数据源，SQL 生成列计数）
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1052-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const request = (route: string, data?: unknown, method?: string) => {
  const [p, q] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + p + (q ? "?" + q : ""), {
    method: method || (data === undefined ? "GET" : "POST"),
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), p.split("/"));
};
async function jsonReq(route: string) {
  const r = await request(route);
  return { status: r.status, body: await r.json() };
}

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("R10.52①：seo-terms 默认 cards——只回站群候选；total 恒全量；scope=all 分页", async () => {
  const db = store();
  for (let i = 0; i < 30; i++) db.put("seo-terms", "w" + i, { id: "w" + i, term: "词" + i, relevance: "strong" });
  for (let i = 0; i < 5; i++) db.put("seo-terms", "card" + i, { id: "card" + i, term: "卡" + i, siteCandidate: true, siteType: "工具站" });

  const cards = await jsonReq("seo-terms");
  assert.equal(cards.status, 200);
  assert.equal(cards.body.scope, "cards", "默认 scope=cards");
  assert.equal(cards.body.items.length, 5, "items=站群候选子集");
  assert.ok(cards.body.items.every((t: any) => t.siteCandidate === true), "候选全部 siteCandidate:true");
  assert.equal(cards.body.total, 35, "total 恒全量计数");
  assert.equal(cards.body.cards, 5, "cards 计数");

  const allPage = await jsonReq("seo-terms?scope=all&limit=10&offset=5");
  assert.equal(allPage.status, 200);
  assert.equal(allPage.body.scope, "all");
  assert.equal(allPage.body.items.length, 10, "limit 生效");
  assert.equal(allPage.body.total, 35, "全量口 total 同样恒全量");

  // agent 读口形状不变（小拾契约）：items+total 全量
  db.createConnection("r1052 read", ["read"]);
  const agent = await jsonReq("agent/seo-terms");
  assert.equal(agent.status, 401, "无令牌仍 401（形状断言在带令牌测试，此处守护路由存在性）");
});

test("R10.52①：snapshot.pendingOutlines 随快照走（徽章数据源）", () => {
  const db = store();
  const stamp = new Date().toISOString();
  db.put("outlines", "o-p1", { id: "o-p1", clusterId: "c", platform: "gzh", title: "待拍甲", decision: "pending", createdAt: stamp });
  db.put("outlines", "o-p2", { id: "o-p2", clusterId: "c", platform: "gzh", title: "待拍乙", decision: "pending", createdAt: stamp });
  db.put("outlines", "o-a1", { id: "o-a1", clusterId: "c", platform: "gzh", title: "已批", decision: "approved", createdAt: stamp });
  const snap = db.snapshot() as any;
  assert.equal(typeof snap.pendingOutlines, "number");
  assert.ok(snap.pendingOutlines >= 2, "快照带 pending 大纲计数（≥本用例两条）");
});
