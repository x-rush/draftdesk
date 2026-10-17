// 批A P0 守护（社区安全/计费审查，2026-10-17）：
// P0-1 DRAFTDESK_UI_TOKEN 门控 + seoDataSource baseUrl 白名单；
// P0-3 siteGateAutoMark 授权门/英文过滤/批量化（autoMetrics=false 零付费调用）。
// P0-2（topic-dedupe 读 decision）由 geo-collect-dedupe 重建后的 fixture 守护。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-batcha-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");
const { siteGateAutoMark } = await import("../core/seo-gate");
const { termId } = await import("../core/seen-terms");
const { decidedTopics } = await import("../core/topic-dedupe");

function cleanup(d: string) {
  try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}
const request = (route: string, data?: unknown, headers: Record<string, string> = {}) =>
  handle(
    new Request("http://127.0.0.1:5173/api/v1/" + route, {
      method: data === undefined ? "GET" : "POST",
      headers: { host: "127.0.0.1:5173", ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    route.split("/"),
  );

after(() => {
  store().close();
  cleanup(dir);
});

// ---- P0-1a UI 令牌门 ----
test("UI_TOKEN：设置后无令牌 401（带 WWW-Authenticate），三种携带方式均放行；未设置维持现状", async () => {
  const db = store();
  db.put("config", "main", { ...(db.config() || {} as any), baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", profile: "p", apiKey: "k", dailyTokenLimit: 600000 });
  process.env.DRAFTDESK_UI_TOKEN = "secret-ui-token";
  try {
    const bare = await request("health");
    assert.equal(bare.status, 401);
    assert.equal(bare.headers.get("www-authenticate")?.startsWith("Basic"), true, "浏览器可弹 Basic 提示");
    assert.equal((await request("health", undefined, { "x-draftdesk-ui": "secret-ui-token" })).status, 200, "X-DraftDesk-UI 头放行");
    assert.equal((await request("health", undefined, { authorization: "Bearer secret-ui-token" })).status, 200, "Bearer 放行");
    assert.equal((await request("health", undefined, { authorization: "Basic " + Buffer.from("user:secret-ui-token").toString("base64") })).status, 200, "Basic 密码位放行");
    assert.equal((await request("health", undefined, { "x-draftdesk-ui": "wrong" })).status, 401, "错令牌拒");
  } finally {
    delete process.env.DRAFTDESK_UI_TOKEN;
  }
  assert.equal((await request("health")).status, 200, "未设置令牌=本地模式不受影响");
});

// ---- P0-1b baseUrl 白名单 ----
test("seoDataSource baseUrl 白名单：非允许域 400；官方域与 EXTRA_HOSTS 放行", async () => {
  const evil = await request("seoDataSource", { baseUrl: "https://evil.example/api" });
  assert.equal(evil.status, 400);
  assert.match(await evil.text(), /seo\.web\.cafe/);
  const ok = await request("seoDataSource", { baseUrl: "https://seo.web.cafe/api/v1" });
  assert.equal(ok.status, 200);
  process.env.DRAFTDESK_SEO_EXTRA_HOSTS = "gephei-mock.local";
  try {
    const extra = await request("seoDataSource", { baseUrl: "http://gephei-mock.local:8919/api/v1" });
    assert.equal(extra.status, 200, "自建端点经环境变量追加放行");
  } finally {
    delete process.env.DRAFTDESK_SEO_EXTRA_HOSTS;
  }
});

// ---- P0-3 siteGateAutoMark ----
function seedGateTerm(db: any, term: string, extra: Record<string, unknown> = {}) {
  db.put("seen-terms", termId(term), { id: termId(term), term, status: "rising", observations: 5, sources: ["a", "b"], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "", relevance: "strong", region: "global", serpDedicated: 0, ...extra });
}

test("siteGateAutoMark：autoMetrics=false 零付费调用（英文降级词照常标注 valueUnverified 口径）", async () => {
  const db = store();
  db.put("config", "seoDataSource", { enabled: true, token: "t", builtinMetricsBudget: 200, autoMetrics: false });
  seedGateTerm(db, "ai resume builder");
  let fetchCalls = 0;
  const result = await siteGateAutoMark(db, (async () => { fetchCalls++; throw new Error("不应发生任何付费调用"); }) as typeof fetch);
  assert.equal(fetchCalls, 0, "autoMetrics=false 时不得触碰付费接口（关闭=零扣费合同）");
  assert.equal(result.enriched, 0);
  assert.ok(db.get<any>("seo-terms", "ai resume builder")?.siteCandidate === true, "降级口径照常出标");
  db.del("seen-terms", termId("ai resume builder"));
  db.del("seo-terms", "ai resume builder");
});

test("siteGateAutoMark：autoMetrics=true 时英文词攒批一次调用（3 词=1×volume+1×difficulty），中文词不进付费通道", async () => {
  const db = store();
  db.put("config", "seoDataSource", { enabled: true, token: "t", builtinMetricsBudget: 200, autoMetrics: true, baseUrl: "https://seo.web.cafe" });
  for (const w of ["ai resume builder", "cover letter generator", "pdf merger tool", "中文热词示例"]) seedGateTerm(db, w);
  const hits: string[] = [];
  const fakeFetch = (async (url: any, init?: any) => {
    const u = String(url);
    hits.push(u.slice(u.lastIndexOf("/") + 1));
    const body = JSON.parse(init?.body || "{}");
    const words: string[] = body.keywords || [];
    if (u.includes("keyword_volume")) return new Response(JSON.stringify({ data: { keywords: Object.fromEntries(words.map((w) => [w, { avg: 1200, avgCpc: 0.8 }])) } }), { status: 200 });
    if (u.includes("bulk_keyword_difficulty")) return new Response(JSON.stringify({ data: { keywords: Object.fromEntries(words.map((w) => [w, 12])) } }), { status: 200 });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  const result = await siteGateAutoMark(db, fakeFetch);
  const volumeCalls = hits.filter((h) => h.includes("keyword_volume")).length;
  const kdCalls = hits.filter((h) => h.includes("difficulty")).length;
  assert.equal(volumeCalls, 1, "3 个英文词一批一次 volume（不再逐词）");
  assert.equal(kdCalls, 1, "一批一次 difficulty");
  assert.ok(result.enriched >= 3, "三英文词全部富集");
  assert.equal(db.get<any>("seen-terms", termId("中文热词示例"))?.gepheiFetchedAt, undefined, "中文词不进付费通道（R8-3 口径）");
  for (const w of ["ai resume builder", "cover letter generator", "pdf merger tool", "中文热词示例"]) { db.del("seen-terms", termId(w)); db.del("seo-terms", w); }
});

// ---- P0-2 守护（与 geo-collect-dedupe 重建 fixture 互补：直接验证字段口径）----
test("decidedTopics：读 outlines.decision（生产写入字段），pending 不进已拍库", () => {
  const db = store();
  db.put("outlines", "out-a1", { id: "out-a1", title: "approved topic alpha", decision: "approved", outline: ["p1"], createdAt: "" });
  db.put("outlines", "out-a2", { id: "out-a2", title: "pending topic beta", decision: "pending", outline: ["p1"], createdAt: "" });
  db.put("outlines", "out-a3", { id: "out-a3", title: "drafting topic gamma", decision: "drafting", outline: ["p1"], createdAt: "" });
  const topics = decidedTopics(db).map((t) => t.title);
  assert.ok(topics.includes("approved topic alpha"));
  assert.ok(topics.includes("drafting topic gamma"));
  assert.ok(!topics.includes("pending topic beta"), "pending 不算已拍板");
  for (const id of ["out-a1", "out-a2", "out-a3"]) db.del("outlines", id);
});
