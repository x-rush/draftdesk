// 小刺收尾守护：①归档路由对不存在 batchId 返回 404（此前静默 ok:true）；
// ②整批证据已消费时重试入队返回 409（此前静默入队→无推荐 no-op）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("归档 404 与重试已消费 409：不再静默 no-op", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-smallfix-"));
  const previous = process.env.DRAFTDESK_DATA_DIR;
  process.env.DRAFTDESK_DATA_DIR = dir;
  try {
    const { handle } = await import("../core/http");
    const { store } = await import("../core/store");
    const call = async (route: string, method: string, body?: unknown) => {
      const res = await handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }), route.split("/"));
      return { res, body: await res.json().catch(() => ({})) };
    };
    const db = store();
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    // ① 归档：存在的批次 ok；不存在的 404
    db.put("activity-batches", "batch-fix-1", { id: "batch-fix-1", platform: "哔哩哔哩", count: 3, receivedAt: new Date().toISOString(), items: [] });
    const ok = await call("activity-batches/archive", "POST", { batchId: "batch-fix-1" });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.body.archived, true);
    const missing = await call("activity-batches/archive", "POST", { batchId: "batch-not-exist" });
    assert.equal(missing.res.status, 404, "不存在的 batchId 必须 404，实际 " + missing.res.status);
    // ② 重试：整批已消费 409；部分消费放行
    db.put("plans", "plan-fix-1", { id: "plan-fix-1", name: "小刺验证", kind: "editorial", goal: "g", audience: "a", keywords: [], excludeKeywords: [], includeDomains: [], sourceIds: ["web"], lookbackDays: 7, maxEvidence: 6, maxQueries: 1, maxItems: 2, maxModelCalls: 4, maxTokens: 100000, scheduleEnabled: false, dailyTime: "01:00", publishPolicy: "manual" });
    const evidence = (id: string) => ({ id, title: "证据" + id, url: "https://fix.example/" + id, excerpt: "摘录", collectedAt: new Date().toISOString(), sourceType: "media" });
    db.put("evidence", "ev-fix-a", evidence("ev-fix-a"));
    db.put("evidence", "ev-fix-b", evidence("ev-fix-b"));
    db.put("evidence", "ev-fix-c", evidence("ev-fix-c"));
    const first = await call("jobs", "POST", { planId: "plan-fix-1", evidenceIds: ["ev-fix-a", "ev-fix-b"] });
    assert.equal(first.res.status, 202, JSON.stringify(first.body).slice(0, 120));
    for (const j of db.list<any>("jobs").filter((x) => x.planId === "plan-fix-1")) db.del("jobs", j.id);
    db.consumeIdentities("evidence", ["ev-fix-a", "ev-fix-b"], "processed-into-artifact", "human", undefined, false);
    const retried = await call("jobs", "POST", { planId: "plan-fix-1", evidenceIds: ["ev-fix-a", "ev-fix-b"] });
    assert.equal(retried.res.status, 409, "整批已消费必须 409，实际 " + retried.res.status);
    assert.match(String(retried.body.error ?? ""), /已消费/);
    const partial = await call("jobs", "POST", { planId: "plan-fix-1", evidenceIds: ["ev-fix-a", "ev-fix-c"] });
    assert.equal(partial.res.status, 202, "部分消费应放行");
    // 清理：避免污染共享单例库中的后续测试
    for (const [collection, id] of [["activity-batches", "batch-fix-1"], ["activity-categories", "batch-fix-1"], ["plans", "plan-fix-1"], ["evidence", "ev-fix-a"], ["evidence", "ev-fix-b"], ["evidence", "ev-fix-c"]] as const)
      db.del(collection, id);
    for (const j of db.list<any>("jobs").filter((x) => x.planId === "plan-fix-1")) db.del("jobs", j.id);
    for (const id of ["evidence:ev-fix-a", "evidence:ev-fix-b"]) db.del("consumption", id);
  } finally {
    process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});
