// R10.51 验收：GET /agent/opportunities 只读口（read scope）——写口 PUT 早已闭环，
// 读侧此前 404（小拾简报无法核验池子状态）。守护四点：
// ① read 令牌 200 且形状齐（id/title/form/verdict/createdAt+total）；② 无令牌 401；
// ③ suggest-only 令牌 403（suggest 不隐含 read，读侧需独立权限）；④ 同 pattern 的
// PUT 写口不被 GET 路由截胡（router pattern+method 全匹配优先，agent/clusters 同款先例）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1051b-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const request = (route: string, data?: unknown, method?: string, headers: Record<string, string> = {}) => {
  const [p, q] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + p + (q ? "?" + q : ""), {
    method: method || (data === undefined ? "GET" : "PUT"),
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), p.split("/"));
};

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("R10.51：GET /agent/opportunities——read 令牌 200/形状齐；401/403 分层；PUT 写口不被截胡", async () => {
  const db = store();
  const reader = db.createConnection("r1051 读", ["read"]);
  const writer = db.createConnection("r1051 写", ["suggest"]);
  const readAuth = { authorization: "Bearer " + reader.token };
  const writeAuth = { authorization: "Bearer " + writer.token, "content-type": "application/json" };

  // 无令牌 401
  assert.equal((await request("agent/opportunities")).status, 401);
  // suggest-only 令牌读 → 403（suggest 不隐含 read）
  const forbidden = await request("agent/opportunities", undefined, undefined, { authorization: "Bearer " + writer.token });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "SCOPE_MISMATCH");

  // PUT 写口照常工作（GET 路由注册在前不截胡写路径）
  const put = await request("agent/opportunities", { title: "R10.51 只读口验收卡", oneLiner: "读侧核验用", form: "web-app", monetization: "订阅" }, undefined, writeAuth);
  assert.equal(put.status, 200);
  // 第二张卡（更早 createdAt 排序验证）
  db.put("opportunities", "opp-old", { id: "opp-old", title: "更早的卡", form: "tool", verdict: "不值得做", source: "agent", createdAt: "2026-10-01T00:00:00.000Z" });

  // read 令牌 200 + 形状
  const list = await request("agent/opportunities", undefined, undefined, readAuth);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.total, 2);
  assert.equal(body.items[0].title, "R10.51 只读口验收卡", "createdAt 降序（新卡在前）");
  for (const key of ["id", "title", "form", "verdict", "createdAt"]) assert.ok(key in body.items[0], "字段 " + key + " 在响应内");
  assert.equal(body.items[0].verdict, "待验证", "agent 写卡默认 verdict");
  // 分页
  const page = await request("agent/opportunities?limit=1&offset=1", undefined, undefined, readAuth);
  const pageBody = await page.json();
  assert.equal(pageBody.items.length, 1);
  assert.equal(pageBody.items[0].title, "更早的卡");
});
