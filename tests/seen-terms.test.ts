// 热词捕获守护测试：晋级状态机（obs≥2→rising / 连续3天→sustained）、
// 双写合并语义（sources 并集/observations max/status 只升不降）、API 门槛与幂等。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { observeSeenTerm, has3Consecutive } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("晋级状态机：obs≥2→rising；daysSeen 严格连续 3 天→sustained；archived 不被机器改写", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-seen-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const d = (offset: number) => new Date(Date.UTC(2026, 9, 10 + offset)).toISOString().slice(0, 10);
    // 首见
    const first = observeSeenTerm(db, "现象级新词", { day: d(0) });
    assert.equal(first.status, "new");
    assert.equal(first.observations, 1);
    // 第二次观测 → rising
    const second = observeSeenTerm(db, "现象级新词", { day: d(1) });
    assert.equal(second.status, "rising");
    assert.equal(second.observations, 2);
    // 断续日期不晋级（缺连续）
    const gap = observeSeenTerm(db, "现象级新词", { day: d(3) });
    assert.equal(gap.status, "rising");
    assert.equal(gap.daysSeen.length, 3);
    // 连续 3 天 → sustained
    const d1 = observeSeenTerm(db, "现象级新词", { day: d(4) });
    const d2 = observeSeenTerm(db, "现象级新词", { day: d(5) });
    assert.equal(d1.status, "rising");
    assert.equal(d2.status, "sustained");
    assert.ok(has3Consecutive([d(3), d(4), d(5)]));
    assert.ok(!has3Consecutive([d(0), d(1), d(3)]));
    // archived 不被机器晋级改写
    db.put("seen-terms", "archived-词", { id: "archived-词", term: "archived-词", status: "archived", observations: 9, daysSeen: [], firstSeenAt: at0(), lastSeenAt: at0(), sources: [] });
    const arch = observeSeenTerm(db, "archived-词", { day: d(0) });
    assert.equal(arch.status, "archived");
  } finally {
    db?.close();
    cleanup(dir);
  }
  function at0() { return new Date().toISOString(); }
});

test("双写合并：sources 并集 / observations max / status 只升不降 / API 门槛", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-seen-api-"));
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
    const conn = await call("connections", "POST", { name: "seen-agent", scopes: ["read", "suggest"] });
    const auth = conn.body.token;
    const noAuth = await call("agent/seen-terms", "PUT", { items: [{ term: "x" }] });
    assert.ok([401, 403].includes(noAuth.res.status));

    // 内置首见（observations=1, status new）→ API merge（observations=5, status rising, sources 并集）
    const db = (await import("../core/store")).store();
    observeSeenTerm(db, "爆火词", { sources: ["bilibili-popular"], day: "2026-10-10" });
    const put = await call("agent/seen-terms", "PUT", { items: [{ term: "爆火词", sources: ["hacker-news-top"], frequency: 5, status: "rising" }] }, auth);
    assert.equal(put.res.status, 200);
    const list = await call("seen-terms", "GET");
    const row = list.body.items.find((x: any) => x.term === "爆火词");
    assert.equal(row.observations, 5, "observations 取 max");
    assert.equal(row.status, "rising", "status 只升不降");
    assert.deepEqual(row.sources.sort(), ["bilibili-popular", "hacker-news-top"], "sources 并集");
    // 降级尝试被拒：status sustained→new 不生效
    await call("agent/seen-terms", "PUT", { items: [{ term: "爆火词", status: "new" }] }, auth);
    const list2 = await call("seen-terms", "GET");
    assert.equal(list2.body.items.find((x: any) => x.term === "爆火词").status, "rising", "status 不应降级");
    // UI 读口
    assert.equal(list.res.status, 200);
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});

test("observations 语义（复验序列）：PUT obs=1→读回1；不带 obs→不变；PUT obs=3→读回3；status 只升不降回归", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-obs-"));
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
    const conn = await call("connections", "POST", { name: "obs-agent", scopes: ["read", "suggest"] });
    const auth = conn.body.token;
    // ① PUT observations=1 → 读回 1
    const p1 = await call("agent/seen-terms", "PUT", { items: [{ term: "X", observations: 1 }] }, auth);
    assert.equal(p1.res.status, 200, JSON.stringify(p1.body).slice(0, 120));
    const r1 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r1.observations, 1, "GET 应返回 observations 字段");
    // ② PUT 不带 observations → 读回仍 1
    await call("agent/seen-terms", "PUT", { items: [{ term: "X", lastSeenAt: "2026-10-10T00:00:00.000Z" }] }, auth);
    const r2 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r2.observations, 1, "增量更新不应清零 observations");
    // ③ PUT observations=3 → 读回 3
    await call("agent/seen-terms", "PUT", { items: [{ term: "X", observations: 3 }] }, auth);
    const r3 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r3.observations, 3);
    // ④ status 只升不降回归：new → rising 生效；rising → new 拒绝降级
    await call("agent/seen-terms", "PUT", { items: [{ term: "X", status: "rising" }] }, auth);
    const r4 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r4.status, "rising");
    await call("agent/seen-terms", "PUT", { items: [{ term: "X", status: "new", observations: 3 }] }, auth);
    const r5 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r5.status, "rising", "status 不应降级");
    assert.equal(r5.observations, 3);
    // frequency 兼容：两者都传取大者
    await call("agent/seen-terms", "PUT", { items: [{ term: "X", observations: 2, frequency: 9 }] }, auth);
    const r6 = (await call("agent/seen-terms", "GET", undefined, auth)).body.items.find((x: any) => x.term === "X");
    assert.equal(r6.observations, 9, "observations 与 frequency 同传应取大者");
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});
