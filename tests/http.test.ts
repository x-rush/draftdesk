import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { envelope, topic } from "./fixtures";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-http-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const request = (
  route: string,
  data?: unknown,
  headers: Record<string, string> = {},
) =>
  handle(
    new Request("http://127.0.0.1:5173/api/v1/" + route, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        host: "127.0.0.1:5173",
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    route.split("/"),
  );
after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});
test("搜索诊断独立于模型，未配置时不发请求，配置后验证真实返回结构", async () => {
  const db = store();
  const config = db.config();
  db.put("config", "main", { ...config, tavilyKey: undefined });
  assert.equal((await request("test-search", {})).status, 400);
  const original = globalThis.fetch;
  let calls = 0;
  try {
    db.put("config", "main", { ...config, tavilyKey: "test-tavily" });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.tavily.com/search");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.search_depth, "basic");
      assert.equal(body.max_results, 1);
      calls++;
      return Response.json({ results: [{title:"Test",url:"https://example.org"}] });
    };
    assert.equal((await request("test-search", {})).status, 200);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; db.put("config", "main", config); }
});
test("HTTP 外部令牌仅能收件，不能读工作区或修改策略", async () => {
  const r = await request("connections", { name: "OpenClaw" });
  const c = await r.json();
  assert.equal(r.status, 200);
  const before=store().list("receipts").length;
  assert.equal((await request("intake-check",{probe:true},{Authorization:"Bearer "+c.token})).status,200);
  const preflight=await request("intake-check",envelope(),{Authorization:"Bearer "+c.token});
  assert.equal(preflight.status,200);assert.equal((await preflight.json()).ok,true);
  assert.equal((await request("intake-check",{},{Authorization:"Bearer "+c.token})).status,400);
  assert.equal((await request("intake-check",{probe:true},{Authorization:"Bearer invalid"})).status,401);
  assert.equal(store().list("receipts").length,before);
  assert.equal(
    (
      await request("workspace", undefined, {
        Authorization: "Bearer " + c.token,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("plans", {}, { Authorization: "Bearer " + c.token })).status,
    403,
  );
  assert.equal((await request("history/any",undefined,{Authorization:"Bearer "+c.token})).status,403);
  assert.equal(
    (
      await request("intake", envelope(), {
        Authorization: "Bearer " + c.token,
      })
    ).status,
    201,
  );
  assert.equal((await request("intake", envelope())).status, 401);
  await request("revoke", { id: c.id });
  assert.equal(
    (
      await request("intake", envelope(), {
        Authorization: "Bearer " + c.token,
      })
    ).status,
    401,
  );
});
test("HTTP 公开投影不泄露证据、讨论、应用与密钥", async () => {
  const db = store();
  db.put("config", "main", {
    ...db.config(),
    apiKey: "private-api-key",
    tavilyKey: "private-search-key",
  });
  const a = db.saveArtifact(topic, "job", "ready", []);
  db.updateArtifact({ id: a.id, revision: 1, visibility: "public" });
  db.put("conversations", "secret", {
    id: "secret",
    title: "私人对话",
    messages: [{ role: "user", content: "不能公开" }],
  });
  const publicData = await (await request("public")).json();
  const output = JSON.stringify(publicData);
  assert.ok(output.includes(topic.title));
  [
    "private-api-key",
    "private-search-key",
    "不能公开",
    "excerpt",
    "claims",
  ].forEach((s) => assert.ok(!output.includes(s)));
  const config = await (await request("workspace")).json();
  assert.equal(config.config.hasApiKey, true);
  assert.ok(!JSON.stringify(config).includes("private-api-key"));
});
test("HTTP 拒绝跨站提交与超限正文，下载技能包是真实 tar", async () => {
  assert.equal(
    (
      await request(
        "connections",
        { name: "bad" },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("import", { text: "x".repeat(1000001) })).status,
    413,
  );
  const r = await request("skill-bundle");
  assert.equal(r.status, 200);
  const raw = Buffer.from(await r.arrayBuffer());
  assert.equal(raw.subarray(257, 262).toString(), "ustar");
  assert.ok(raw.includes(Buffer.from("scripts/submit.py")));
});
