// R10.58 机会卡拍板状态机：POST /opportunities/:id/status（UI 会话口）+ agent 合并保留 status
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1058-"));
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
after(() => { store().close(); cleanup(dir); });
const request = (route: string, data?: unknown) => {
  const [p] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), p.split("/"));
};
const post = (route: string, data: unknown) => handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
  method: "POST", headers: { host: "127.0.0.1:5173", "content-type": "application/json" }, body: JSON.stringify(data),
}), route.split("?")[0].split("/"));

test("R10.58：机会卡拍板状态机——合法态直设/非法 400/缺失 404", async () => {
  store().put("opportunities", "opp-r1058-seed", { id: "opp-r1058-seed", dedupeKey: "seed-r1058", kind: "site", signals: ["trend"], evidenceIds: [], title: "状态机测试卡", oneLiner: "一句话", form: "tool", verdict: "推荐", verdictReason: "r", verifyPlan: [], source: "agent", createdAt: new Date().toISOString() });
  const all = JSON.parse((await (await request("opportunities?limit=10")).text()));
  const card = all.items.find((o: any) => o.title === "状态机测试卡");
  assert.ok(card, "写入卡存在");
  assert.equal(card.status, undefined, "新卡缺省无 status=待拍板");
  const r1 = await (await post(`opportunities/${card.id}/status`, { status: "approved" })).json();
  assert.equal(r1.status, "approved");
  assert.equal(r1.statusBy, "human");
  assert.ok(r1.statusAt);
  assert.equal(r1.title, "状态机测试卡", "其余字段原值");
  const r2 = await (await post(`opportunities/${card.id}/status`, { status: "launched" })).json();
  assert.equal(r2.status, "launched", "任意态直设（非线性限制）");
  const bad = await post(`opportunities/${card.id}/status`, { status: "rejected" });
  assert.equal(bad.status, 400);
  const missing = await post("opportunities/opp-nope/status", { status: "approved" });
  assert.equal(missing.status, 404);
});

test("R10.58：agent 合并不丢 status（upsert ...prev 打底）", async () => {
  const { writeAgentOpportunity } = await import("../core/opportunity");
  const db = store();
  const draft = { title: "合并保留测试卡", oneLiner: "一句话", form: "tool" as const, term: "r1058-merge" };
  writeAgentOpportunity(db, draft);
  const all = JSON.parse((await (await request("opportunities?limit=20")).text()));
  const card = all.items.find((o: any) => o.title === "合并保留测试卡");
  const r = await (await post(`opportunities/${card.id}/status`, { status: "developing" })).json();
  assert.equal(r.status, "developing");
  writeAgentOpportunity(db, draft); // 同 dedupeKey 二次写入=合并路径
  const after = db.get<any>("opportunities", card.id);
  assert.equal(after.status, "developing", "agent 合并后 status 保留");
  assert.equal(after.statusBy, "human");
});
