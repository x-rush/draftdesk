// Part 3 守护测试：hotspot-categories agent 写入（urlKey 身份键/幂等 upsert/suggest 门槛）
// + 订阅排序（感兴趣置顶/纯时间切换）+ agent 投影带 category。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("热点分类：upsert 幂等+urlKey 身份键+suggest 门槛；订阅排序感兴趣置顶；投影带类别", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-cats-"));
  const previous = process.env.DRAFTDESK_DATA_DIR;
  process.env.DRAFTDESK_DATA_DIR = dir;
  try {
    const { handle } = await import("../core/http");
    const call = async (route: string, method: string, body?: unknown, token?: string) => {
      const res = await handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
        method,
        headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }), route.split("?")[0].split("/"));
      return { res, body: await res.json() };
    };

    const conn = await call("connections", "POST", { name: "cat-agent", scopes: ["read", "suggest"] });
    const auth = conn.body.token;

    // suggest 门槛：无令牌 PUT = 401/403
    const noAuth = await call("agent/hotspot-categories", "PUT", { items: [{ url: "https://c.example/1", category: "模型动态" }] });
    assert.ok([401, 403].includes(noAuth.res.status), "无令牌应被拒");

    // upsert：追踪参数变体归一为同一身份键；同键后写覆盖
    const put1 = await call("agent/hotspot-categories", "PUT", { items: [
      { url: "https://c.example/1?utm_source=x", category: "模型动态" },
      { url: "https://c.example/2", category: "Agent生态" },
    ] }, auth);
    assert.equal(put1.res.status, 200);
    assert.equal(put1.body.upserted, 2);
    const put2 = await call("agent/hotspot-categories", "PUT", { items: [{ url: "https://c.example/1", category: "教程实战" }] }, auth);
    assert.equal(put2.res.status, 200);
    const list = await call("agent/hotspot-categories", "GET", undefined, auth);
    assert.equal(list.body.total, 2, "同身份键应覆盖而非新增");
    const one = list.body.items.find((c: any) => c.identity.includes("c.example/1"));
    assert.equal(one.category, "教程实战", "后写应覆盖");
    assert.match(one.producedBy, /^agent:cat-agent$/);

    // 非法类别拒绝
    const bad = await call("agent/hotspot-categories", "PUT", { items: [{ url: "https://c.example/3", category: "不存在的类" }] }, auth);
    assert.equal(bad.res.status, 400);

    // 订阅排序：造两条 discovery 候选，类别分别为 已订阅/未订阅；interested 排序置顶已订阅
    const dbModule = await import("../core/store");
    const db = dbModule.store();
    const at = new Date().toISOString();
    db.put("discovery", "cat-j1", { jobId: "cat-j1", at, planName: "p", candidates: [
      { url: "https://c.example/1", title: "已订阅类", sourceId: "s", sourceName: "S", status: "watch", reason: "r", observedAt: at },
      { url: "https://c.example/2", title: "未订阅类", sourceId: "s", sourceName: "S", status: "watch", reason: "r", observedAt: new Date(Date.parse(at) + 1000).toISOString() },
    ], sources: [] });
    const feedInterested = dbModule && (await import("../core/hotspots")).hotspotFeed(
      db.list("discovery"),
      new URLSearchParams("hotspotConsumed=include&hotspotSort=interested"),
      20,
      undefined,
      new Map([["https://c.example/1", "模型动态"]]),
      ["模型动态"],
    );
    assert.equal(feedInterested.items[0].title, "已订阅类", "感兴趣分类应置顶");
    const feedTime = (await import("../core/hotspots")).hotspotFeed(
      db.list("discovery"),
      new URLSearchParams("hotspotConsumed=include&hotspotSort=time"),
      20,
      undefined,
      new Map([["https://c.example/1", "模型动态"]]),
      ["模型动态"],
    );
    assert.equal(feedTime.items[0].title, "未订阅类", "纯时间序应按 lastSeen");
    assert.equal(feedInterested.items[0].category, "模型动态", "行投影带类别");

    // agent/hotspots 投影带 category
    const agentRows = await call("agent/hotspots?days=1&limit=5", "GET", undefined, auth);
    const agentRow = agentRows.body.items.find((x: any) => String(x.url).includes("c.example/1"));
    assert.equal(agentRow.category, "教程实战", "agent 投影未带分类");
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});

test("HN Algolia 解析：title/url 缺失跳过，无 url 回退 HN 讨论页，分数进指标", async () => {
  const { parseHnAlgolia } = await import("../core/hotlists");
  const at = "2026-10-10T00:00:00.000Z";
  const items = parseHnAlgolia({
    hits: [
      { title: "Show HN: 热词雷达", url: "https://example.com/radar", points: 88, num_comments: 12, created_at: "2026-10-09T00:00:00Z", objectID: "1" },
      { title: "Ask HN: 无外链讨论帖", points: 5, objectID: "2" },
      { title: "", objectID: "3" },
    ],
  }, at);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://example.com/radar");
  assert.equal(items[0].metric?.value, "88");
  assert.equal(items[0].publishedAt, "2026-10-09T00:00:00Z");
  assert.equal(items[1].url, "https://news.ycombinator.com/item?id=2");
  assert.equal(items[1].metric?.value, "5");
});
