// R10.47：哥飞 pools 只读校验口——外部 Agent（read 令牌）可验证预算闭环，
// 脱敏同 UI 口（token 只回 hasToken）；生产迁移后小拾第 8 步凭此闭环。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1047-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

after(() => { store().close(); rmSync(dir, { recursive: true, force: true }); });

test("R10.47：GET /agent/seoDataSource——read 令牌可读 pools，脱敏不出 token", async () => {
  const db = store();
  db.put("config", "seoDataSource", { enabled: true, provider: "gephei", token: "sk-secret-xyz", autoMetrics: true, autoCollect: false, builtinTierBudget: 60, builtinMetricsBudget: 30, builtinCollectBudget: 100 });
  const token = db.createConnection("r1047", ["read"]).token;
  const r = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/seoDataSource", {
    headers: { host: "127.0.0.1:5173", authorization: "Bearer " + token },
  }), ["agent", "seoDataSource"]);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.enabled, true);
  assert.equal(body.hasToken, true, "脱敏 hasToken");
  assert.equal(JSON.stringify(body).includes("sk-secret"), false, "令牌原文绝不外泄");
  const tier = body.pools.find((p: any) => p.pool === "tier");
  assert.equal(tier.budget, 60, "budget 校验字段在（第 8 步闭环依据）");
  assert.equal(typeof tier.used, "number");
  // 无令牌 401
  const anon = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/seoDataSource", { headers: { host: "127.0.0.1:5173" } }), ["agent", "seoDataSource"]);
  assert.equal(anon.status, 401);
});
