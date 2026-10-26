// R10.26 验收：P0-1 拍板历史删除守卫 / P0-2 内容线复产链封死 / 4① 增量合并+判级保留 /
// 4② 标题归一化去重+跨零点窗 / 4④ job 伴生级联 / 4⑤ budget-audit retention
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1026-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { generateOpportunities } = await import("../core/opportunity");
const { purgeTerminalJobs, purgeBudgetAuditKeys } = await import("../core/janitor");

const request = (route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) => {
  const [pathPart, query] = route.split("?");
  return handle(
    new Request("http://127.0.0.1:5173/api/v1/" + pathPart + (query ? "?" + query : ""), {
      method: method || (data === undefined ? "GET" : data === null ? "PATCH" : "POST"),
      headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    pathPart.split("/"),
  );
};
async function jsonReq(route: string, data?: unknown, headers: Record<string, string> = {}, method?: string) {
  const r = await request(route, data, headers, method);
  return { status: r.status, body: await r.json() };
}

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("P0-1：删簇级联保护——含已拍板大纲 400 拒绝，全 pending 簇放行", async () => {
  const db = store();
  const token = db.createConnection("r26作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  db.put("clusters", "clu-decided", { id: "clu-decided", topic: "已拍板簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  db.put("outlines", "out-pending", { id: "out-pending", clusterId: "clu-decided", platform: "gzh", title: "待拍大纲", decision: "pending", createdAt: new Date().toISOString() });
  db.put("outlines", "out-approved", { id: "out-approved", clusterId: "clu-decided", platform: "gzh", title: "已拍大纲", decision: "approved", createdAt: new Date().toISOString() });
  const refused = await jsonReq("agent/clusters/clu-decided", undefined, auth, "DELETE");
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "DECIDED_OUTLINES");
  assert.match(String(refused.body.error), /已拍板大纲 1 条/);
  // 全 pending 簇放行
  db.put("clusters", "clu-fresh", { id: "clu-fresh", topic: "新簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  db.put("outlines", "out-fresh", { id: "out-fresh", clusterId: "clu-fresh", platform: "gzh", title: "新大纲", decision: "pending", createdAt: new Date().toISOString() });
  const ok = await jsonReq("agent/clusters/clu-fresh", undefined, auth, "DELETE");
  assert.equal(ok.status, 200);
  assert.equal(db.get("outlines", "out-fresh"), undefined, "pending 大纲随簇级联删");
  assert.ok(db.get("outlines", "out-approved"), "已拍板大纲保留");
  // 单删口同款守卫
  const single = await jsonReq("agent/outlines/out-approved", undefined, auth, "DELETE");
  assert.equal(single.status, 400);
  assert.equal(single.body.code, "DECIDED_OUTLINE");
});

test("P0-2：generateFromGroups 内联内容线出卡已删——angles-only 组零出卡，appGap 组只出应用卡", async () => {
  const db = store();
  db.put("candidate-groups", "tg-r26a", { jobId: "r26a", planName: "p", day: "d", at: new Date().toISOString(), shards: 0, calls: 0, tokens: 0, merges: 0, source: "external",
    groups: [
      { id: "g-angles-only", title: "只有角度的组", attention: "strong", reason: "r", memberUrls: [], representativeUrl: "", sources: [], angles: [{ platform: "gzh", angle: "角度A" }, { platform: "xhs-note", angle: "角度B" }] },
      { id: "g-with-gap", title: "带缺口组", attention: "strong", reason: "r", memberUrls: [], representativeUrl: "", sources: [], angles: [{ platform: "gzh", angle: "角度C" }], appGap: "做个工具站" },
    ] });
  const before = db.list<any>("opportunities").length;
  const r = generateOpportunities(db, { source: "auto" });
  const cards = db.list<any>("opportunities").slice(before);
  assert.equal(cards.filter((o) => String(o.dedupeKey).startsWith("site:grp:")).length, 0, "内容线卡零产出（内联段已删）");
  assert.ok(cards.some((o) => o.dedupeKey === "app:grp:g-with-gap" && o.form === "web-app"), "appGap 组出应用卡");
  assert.ok(!cards.some((o) => o.dedupeKey === "app:grp:g-angles-only"), "无 appGap 组零出卡");
});

test("4①：PUT groups 增量合并——分片回写不丢前批；缩减重放保留既有判级", async () => {
  const db = store();
  const token = db.createConnection("r26合并", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  db.put("discovery", "r26merge", { jobId: "r26merge", at: new Date().toISOString(), planName: "P", limit: 6, mode: "analysis",
    sources: [{ sourceId: "s1", selected: 0 }], candidates: [
      { url: "https://a/1", sourceId: "s1", status: "watch" },
      { url: "https://a/2", sourceId: "s1", status: "watch" },
      { url: "https://a/3", sourceId: "s1", status: "watch" },
    ] });
  // 第一批 2 组
  const g1 = { id: "g1", title: "组一", attention: "strong", reason: "r", memberUrls: ["https://a/1"] };
  const g2 = { id: "g2", title: "组二", attention: "potential", reason: "r", memberUrls: ["https://a/2"] };
  const first = await jsonReq("agent/triage/groups", { jobId: "r26merge", groups: [g1, g2] }, auth, "PUT");
  assert.equal(first.status, 200);
  assert.equal(first.body.groups, 2);
  // 第二批 1 组（分片）——不丢前批
  const g3 = { id: "g3", title: "组三", attention: "strong", reason: "r", memberUrls: ["https://a/3"] };
  const second = await jsonReq("agent/triage/groups", { jobId: "r26merge", groups: [g3] }, auth, "PUT");
  assert.equal(second.status, 200);
  assert.equal(second.body.groups, 3, "合并后 3 组（前批保留）");
  assert.equal(second.body.mergedKept, 2);
  // 缩减重放（只带 g3）——g1 认领的候选判级保留
  await jsonReq("agent/triage/groups", { jobId: "r26merge", groups: [g3] }, auth, "PUT");
  const disc = db.get<any>("discovery", "r26merge");
  const c1 = (disc.candidates || []).find((c: any) => c.url === "https://a/1");
  assert.equal(c1.attention, "strong", "未认领候选判级保留（不被缩减重放清掉）");
});

test("4②：标题去重归一化——全角+零宽空格变体命中 48h 去重；更新路径同跑查重", async () => {
  const db = store();
  const token = db.createConnection("r26去重", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  db.put("clusters", "clu-dup", { id: "clu-dup", topic: "去重簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  const orig = await jsonReq("agent/outlines", { clusterId: "clu-dup", platform: "gzh", contentType: "长文", title: "Claude 4.5 发布" }, auth, "PUT");
  assert.equal(orig.status, 201);
  // 全角数字+小写+零宽空格变体——归一化后命中
  const variant = await jsonReq("agent/outlines", { clusterId: "clu-dup", platform: "xhs-note", contentType: "长文", title: "claude４.５\u200B发布" }, auth, "PUT");
  assert.equal(variant.status, 200);
  assert.equal(variant.body.duplicate, true, "归一化变体命中去重");
  // 更新路径：把既有大纲改成与另一条 48h 内大纲同题（归一化后）→ duplicate
  const other = await jsonReq("agent/outlines", { clusterId: "clu-dup", platform: "gzh", contentType: "长文", title: "GPT-6 首测" }, auth, "PUT");
  assert.equal(other.status, 201);
  const updateDup = await jsonReq("agent/outlines", { id: orig.body.id, clusterId: "clu-dup", platform: "gzh", contentType: "长文", title: "GPT-6 首测" }, auth, "PUT");
  assert.equal(updateDup.status, 200);
  assert.equal(updateDup.body.duplicate, true, "更新路径同跑标题查重");
});

test("4②：跨零点窗——近 48h 最新 collectall 批无组时写大纲 400", async () => {
  const db = store();
  const token = db.createConnection("r26窗口", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  db.put("discovery", "collectall-r26win", { jobId: "collectall-r26win", at: new Date().toISOString(), planName: "全量采集", limit: 6, mode: "analysis", sources: [], candidates: [] });
  db.put("clusters", "clu-win", { id: "clu-win", topic: "窗口簇", memberIds: [], kind: "news", createdAt: new Date().toISOString() });
  const blocked = await jsonReq("agent/outlines", { clusterId: "clu-win", platform: "gzh", contentType: "长文", title: "窗口测试大纲" }, auth, "PUT");
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "GROUPS_MISSING");
  // 写组后放行
  await jsonReq("agent/triage/groups", { jobId: "collectall-r26win", groups: [{ id: "gw", title: "窗组", attention: "strong" }] }, auth, "PUT");
  const ok = await jsonReq("agent/outlines", { clusterId: "clu-win", platform: "gzh", contentType: "长文", title: "窗口测试大纲" }, auth, "PUT");
  assert.equal(ok.status, 201);
});

test("4④：purgeTerminalJobs 级联清四个伴生集合；4⑤ budget-audit 7 天 retention", () => {
  const db = store();
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  db.put("jobs", "j-old", { id: "j-old", planId: "p", state: "completed", finishedAt: old, updatedAt: old });
  db.put("job-context", "j-old", { id: "j-old", analysis: { x: 1 } });
  db.put("job-draft", "j-old", { id: "j-old", body: "draft" });
  db.put("job-validation", "j-old", { id: "j-old", attempt: 1 });
  db.put("job-verification", "j-old", { id: "j-old", rows: [] });
  assert.equal(purgeTerminalJobs(db), 1);
  for (const c of ["jobs", "job-context", "job-draft", "job-validation", "job-verification"])
    assert.equal(db.get(c, "j-old"), undefined, c + " 伴生已级联清");
  // budget-audit：8 天前键清、当天键留
  db.put("meta", "budget-audit:2026-10-18, 10", { at: old });
  db.put("meta", "budget-audit:2026-10-26, 10", { at: new Date().toISOString() });
  const purged = purgeBudgetAuditKeys(db);
  assert.ok(purged >= 1, "8 天前键被清");
  assert.ok(db.get("meta", "budget-audit:2026-10-26, 10"), "当天键保留");
});
