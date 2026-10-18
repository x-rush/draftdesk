// R10.7 五件 P0 守护：证据端点、agent/triage 读口、平台归一 400、覆盖率每源独立、
// 外部机会写口与 appGap 自动转卡。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r107-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
after(() => { store().close(); cleanup(dir); });
const request = (route: string, data?: unknown, headers: Record<string, string> = {}) => {
  const [path, qs] = route.split("?");
  return handle(new Request("http://127.0.0.1:5173/api/v1/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), path.split("/"));
};

test("P0-1：GET /evidence/:id 存在 200 / 缺失 404（原端点不存在恒 404）", async () => {
  const db = store();
  db.put("evidence", "ev-1", { id: "ev-1", title: "证据甲", url: "https://a/1", excerpt: "x", collectedAt: new Date().toISOString(), sourceType: "media", region: "全球", language: "zh", contentLevel: "excerpt", provenance: "t", fingerprint: "f" });
  assert.equal((await request("evidence/ev-1")).status, 200);
  const body = await (await request("evidence/ev-1")).json();
  assert.equal(body.title, "证据甲");
  assert.equal((await request("evidence/nope")).status, 404);
});

test("P0-2：agent/triage/groups 与 archive（read 令牌 200；无令牌 401；组组装含成员）", async () => {
  const db = store();
  db.put("candidate-groups", "tg-job9", { jobId: "job9", planName: "全量采集", day: "2026-10-18", at: new Date().toISOString(), shards: 1, calls: 1, tokens: 1, merges: 0,
    groups: [{ id: "g1", title: "强组", attention: "strong", reason: "r", memberUrls: ["https://a/1"], representativeUrl: "https://a/1", sources: ["S"], angles: [] }] });
  db.put("discovery", "job9", { jobId: "job9", at: new Date().toISOString(), planName: "全量采集", limit: 6, mode: "analysis", sources: [],
    candidates: [{ url: "https://a/1", title: "成员甲", sourceId: "s1", sourceName: "S1", status: "selected", reason: "r", observedAt: new Date().toISOString() }] });
  db.put("triage-archive", "ta-job9", { jobId: "job9", day: "2026-10-18", at: new Date().toISOString(), groups: [{ id: "g2", title: "噪音", reason: "x", memberUrls: ["https://b/1"] }] });
  const reader = db.createConnection("r107 读", ["read"]);
  const auth = { authorization: "Bearer " + reader.token };
  const groups = await request("agent/triage/groups?jobId=job9", undefined, auth);
  assert.equal(groups.status, 200, "read 令牌可读（原 none-scope 对令牌 403）");
  const gb = await groups.json();
  assert.equal(gb.groups[0].members[0].title, "成员甲");
  const archive = await request("agent/triage/archive?jobId=job9", undefined, auth);
  assert.equal(archive.status, 200);
  assert.equal((await archive.json()).items[0].groups.length, 1);
  assert.equal((await request("agent/triage/groups", undefined)).status, 401, "无令牌拒绝");
});

test("P0-4：POST /outlines 平台归一（公众号→gzh；未知值 400 带允许列表）；platform-decision 未知 400", async () => {
  const db = store();
  db.put("clusters", "clu-inbox", { id: "clu-inbox", topic: "收集箱", memberIds: [], memberCount: 0, kind: "inbox", window: "", suggestedPlatforms: [], createdAt: "" });
  const ok = await request("outlines", { clusterId: "clu-inbox", platform: "公众号", contentType: "长文", title: "归一测试" });
  assert.equal(ok.status, 201);
  const okBody = await ok.json();
  assert.equal(okBody.platform, "gzh", "中文标签归一为枚举键");
  const bad = await request("outlines", { clusterId: "clu-inbox", platform: "哔哩哔哩活动平台", contentType: "长文", title: "x" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /gzh/);
  const created = okBody.id;
  const pd = await request(`outlines/${created}/platform-decision`, { platform: "不是平台", decision: "approved" });
  assert.equal(pd.status, 400, "拍板口未知平台拒绝（原静默失效）");
  const pdOk = await request(`outlines/${created}/platform-decision`, { platform: "小红书笔记", decision: "approved" });
  assert.equal(pdOk.status, 200);
  assert.equal(store().get<any>("outlines", created)?.perPlatformDecision?.["xhs-note"], "approved", "标签归一后按平台拍板生效（从库读）");
});

test("P0-5：PUT /agent/opportunities（suggest 令牌写 form 六值；未知 form 400）；from-group 单组转卡", async () => {
  const db = store();
  const writer = db.createConnection("r107 写", ["suggest"]);
  const auth = { authorization: "Bearer " + writer.token, "content-type": "application/json" };
  const ok = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/opportunities", { method: "PUT", headers: { host: "127.0.0.1:5173", ...auth }, body: JSON.stringify({ title: "Agent 深挖卡", oneLiner: "外部主分析产出", form: "web-app", monetization: "订阅" }) }), ["agent", "opportunities"]);
  assert.equal(ok.status, 200);
  const all = db.list<any>("opportunities");
  assert.ok(all.some((o) => o.title === "Agent 深挖卡" && o.form === "web-app" && o.source === "agent"), "外部写卡落库");
  const bad = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/opportunities", { method: "PUT", headers: { host: "127.0.0.1:5173", ...auth }, body: JSON.stringify({ title: "x", oneLiner: "y", form: "web" }) }), ["agent", "opportunities"]);
  assert.equal(bad.status, 400, "旧值 form 拒绝（严格六值）");
  // from-group：用 P0-2 的 job9/g1（无角度无 appGap → 400；再造一组带双线）
  db.put("candidate-groups", "tg-job9", { jobId: "job9", planName: "p", day: "d", at: "", shards: 1, calls: 1, tokens: 1, merges: 0,
    groups: [{ id: "g1", title: "强组", attention: "strong", reason: "r", memberUrls: ["https://a/1"], representativeUrl: "https://a/1", sources: ["S"], angles: [{ platform: "gzh", angle: "深度" }], appGap: "做个工具" }] });
  const fg = await request("opportunities/from-group", { jobId: "job9", groupId: "g1" });
  assert.equal(fg.status, 200);
  const fgb = await fg.json();
  assert.equal(fgb.created, 2, "内容线 1 + 应用 1");
  assert.ok(db.list<any>("opportunities").some((o) => o.dedupeKey === "app:grp:g1"));
});

test("R10.11-1 P0：agent 口 PUT /agent/outlines 平台归一——未知值 400（旧回退曾落库任意字符串）、gzh 201", async () => {
  const db = store();
  db.put("clusters", "clu-inbox", { id: "clu-inbox", topic: "收集箱", memberIds: [], memberCount: 0, kind: "inbox", window: "", suggestedPlatforms: [], createdAt: "" });
  const agent = db.createConnection("r11agent", ["suggest"]);
  const auth = { authorization: "Bearer " + agent.token, "content-type": "application/json" };
  const bad = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/outlines", { method: "PUT", headers: { host: "127.0.0.1:5173", ...auth }, body: JSON.stringify({ clusterId: "clu-inbox", platform: "哔哩哔哩", contentType: "活动解读", title: "x" }) }), ["agent", "outlines"]);
  assert.equal(bad.status, 400, "agent 口未知平台拒绝（与 UI 口同口径）");
  assert.match(await bad.text(), /gzh/);
  const ok = await handle(new Request("http://127.0.0.1:5173/api/v1/agent/outlines", { method: "PUT", headers: { host: "127.0.0.1:5173", ...auth }, body: JSON.stringify({ clusterId: "clu-inbox", platform: "gzh", contentType: "长文", title: "r11 测试" }) }), ["agent", "outlines"]);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).platform, "gzh");
});

test("P0-3 + P0-5：collectAll 覆盖率每源独立计数；appGap 自动转卡不受 consumerMode 门控", async () => {
  const db = store();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  for (const [c, id] of [["meta", "collect-all-done:" + day], ["discovery", "collectall-" + day], ["candidate-groups", "tg-collectall-" + day]] as const) db.del(c as never, id as never);
  db.put("sources", "sA", { id: "sA", name: "源A", type: "rss", url: "https://a/f", sourceType: "media", enabled: true, note: "" });
  db.put("sources", "sB", { id: "sB", name: "源B", type: "rss", url: "https://b/f", sourceType: "media", enabled: true, note: "" });
  const iso = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const reader = (async (s: any) => ({
    items: s.id === "sA"
      ? Array.from({ length: 10 }, (_, i) => ({ title: `A${i}`, url: `https://a/${i}`, excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline" as const }))
      : Array.from({ length: 4 }, (_, i) => ({ title: `B旧${i}`, url: `https://b/${i}`, excerpt: "x", collectedAt: iso(0), sourceType: "media", region: "全球", language: "zh", contentLevel: "headline" as const, publishedAt: iso(48) })),
    warnings: [],
  })) as any;
  const runner = (async () => ({
    text: JSON.stringify({ groups: [
      { members: [0,1,2,3,4,5,6,7,8,9], title: "A 强组", attention: "strong", reason: "r", angles: [{ platform: "gzh", angle: "深度" }], appGap: "配套工具缺口" },
    ] }),
    usage: 10,
  })) as any;
  const { collectAllTick } = await import("../core/collect-all");
  const noon = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()) + "T12:00:00+08:00");
  await collectAllTick(db, runner, reader, noon);
  const rec = db.get<any>("discovery", "collectall-" + day);
  const covA = rec.sources.find((s: any) => s.sourceId === "sA");
  const covB = rec.sources.find((s: any) => s.sourceId === "sB");
  assert.equal(covA.matched, 10, "每源独立 matched（原为跨源累计）");
  assert.equal(covB.matched, 0, "源B 全为前日数据 matched=0");
  assert.equal(covA.selected, 10, "初筛后回填 selected（判级=入模，覆盖率入模率非 0）");
  assert.equal(covB.selected, 0);
  // appGap 自动转卡（external 模式下 collectAll 内联完成，不靠外部触发/consumerMode）
  // R10.11-6：修两处弱断言（|| 优先级死重 + deduqueKey 拼写恒真）
  const appCards = db.list<any>("opportunities").filter((o) => o.dedupeKey?.startsWith("app:grp:"));
  assert.ok(appCards.length >= 1, "appGap 自动出卡（consumerMode=external 不门控）");
  assert.ok(appCards.every((o) => o.form === "web-app" && o.monetization), "应用缺口卡带 form+monetization");
});
