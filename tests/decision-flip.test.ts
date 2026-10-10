// 决策翻转守护测试（信息架构 v2-C）：rejected→pending 自动撤销联动消费（响应带 unconsumedCount）；
// flip 后手动再撤销同一身份 = 410 notFound（非超窗——即外部复验观察到的现象）；
// 再次 rejected 消费重放（重新隐藏）；非 rejected 状态不可翻转。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("决策翻转：自动撤销联动消费并可观测；flip 后手动撤销=410 notFound；重放重消费；翻转门槛", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-flip-"));
  const previous = process.env.DRAFTDESK_DATA_DIR;
  process.env.DRAFTDESK_DATA_DIR = dir;
  try {
    const { handle } = await import("../core/http");
    const call = async (route: string, method: string, body?: unknown, token?: string) => {
      const res = await handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
        method,
        headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }), route.split("/"));
      return { res, body: await res.json() };
    };

    const conn = await call("connections", "POST", { name: "flip-test", scopes: ["read", "consume", "suggest"] });
    assert.equal(conn.res.status, 200);
    const auth = conn.body.token;
    const created = await call("agent/outlines", "PUT", { clusterId: "clu-inbox", platform: "公众号", contentType: "资讯解读", title: "翻转链路验证", evidenceRefs: ["https://flip.example/1"] }, auth);
    assert.equal(created.res.status, 201, JSON.stringify(created.body).slice(0, 120));

    // 否决 → 联动消费 consumedCount=1
    const rejected = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "rejected", rejectReason: "off-domain" });
    assert.equal(rejected.res.status, 200);
    assert.equal(rejected.body.consumedCount, 1, "否决联动消费应生效");

    // 翻转 pending → 自动撤销联动消费，响应可观测
    const flipped = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "pending" });
    assert.equal(flipped.res.status, 200);
    assert.equal(flipped.body.decision, "pending");
    assert.equal(flipped.body.unconsumedCount, 1, "翻转响应缺少 unconsumedCount");
    assert.equal(flipped.body.unconsumeExpired, 0);
    assert.equal(flipped.body.rejectReason ?? undefined, undefined, "翻转应清空否决原因");

    // flip 已删除消费行：手动再撤销同一身份 = 410 notFound（不是超窗——外部复验观察到的即此场景）
    const manual = await call("agent/unconsume", "POST", { target: "hotspots", ids: ["https://flip.example/1"] }, auth);
    assert.equal(manual.res.status, 410);
    assert.equal(manual.body.notFound, 1, "410 应标 notFound（已撤销过）");

    // 再次 rejected → 消费重放（热点重新隐藏），consumedCount=1
    const reRejected = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "rejected", rejectReason: "其他" });
    assert.equal(reRejected.body.consumedCount, 1, "重放应重新消费");

    // 再翻回 pending → 再次自动撤销
    const flipped2 = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "pending" });
    assert.equal(flipped2.body.unconsumedCount, 1);
    assert.equal(flipped2.body.unconsumeNotFound, 0);

    // 翻转门槛：非 rejected 不可翻
    const approved = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "approved" });
    assert.equal(approved.res.status, 200);
    const gate = await call("outlines/" + created.body.id + "/decision", "POST", { decision: "pending" });
    assert.equal(gate.res.status, 400);
    assert.equal(gate.body.code, "INVALID_PAYLOAD");
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});
