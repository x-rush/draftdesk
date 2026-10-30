// R10.39 会话鉴权验收：三态——未设码零变化 / 设码后未登录 401 / 登录-通-登出全链，
// agent Bearer 不受影响，过期会话拒绝，UI_TOKEN 头令牌通道并存。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1039-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const req = (route: string, init: RequestInit = {}) =>
  handle(new Request("http://127.0.0.1:5173/api/v1/" + route, { headers: { host: "127.0.0.1:5173", ...init.headers }, ...init }), route.split("/"));

after(() => {
  delete process.env.DRAFTDESK_ACCESS_CODE;
  delete process.env.DRAFTDESK_UI_TOKEN;
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.39 ①：未设码（本机默认）——session 探测报未启用，UI API 直通零变化", async () => {
  delete process.env.DRAFTDESK_ACCESS_CODE;
  const probe = await req("session");
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { enabled: false, authenticated: true });
  const outlines = await req("outlines");
  assert.equal(outlines.status, 200, "不设码时 UI API 无需会话（向后完全兼容）");
});

test("R10.39 ②：设码后未登录——UI API 401 SESSION_REQUIRED（不带 www-authenticate 防浏览器弹框）；session/health 豁免", async () => {
  process.env.DRAFTDESK_ACCESS_CODE = "test-code-123";
  const blocked = await req("outlines");
  assert.equal(blocked.status, 401);
  const body = await blocked.json();
  assert.equal(body.code, "SESSION_REQUIRED");
  assert.equal(blocked.headers.get("www-authenticate"), null, "不触发浏览器 BasicAuth 弹框");
  const probe = await req("session");
  assert.deepEqual(await probe.json(), { enabled: true, authenticated: false }, "探测口豁免");
  const health = await req("health");
  assert.ok([200, 404].includes(health.status), "health 不被会话门拦（404=路由不存在也说明未被 401 截胡）");
});

test("R10.39 ③：登录全链——错码 401 / 对码 Set-Cookie / 带 cookie 通 / 登出失效", async () => {
  process.env.DRAFTDESK_ACCESS_CODE = "test-code-123";
  const bad = await req("session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "wrong" }) });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).code, "SESSION_DENIED");

  const ok = await req("session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "test-code-123" }) });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get("set-cookie") || "";
  assert.match(setCookie, /dd_session=[0-9a-f]+/, "发会话 cookie");
  assert.match(setCookie, /HttpOnly/, "HttpOnly");
  assert.match(setCookie, /SameSite=Lax/, "SameSite=Lax");
  const token = /dd_session=([0-9a-f]+)/.exec(setCookie)![1];

  const withCookie = await req("outlines", { headers: { cookie: "dd_session=" + token } });
  assert.equal(withCookie.status, 200, "带会话访问 UI API 通过");

  const out = await req("session", { method: "DELETE", headers: { cookie: "dd_session=" + token } });
  assert.equal(out.status, 200);
  const afterOut = await req("outlines", { headers: { cookie: "dd_session=" + token } });
  assert.equal(afterOut.status, 401, "登出后会话失效");
});

test("R10.39 ④：agent Bearer 不受会话门影响；UI_TOKEN 头令牌通道并存", async () => {
  process.env.DRAFTDESK_ACCESS_CODE = "test-code-123";
  const db = store();
  const token = db.createConnection("r1039", ["read"]).token;
  const agent = await req("agent/stats", { headers: { authorization: "Bearer " + token } });
  assert.equal(agent.status, 200, "agent 令牌鉴权照旧（不经会话门）");

  process.env.DRAFTDESK_UI_TOKEN = "ui-tok-1";
  const viaHeader = await req("outlines", { headers: { "x-draftdesk-ui": "ui-tok-1" } });
  assert.equal(viaHeader.status, 200, "UI_TOKEN 头令牌与会话门并存任一通过");
  delete process.env.DRAFTDESK_UI_TOKEN;
});

test("R10.39 ⑤：过期会话拒绝并惰性清理", async () => {
  process.env.DRAFTDESK_ACCESS_CODE = "test-code-123";
  const db = store();
  db.kv.put("sessions", "expiredtok", { createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = await req("outlines", { headers: { cookie: "dd_session=expiredtok" } });
  assert.equal(r.status, 401, "过期会话拒绝");
  assert.equal(db.kv.get("sessions", "expiredtok"), undefined, "过期会话被惰性清理");
});
