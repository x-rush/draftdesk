// Part 4/5 守护测试：seo-terms upsert（term 身份键/category+intent 分离/站群字段/suggest 门槛）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("seo-terms：term 身份键 upsert 幂等、category/intent 分离、站群字段、suggest 门槛", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-seo-"));
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

    const conn = await call("connections", "POST", { name: "seo-agent", scopes: ["read", "suggest"] });
    const auth = conn.body.token;
    const noAuth = await call("agent/seo-terms", "PUT", { items: [{ term: "本地部署 qwen" }] });
    assert.ok([401, 403].includes(noAuth.res.status));

    const put1 = await call("agent/seo-terms", "PUT", { items: [
      { term: "本地部署 Qwen", frequency: 5, sources: ["微信公众号", "知乎"], lastSeenAt: "2026-10-10T00:00:00.000Z", trend7d: "上升", category: "开发工具", intent: "怎么装", sourceUrls: ["https://s.example/1"], siteCandidate: true, domainSuggestions: ["qwen-deploy.com", "本地产英文.cn"], siteType: "工具站", siteRationale: "部署教程需求集中", contentOutline: ["环境准备", "模型下载", "常见报错"] },
      { term: "免费替代 cursor", frequency: 3, intent: "免费替代", category: "成本额度" },
    ] }, auth);
    assert.equal(put1.res.status, 200);

    // term 身份键大小写归一：重写覆盖而非新增
    const put2 = await call("agent/seo-terms", "PUT", { items: [{ term: "本地部署 qwen", frequency: 7 }] }, auth);
    assert.equal(put2.res.status, 200);
    const list = await call("agent/seo-terms", "GET", undefined, auth);
    assert.equal(list.body.total, 2);
    const qwen = list.body.items.find((t: any) => t.term.toLowerCase() === "本地部署 qwen");
    assert.equal(qwen.frequency, 7, "后写覆盖");
    assert.equal(qwen.category, "开发工具", "部分更新不应清掉既有字段");
    assert.deepEqual(qwen.domainSuggestions, ["qwen-deploy.com", "本地产英文.cn"]);
    assert.equal(qwen.siteType, "工具站");
    assert.equal(qwen.siteCandidate, true);

    // 非法 intent 拒绝
    const bad = await call("agent/seo-terms", "PUT", { items: [{ term: "x", intent: "不存在意图" }] }, auth);
    assert.equal(bad.res.status, 400);
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});
