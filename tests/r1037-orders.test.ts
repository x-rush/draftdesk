// R10.37 验收：A-2 窗口豁免 + janitor 四类归档 + B-2 归档读口/恢复往返 + C④ 同步环同簇 +
// C⑧ draft 状态门 + C① deferred 翻回 + A-1 setDecision 写 per（服务端部分；UI 并集见组件测试）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1037-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const request = (route: string, data?: unknown, method?: string) => {
  const [p, q] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + p + (q ? "?" + q : ""), {
    method: method || (data === undefined ? "GET" : "POST"),
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), p.split("/"));
};
async function jsonReq(route: string, data?: unknown, method?: string) {
  const r = await request(route, data, method);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

test("R10.37 A-2①：窗口豁免——在途态（approved/drafting/deferred）超 7 天可见，终态/pending 出队", () => {
  const db = store();
  for (const [id, decision, age] of [
    ["out-wf-approved", "approved", 12], ["out-wf-drafting", "drafting", 12], ["out-wf-deferred", "deferred", 12],
    ["out-wf-rejected", "rejected", 12], ["out-wf-published", "published", 12], ["out-wf-pending", "pending", 12],
    ["out-wf-fresh", "pending", 2],
  ] as const) {
    db.put("outlines", id, { id, clusterId: "clu-wf", platform: "gzh", title: "窗口 " + id, decision, decidedAt: d(age), createdAt: d(age) });
  }
  const q = db.decisionsQueue().map((r: any) => r.id);
  for (const id of ["out-wf-approved", "out-wf-drafting", "out-wf-deferred"]) assert.ok(q.includes(id), id + " 在途超窗可见");
  for (const id of ["out-wf-rejected", "out-wf-published", "out-wf-pending"]) assert.ok(!q.includes(id), id + " 超 7 天出队");
  assert.ok(q.includes("out-wf-fresh"), "窗内 pending 可见");
  const all = db.decisionsQueue(undefined, { includeAll: true }).map((r: any) => r.id);
  assert.ok(all.includes("out-wf-rejected"), "includeAll 全量");
});

test("R10.37 A-2②/B-1：janitor 四类归档——pending 7 天 / 已拍 30 天（decidedAt 起算）+ decisions 手动卡一并治理", async () => {
  const db = store();
  const { archiveExpiredOrders } = await import("../core/janitor");
  db.put("outlines", "out-aj-pending-old", { id: "out-aj-pending-old", clusterId: "c1", platform: "gzh", title: "八天待拍", decision: "pending", createdAt: d(8) });
  db.put("outlines", "out-aj-pending-fresh", { id: "out-aj-pending-fresh", clusterId: "c1", platform: "gzh", title: "三天待拍", decision: "pending", createdAt: d(3) });
  db.put("outlines", "out-aj-approved-old", { id: "out-aj-approved-old", clusterId: "c1", platform: "gzh", title: "已批三十五天", decision: "approved", decidedAt: d(35), createdAt: d(40) });
  db.put("outlines", "out-aj-approved-mid", { id: "out-aj-approved-mid", clusterId: "c1", platform: "gzh", title: "已批二十天", decision: "approved", decidedAt: d(20), createdAt: d(45) });
  db.put("outlines", "out-aj-rejected-old", { id: "out-aj-rejected-old", clusterId: "c1", platform: "gzh", title: "已否三十五天", decision: "rejected", decidedAt: d(35), createdAt: d(40) });
  db.put("decisions", "dec-manual-old", { id: "dec-manual-old", title: "八天前手动卡", decision: "pending", createdAt: d(8) });
  const r = archiveExpiredOrders(db);
  // 同文件共享库：A-2① 的 out-wf-pending（12 天）也会被本轮归档，故断言具体 id 而非精确总数
  assert.ok(r.outlines >= 3, "本轮至少归档 3 条大纲");
  for (const id of ["out-aj-pending-old", "out-aj-approved-old", "out-aj-rejected-old"]) assert.ok(db.get("outlines-archive", id), id + " 已归档");
  assert.equal(r.decisions >= 1, true, "手动卡 pending 满 7 天一并归档");
  assert.equal(db.get<any>("outlines-archive", "out-aj-approved-old").expiredReason, "archived-approved", "在途态归档带 staled 口径原因");
  assert.equal(db.get<any>("outlines-archive", "out-aj-rejected-old").expiredReason, "archived-rejected");
  assert.ok(db.get("outlines", "out-aj-approved-mid"), "已批 20 天（<30）保留主集合");
  assert.ok(db.get("outlines", "out-aj-pending-fresh"), "三天待拍保留");
  assert.ok(db.get("decisions-archive", "dec-manual-old"), "手动卡进 decisions-archive");
});

test("R10.37 B-2①：归档读口——总览/分页/白名单/未知集合 404", async () => {
  const overview = await jsonReq("archives");
  assert.equal(overview.status, 200);
  const names = overview.body.items.map((x: any) => x.collection);
  assert.ok(names.includes("outlines-archive") && names.includes("outlines-merge-archive"), "白名单集合在总览");
  const page = await jsonReq("archives/outlines-archive?limit=2&offset=0");
  assert.equal(page.status, 200);
  assert.ok(Array.isArray(page.body.items) && typeof page.body.total === "number", "分页形状");
  assert.ok(page.body.items.length <= 2, "limit 生效");
  const bad = await jsonReq("archives/secret-collection");
  assert.equal(bad.status, 404);
  assert.equal(bad.body.code, "ARCHIVE_UNKNOWN", "机器码");
});

test("R10.37 B-2②：恢复往返——归档行移回主集合、剥离归档标记、同 id 冲突 409", async () => {
  const db = store();
  db.put("outlines-archive", "out-rt-1", { id: "out-rt-1", clusterId: "c9", platform: "gzh", platforms: ["gzh"], title: "往返测试", decision: "pending", createdAt: d(2), archivedAt: d(1), expiredReason: "expired-7d" });
  const restore = await jsonReq("archives/outlines-archive/out-rt-1/restore", {});
  assert.equal(restore.status, 200, "恢复 200");
  assert.equal(restore.body.restoredTo, "outlines");
  const back = db.get<any>("outlines", "out-rt-1");
  assert.ok(back, "回主集合");
  assert.equal(back.expiredReason, undefined, "归档标记剥离");
  assert.equal(back.restoredAt !== undefined, true, "带 restoredAt 溯源");
  assert.equal(db.get("outlines-archive", "out-rt-1"), undefined, "归档侧删除");
  // 冲突：主集合已有同 id
  db.put("outlines-archive", "out-rt-2", { id: "out-rt-2", title: "冲突源", createdAt: d(2), archivedAt: d(1) });
  db.put("outlines", "out-rt-2", { id: "out-rt-2", clusterId: "c9", platform: "gzh", title: "冲突目标", decision: "pending", createdAt: d(1) });
  const conflict = await jsonReq("archives/outlines-archive/out-rt-2/restore", {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "ARCHIVE_RESTORE_CONFLICT");
});

test("R10.37 B-2③：归档 90 天清理（含 merge-archive 与 opportunities-archive）", async () => {
  const db = store();
  const { purgeExpiredArchives } = await import("../core/janitor");
  db.put("outlines-archive", "arc-old", { id: "arc-old", title: "九十五天", createdAt: d(95), archivedAt: d(95) });
  db.put("outlines-archive", "arc-new", { id: "arc-new", title: "十天", createdAt: d(10), archivedAt: d(10) });
  db.put("outlines-merge-archive", "mrg-old", { id: "mrg-old", title: "迁移残留九十五天", createdAt: d(95), archivedAt: d(95) });
  db.put("opportunities-archive", "opp-old", { id: "opp-old", title: "机会卡九十五天", createdAt: d(95), archivedAt: d(95) });
  const purged = purgeExpiredArchives(db);
  assert.ok(purged >= 3, "三个超龄归档被清");
  assert.equal(db.get("outlines-archive", "arc-old"), undefined);
  assert.equal(db.get("outlines-merge-archive", "mrg-old"), undefined);
  assert.equal(db.get("opportunities-archive", "opp-old"), undefined);
  assert.ok(db.get("outlines-archive", "arc-new"), "窗内归档保留");
});

test("R10.37 C④：platform-decision 行级同步收紧为同簇——跨簇同标题不再被连拍", async () => {
  const db = store();
  const stamp = d(1);
  db.put("clusters", "clu-sync-a", { id: "clu-sync-a", topic: "同步簇A", memberIds: [], kind: "news", createdAt: stamp });
  db.put("clusters", "clu-sync-b", { id: "clu-sync-b", topic: "同步簇B", memberIds: [], kind: "news", createdAt: stamp });
  // 两簇同标题同平台（48h 外，标题去重不拦；旧实现会跨簇误同步）
  db.put("outlines", "out-sync-a", { id: "out-sync-a", clusterId: "clu-sync-a", platform: "gzh", title: "同名选题", decision: "pending", createdAt: d(9) });
  db.put("outlines", "out-sync-b", { id: "out-sync-b", clusterId: "clu-sync-b", platform: "gzh", title: "同名选题", decision: "pending", createdAt: d(8) });
  const r = await jsonReq("outlines/out-sync-a/platform-decision", { platform: "gzh", decision: "approved" });
  assert.equal(r.status, 200);
  assert.equal(db.get<any>("outlines", "out-sync-a").decision, "approved");
  assert.equal(db.get<any>("outlines", "out-sync-b").decision, "pending", "跨簇同标题不再被连拍（R10.37 C④）");
  // 同簇旧克隆行仍同步
  db.put("outlines", "out-sync-a-tbh", { id: "out-sync-a-tbh", clusterId: "clu-sync-a", platform: "tiebuhao", title: "同名选题", decision: "pending", createdAt: d(9) });
  const r2 = await jsonReq("outlines/out-sync-a-tbh/platform-decision", { platform: "tiebuhao", decision: "approved" });
  assert.equal((r2.body as any).synced, 0, "主行 gzh 平台不同不算同步对象");
  assert.equal(db.get<any>("outlines", "out-sync-a-tbh").decision, "approved");
});

test("R10.37 C⑧（实断言）：draft 状态门三态", async () => {
  const db = store();
  db.put("outlines", "out-df-pending", { id: "out-df-pending", clusterId: "c", platform: "gzh", title: "待拍", decision: "pending", createdAt: d(1) });
  db.put("outlines", "out-df-approved", { id: "out-df-approved", clusterId: "c", platform: "gzh", title: "已批", decision: "approved", createdAt: d(1) });
  db.put("outlines", "out-df-rejected", { id: "out-df-rejected", clusterId: "c", platform: "gzh", title: "已否", decision: "rejected", createdAt: d(1) });
  const token = db.createConnection("r1037draft2", ["suggest"]).token;
  const put = (id: string) => handle(new Request(`http://127.0.0.1:5173/api/v1/agent/decisions/${id}/draft/x`, {
    method: "PUT", headers: { host: "127.0.0.1:5173", "content-type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ draftBody: "草稿正文".repeat(30) }),
  }), ["agent", "decisions", id, "draft", "x"]);
  assert.equal((await put("out-df-pending")).status, 400, "pending 不可写稿");
  assert.equal((await put("out-df-approved")).status, 200, "approved 可写稿");
  assert.equal((await put("out-df-rejected")).status, 400, "rejected 不可写稿");
  const resp = await put("out-df-pending");
  const body = await resp.json().catch(() => ({}));
  assert.equal(body.code, "NOT_DRAFTABLE", "机器码");
});

test("R10.37 C①：deferred→pending 行级翻回（不触发消费撤销）+ A-1：setDecision 写 per 全集", async () => {
  const db = store();
  db.put("outlines", "out-fl-deferred", {
    id: "out-fl-deferred", clusterId: "c", platform: "gzh", platforms: ["gzh", "xhs-note", "tiebuhao"],
    title: "暂缓翻转", decision: "deferred", perPlatformDecision: { gzh: "deferred", "xhs-note": "deferred", tiebuhao: "deferred" },
    decidedAt: d(2), createdAt: d(3),
  });
  const flip = await jsonReq("outlines/out-fl-deferred/decision", { decision: "pending" });
  assert.equal(flip.status, 200, "deferred 可翻回 pending（R10.37 C①）");
  assert.equal(flip.body.decision, "pending");
  assert.equal(flip.body.perPlatformDecision, undefined, "翻回清 per（沿用 R10.35 裁决语义）");
  // A-1：行级拍板写 per 全集——徽章与行级永远一致
  const approve = await jsonReq("outlines/out-fl-deferred/decision", { decision: "approved" });
  assert.equal(approve.status, 200);
  const row = db.get<any>("outlines", "out-fl-deferred");
  assert.deepEqual(row.perPlatformDecision, { gzh: "approved", "xhs-note": "approved", tiebuhao: "approved" }, "行级 approved 同步写 per 全集");
  // 非 outline 集合不写 per
  db.put("decisions", "dec-manual-2", { id: "dec-manual-2", title: "手动卡", decision: "pending", createdAt: d(1) });
  const dm = await jsonReq("decisions/dec-manual-2/decision", { decision: "approved" });
  assert.equal(dm.status, 200);
  assert.equal(db.get<any>("decisions", "dec-manual-2").perPlatformDecision, undefined, "manual 卡无 per 概念");
});

test("R10.37 B-1：GET /outlines 窗口分页——默认近 7 天+在途豁免，?all=1 全量，limit/offset 生效", async () => {
  const db = store();
  db.put("outlines", "out-gw-old-rej", { id: "out-gw-old-rej", clusterId: "c", platform: "gzh", title: "十二天前已否", decision: "rejected", decidedAt: d(12), createdAt: d(12) });
  db.put("outlines", "out-gw-old-appr", { id: "out-gw-old-appr", clusterId: "c", platform: "gzh", title: "十二天前已批", decision: "approved", decidedAt: d(12), createdAt: d(12) });
  db.put("outlines", "out-gw-fresh", { id: "out-gw-fresh", clusterId: "c", platform: "gzh", title: "两天前待拍", decision: "pending", createdAt: d(2) });
  const page = await jsonReq("outlines?limit=2&offset=0");
  assert.equal(page.status, 200);
  const ids = page.body.items.map((x: any) => x.id);
  assert.ok(!ids.includes("out-gw-old-rej") || page.body.total > 2, "默认窗口滤终态超窗（或分页截断）");
  const win = await jsonReq("outlines?limit=100");
  const winIds = win.body.items.map((x: any) => x.id);
  assert.ok(!winIds.includes("out-gw-old-rej"), "终态 12 天出窗");
  assert.ok(winIds.includes("out-gw-old-appr"), "在途态豁免");
  assert.ok(winIds.includes("out-gw-fresh"), "窗内可见");
  const all = await jsonReq("outlines?all=1&limit=100");
  assert.ok(all.body.items.some((x: any) => x.id === "out-gw-old-rej"), "all=1 全量");
  assert.equal((await jsonReq("outlines?limit=1")).body.items.length, 1, "limit 生效");
});

test("R10.37 C③：GET /clusters 带 outlineCount——建大纲表单「该簇已有大纲 N 条」数据源", async () => {
  const db = store();
  db.put("clusters", "clu-count", { id: "clu-count", topic: "计数簇", memberIds: [], kind: "news", createdAt: d(1) });
  db.put("clusters", "clu-empty2", { id: "clu-empty2", topic: "空簇", memberIds: [], kind: "news", createdAt: d(1) });
  db.put("outlines", "out-cnt-1", { id: "out-cnt-1", clusterId: "clu-count", platform: "gzh", title: "一", decision: "pending", createdAt: d(1) });
  db.put("outlines", "out-cnt-2", { id: "out-cnt-2", clusterId: "clu-count", platform: "gzh", title: "二", decision: "pending", createdAt: d(1) });
  const r = await jsonReq("clusters");
  assert.equal(r.status, 200);
  assert.equal(r.body.items.find((c: any) => c.id === "clu-count").outlineCount, 2, "簇带活跃大纲计数");
  assert.equal(r.body.items.find((c: any) => c.id === "clu-empty2").outlineCount, 0, "空簇计 0");
});

test("R10.37 C⑦：AppError 机器码抽查——UI 写口未知平台带 UNKNOWN_PLATFORM", async () => {
  const db = store();
  db.put("clusters", "clu-code", { id: "clu-code", topic: "机器码簇", memberIds: [], kind: "news", createdAt: d(1) });
  const bad = await jsonReq("outlines", { clusterId: "clu-code", platform: "知乎", contentType: "长文", title: "未知平台验码" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "UNKNOWN_PLATFORM", "机器码可程序化分支（不再字符串匹配）");
});
