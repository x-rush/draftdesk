// R10.12 守护：trend 近 3 日增量限定 / 总量护栏 / news 窗口收紧
import test from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { generateOpportunities, OPPORTUNITY_DAILY_CAP } from "../core/opportunity";
import { termId } from "../core/seen-terms";

function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
const dayKey = (offset: number) => shanghaiDayOf(new Date(Date.now() - offset * 86400000)); // 上海日同源

function putTerm(db: Store, term: string, opts: { obsByDay?: Record<string, number>; relevance?: string; observations?: number; intent?: string; region?: string; seed?: string }) {
  db.put("seen-terms", termId(term), {
    id: termId(term), term, status: "rising", observations: opts.observations ?? 10, sources: ["a", "b"],
    relatedSearches: [], daysSeen: [], obsByDay: opts.obsByDay ?? {}, firstSeenAt: "", lastSeenAt: "",
    relevance: opts.relevance ?? "strong", region: opts.region ?? "global", serpDedicated: 0,
    ...(opts.intent ? { intent: opts.intent } : {}), ...(opts.seed ? { seed: opts.seed } : {}),
  });
}

test("R10.12-1：trend 只出近 3 日有增量的词——当日增量出卡、4 天前增量不出、无 obsByDay 不出", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1012-trend-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    putTerm(db, "today active tool", { obsByDay: { [dayKey(0)]: 5 }, intent: "comparison" });
    putTerm(db, "3d ago active tool", { obsByDay: { [dayKey(2)]: 3 }, intent: "comparison" });
    putTerm(db, "old stale tool", { obsByDay: { [dayKey(5)]: 8 }, intent: "comparison" });
    putTerm(db, "no obs tool", { intent: "comparison" });
    const r = generateOpportunities(db!, { source: "agent" });
    const cards = db!.list<any>("opportunities");
    const trendCards = cards.filter((o) => (o.signals || []).includes("trend"));
    // 验证近 3 日过滤（用 toolSignalOf 路径——intent=comparison+strong+obs≥2 出 app:term 卡）
    const toolCards = cards.filter((o) => o.dedupeKey?.startsWith("app:term:"));
    assert.ok(toolCards.some((o) => o.term === "today active tool"), "当日增量出卡");
    assert.ok(toolCards.some((o) => o.term === "3d ago active tool"), "3 日内出卡");
    assert.ok(!toolCards.some((o) => o.term === "old stale tool"), "4 天前增量不出（R10.12-1 核心修复）");
    assert.ok(!toolCards.some((o) => o.term === "no obs tool"), "无 obsByDay 不出");
    assert.ok(toolCards.length <= 50, `工具词卡 ≤50（实际 ${toolCards.length}）`);
    void r; void trendCards;
  } finally { db?.close(); cleanup(dir); }
});

test("R10.12-3：出卡总量护栏——达到上限后后续生成器跳过并标 capped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1012-cap-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 塞 250 个当日活跃 trend 词（超护栏 200）
    for (let i = 0; i < 250; i++) putTerm(db, `flood tool ${String(i).padStart(3, "0")}`, { obsByDay: { [dayKey(0)]: 3 }, intent: "comparison" });
    const r = generateOpportunities(db!, { source: "agent" });
    assert.ok(r.created <= OPPORTUNITY_DAILY_CAP, `护栏生效（created=${r.created} ≤ ${OPPORTUNITY_DAILY_CAP}）`);
    assert.equal(r.capped, true, "标记 capped");
    const total = db!.list<any>("opportunities").length;
    assert.ok(total <= OPPORTUNITY_DAILY_CAP, `库内总数不超护栏（${total}）`);
  } finally { db?.close(); cleanup(dir); }
});

test("R10.12-2：news 窗口 3 日——4 天前的 evidence 不出 news 卡", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1012-news-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("sources", "s-official", { id: "s-official", name: "官方", type: "rss", url: "https://official.example/feed", officialDomains: ["official.example"], sourceType: "official", enabled: true, note: "" });
    db.put("evidence", "ev-old", { id: "ev-old", title: "Old launch: tool released 5 days ago", url: "https://official.example/old", excerpt: "official launch price cut", collectedAt: new Date(Date.now() - 5 * 86400000).toISOString(), sourceType: "official", region: "全球", language: "en", contentLevel: "excerpt" });
    db.put("evidence", "ev-new", { id: "ev-new", title: "New launch: tool released today", url: "https://official.example/new", excerpt: "official launch price cut deprecat", collectedAt: new Date().toISOString(), sourceType: "official", region: "全球", language: "en", contentLevel: "excerpt" });
    generateOpportunities(db!, { source: "agent" });
    const newsCards = db!.list<any>("opportunities").filter((o) => (o.signals || []).includes("news") && o.dedupeKey.startsWith("app:ev:"));
    assert.ok(newsCards.some((o) => o.title.includes("New launch")), "3 日内的官方新品出卡");
    assert.ok(!newsCards.some((o) => o.title.includes("Old launch")), "4 天前的不出（窗口收紧到 3 日）");
  } finally { db?.close(); cleanup(dir); }
});
