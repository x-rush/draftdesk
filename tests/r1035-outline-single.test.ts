// R10.35 验收：一个选题一条大纲（老大 2026-10-30 拍板）
// —— 大纲不再按平台各写一份：platforms 标注适合投放的平台，recommendation 承载推荐建议；
//    审查台按选题身份（clusterId）聚合；存量多平台行可安全合并（不丢平台、不动已拍板）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1035-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { ensureTiebuhaoClones } = await import("../core/outline-draft");

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

function seedCluster(db: any, id: string) {
  db.put("clusters", id, { id, topic: "选题 " + id, memberIds: [], kind: "news", createdAt: new Date().toISOString() });
}

test("R10.35 ①：一条大纲可声明多个适合平台，platforms[0] 即主平台", async () => {
  const db = store();
  const token = db.createConnection("r1035作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-multi");
  const res = await jsonReq("agent/outlines", {
    clusterId: "clu-multi",
    platforms: ["gzh", "xhs-note", "threads"],
    recommendation: "主投公众号做深度论证，小红书出清单体，Threads 发英文短评引流",
    contentType: "长文",
    title: "一个选题，三个平台各取所需",
    keyPoints: ["平台差异写进推荐建议"],
  }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh", "xhs-note", "threads"]);
  assert.equal(res.body.platform, "gzh", "platform 退化为 platforms[0]");
  assert.equal(res.body.recommendation.includes("公众号做深度论证"), true);
  // 只有一条记录，不是三条
  const all = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-multi");
  assert.equal(all.length, 1, "一个选题只落一条大纲，不再按平台拆行");
});

test("R10.35 ②：平台值归一与去重（中文标签可传、重复平台去掉）", async () => {
  const db = store();
  const token = db.createConnection("r1035b作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-norm");
  const res = await jsonReq("agent/outlines", {
    clusterId: "clu-norm",
    platforms: ["公众号", "gzh", "小红书笔记"],
    contentType: "长文",
    title: "中文标签与重复值归一",
    keyPoints: ["归一测试"],
  }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh", "xhs-note"], "中文标签归一成键、重复平台去重保序");
  assert.equal(res.body.platform, "gzh");
});

test("R10.35 ③：未知平台 400，platforms 与 platform 全空 400", async () => {
  const db = store();
  const token = db.createConnection("r1035c作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-bad");
  const bad = await jsonReq("agent/outlines", { clusterId: "clu-bad", platforms: ["知乎"], contentType: "长文", title: "未知平台" }, auth, "PUT");
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /未知平台/);
  const empty = await jsonReq("agent/outlines", { clusterId: "clu-bad", contentType: "长文", title: "没给平台" }, auth, "PUT");
  assert.equal(empty.status, 400);
  assert.match(String(empty.body.error), /至少给一个/);
});

test("R10.35 ④：只给 platform 的老调用照常工作（platforms 收敛成 [platform]）", async () => {
  const db = store();
  const token = db.createConnection("r1035d作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-legacy");
  const res = await jsonReq("agent/outlines", { clusterId: "clu-legacy", platform: "gzh", contentType: "长文", title: "旧调用兼容", keyPoints: ["兼容"] }, auth, "PUT");
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.platforms, ["gzh"]);
  assert.equal(res.body.platform, "gzh");
  assert.equal(res.body.recommendation, undefined, "未给推荐建议时不留空字段");
});

test("R10.35 ⑤：审查台队列按选题聚合——platforms 透传、summary 来自 keyPoints", async () => {
  const db = store();
  const token = db.createConnection("r1035e作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-queue");
  await jsonReq("agent/outlines", {
    clusterId: "clu-queue", platforms: ["gzh", "xhs-note"], recommendation: "两平台分发",
    contentType: "长文", title: "审查台读口透传", keyPoints: ["要点一", "要点二"],
  }, auth, "PUT");
  // decisions 是 none-scope（仅 UI 会话可达），直接调 store 的队列构造验证透传字段
  const row = db.decisionsQueue("pending").find((r: any) => r.clusterId === "clu-queue");
  assert.ok(row, "队列里能找到该选题");
  assert.deepEqual(row.platforms, ["gzh", "xhs-note"], "platforms 全集透传（前端据此渲染适合平台徽章）");
  assert.equal(row.platform, "gzh");
  assert.equal(row.recommendation, "两平台分发");
  assert.equal(row.summary, "要点一；要点二");
});

test("R10.35 ⑥：资讯类选题补挂贴图号 = 补平台而非克隆新行", () => {
  const db = store();
  seedCluster(db, "clu-tbh");
  const stamp = new Date().toISOString();
  db.put("outlines", "out-tbh-new", {
    id: "out-tbh-new", clusterId: "clu-tbh", platform: "gzh", platforms: ["gzh"],
    category: "news", contentType: "长文", title: "资讯类选题", outline: [], keyPoints: [],
    evidenceRefs: [], decision: "pending", createdAt: stamp,
  });
  const n = ensureTiebuhaoClones(db);
  assert.ok(n >= 1, "有动作");
  const rows = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh");
  assert.equal(rows.length, 1, "新模型下不克隆新行");
  assert.deepEqual(rows[0].platforms, ["gzh", "tiebuhao"], "贴图号补进适合平台");
  // 幂等：再跑一次不再补
  const before = rows[0].platforms.length;
  ensureTiebuhaoClones(db);
  const after2 = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh")[0];
  assert.equal(after2.platforms.length, before, "重复运行幂等");
});

test("R10.35 ⑦：存量老数据（无 platforms）仍走克隆路径，不破坏既有语义", () => {
  const db = store();
  seedCluster(db, "clu-tbh-legacy");
  const stamp = new Date().toISOString();
  db.put("outlines", "out-tbh-legacy", {
    id: "out-tbh-legacy", clusterId: "clu-tbh-legacy", platform: "gzh",
    category: "news", contentType: "长文", title: "老数据资讯选题", outline: [], keyPoints: [],
    evidenceRefs: [], decision: "pending", createdAt: stamp,
  });
  ensureTiebuhaoClones(db);
  const rows = db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-tbh-legacy");
  assert.equal(rows.length, 1, "裁决统一：无 platforms 的老行也走补平台，不再克隆");
  assert.deepEqual(rows[0].platforms, ["gzh", "tiebuhao"], "以 platform 为底补挂 tiebuhao");
});

test("R10.35 ⑧：空壳防线——只有标题无任何内容的大纲 400 拒收", async () => {
  const db = store();
  const token = db.createConnection("r1035f作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-empty");
  const empty = await jsonReq("agent/outlines", { clusterId: "clu-empty", platforms: ["gzh"], contentType: "长文", title: "只有标题的空壳" }, auth, "PUT");
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "EMPTY_OUTLINE");
  assert.match(String(empty.body.error), /空壳大纲/);
  // 带 keyPoints 的正常写入不受影响
  const ok = await jsonReq("agent/outlines", { clusterId: "clu-empty", platforms: ["gzh"], contentType: "长文", title: "有内容的大纲", keyPoints: ["要点"] }, auth, "PUT");
  assert.equal(ok.status, 201);
  // 更新路径（带 id）不受限——老数据补内容走的更新口
  const upd = await jsonReq("agent/outlines", { id: ok.body.id, clusterId: "clu-empty", platforms: ["gzh"], contentType: "长文", title: "有内容的大纲" }, auth, "PUT");
  assert.equal(upd.status, 200, "更新已有大纲不触发空壳防线（保留原内容）");
});

test("R10.35 裁决⑨：UI 手动建大纲口（POST /outlines）接受 platforms+recommendation——修选题助手漏改导致的必 400", async () => {
  const db = store();
  seedCluster(db, "clu-manual");
  // none-scope UI 路由：不带令牌（带令牌反而 403）
  const form = await jsonReq("outlines", {
    clusterId: "clu-manual", platforms: ["公众号", "tiebuhao"], recommendation: "主投公众号，贴图号出图卡",
    contentType: "长文", title: "手动表单多平台",
  });
  assert.equal(form.status, 201);
  assert.deepEqual(form.body.platforms, ["gzh", "tiebuhao"], "UI 口同款归一去重");
  assert.equal(form.body.platform, "gzh");
  assert.equal(form.body.recommendation.includes("主投公众号"), true);
  // 只给 platform 的旧手动形态照常（platforms 收敛单值）
  const legacy = await jsonReq("outlines", { clusterId: "clu-manual", platform: "xhs-note", contentType: "长文", title: "手动旧单平台" });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.body.platforms, ["xhs-note"]);
  // 手动口不设空壳闸：老大手动登记只有标题也放行
  const bare = await jsonReq("outlines", { clusterId: "clu-manual", platform: "gzh", contentType: "长文", title: "手动只有标题" });
  assert.equal(bare.status, 201);
});

test("R10.35 裁决⑩：agent 更新路径只给 platform 不缩水 platforms 集合", async () => {
  const db = store();
  const token = db.createConnection("r1035g作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-keep");
  const created = await jsonReq("agent/outlines", {
    clusterId: "clu-keep", platforms: ["gzh", "xhs-note", "tiebuhao"], contentType: "长文",
    title: "三平台选题", keyPoints: ["要点"],
  }, auth, "PUT");
  assert.equal(created.status, 201);
  // 旧调用只给 platform 更新内容——platforms 必须保持三平台不被悄悄缩成单平台
  const upd = await jsonReq("agent/outlines", { id: created.body.id, clusterId: "clu-keep", platform: "gzh", contentType: "长文", title: "三平台选题改稿", keyPoints: ["要点二"] }, auth, "PUT");
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.body.platforms, ["gzh", "xhs-note", "tiebuhao"], "platforms 保持存量集合");
  assert.equal(upd.body.title, "三平台选题改稿");
  // 显式传 platforms 才会改集合
  const narrow = await jsonReq("agent/outlines", { id: created.body.id, clusterId: "clu-keep", platforms: ["gzh"], contentType: "长文", title: "三平台选题改稿", keyPoints: ["要点二"] }, auth, "PUT");
  assert.equal(narrow.status, 200);
  assert.deepEqual(narrow.body.platforms, ["gzh"], "显式 platforms 覆盖集合");
});

test("R10.35 裁决⑪：同簇防线——48h 内同簇第二条大纲（不同标题）回 duplicate 不落库", async () => {
  const db = store();
  const token = db.createConnection("r1035h作者", ["suggest"]).token;
  const auth = { Authorization: "Bearer " + token };
  seedCluster(db, "clu-dupc");
  const first = await jsonReq("agent/outlines", { clusterId: "clu-dupc", platforms: ["gzh"], contentType: "长文", title: "同簇第一条", keyPoints: ["k"] }, auth, "PUT");
  assert.equal(first.status, 201);
  const second = await jsonReq("agent/outlines", { clusterId: "clu-dupc", platforms: ["xhs-note"], contentType: "长文", title: "同簇换标题再开一条", keyPoints: ["k2"] }, auth, "PUT");
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.sameCluster, true);
  assert.equal(second.body.existingId, first.body.id, "带回 existingId，改内容走 id 更新");
  assert.equal(db.list<any>("outlines").filter((o: any) => o.clusterId === "clu-dupc").length, 1, "仍只有一条");
  // 48h 外的同簇老行不拦（老选题重做）：手工种一条 8 天前的行
  seedCluster(db, "clu-dupold");
  db.put("outlines", "out-old-cluster", { id: "out-old-cluster", clusterId: "clu-dupold", platform: "gzh", platforms: ["gzh"], contentType: "长文", title: "八天前的老选题", keyPoints: ["k"], evidenceRefs: [], decision: "rejected", createdAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  const fresh = await jsonReq("agent/outlines", { clusterId: "clu-dupold", platforms: ["gzh"], contentType: "长文", title: "老选题重做", keyPoints: ["k"] }, auth, "PUT");
  assert.equal(fresh.status, 201, "同簇但超 48h：放行");
});

test("R10.35 裁决⑫：rejected→pending 翻转清 perPlatformDecision——合并行两套状态不打架", async () => {
  const db = store();
  seedCluster(db, "clu-flip");
  const id = "out-flip";
  db.put("outlines", id, {
    id, clusterId: "clu-flip", platform: "gzh", platforms: ["gzh", "xhs-note"], category: "news",
    contentType: "长文", title: "翻转清态", outline: ["a"], keyPoints: ["k"], evidenceRefs: [],
    decision: "rejected", perPlatformDecision: { gzh: "rejected", "xhs-note": "deferred" },
    rejectReason: "空壳大纲", createdAt: new Date().toISOString(),
  });
  const flipped = await jsonReq("outlines/" + id + "/decision", { decision: "pending" }, {}, "POST");
  assert.equal(flipped.status, 200);
  assert.equal(flipped.body.decision, "pending");
  assert.equal(flipped.body.perPlatformDecision, undefined, "per-platform 状态随翻回一并复位");
  assert.equal(flipped.body.rejectReason, undefined);
});
