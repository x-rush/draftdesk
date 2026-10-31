// R10.12 守护：trend 近 3 日增量限定 / 总量护栏 / news 窗口收紧
import test from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
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

test("R10.40：词信号只入池不出卡——趋势/工具词窗逻辑随 sweep 下线，评估归小拾", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1040-term-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    for (const [i, t] of [["today active tool", 0], ["3d ago active tool", 2], ["old stale tool", 5]].entries()) {
      const now = new Date().toISOString();
      db.put("seen-terms", "t" + i, { id: "t" + i, term: t[0], status: "rising", observations: 5, intent: "comparison", relevance: "strong", obsByDay: { [dayKey(t[1] as number)]: 3 }, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: now, lastSeenAt: now });
    }
    assert.equal(db.list<any>("opportunities").length, 0, "词信号零自动出卡");
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
    // R10.40：news 卡生成器下线——evidence 只存不算卡，官方动态评估归小拾
    assert.equal(db!.list<any>("opportunities").length, 0, "news 零自动出卡");
  } finally { db?.close(); cleanup(dir); }
});
