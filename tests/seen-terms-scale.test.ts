// 热词词表规模化验收（词表分页批）：3 万条灌入后
// 分页 <100ms / 雷达三区 <50ms / q 搜索 <100ms（kv.sqlRows 下推，SQLite C 层）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { querySeenTerms, seenTermZones, seenIntentCounts } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const TOTAL = 30000;

test("3 万条 seen-terms：分页 <100ms、三区 <50ms、q 搜索 <100ms，口径正确", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-seen-scale-"));
  try {
    const db = new Store(dir);
    const now = Date.now();
    db.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        const bucket = i % 10;
        const status = bucket < 8 ? "new" : bucket < 9 ? "rising" : "sustained";
        const intent = ["informational", "commercial", "question", "comparison"][i % 4];
        const ageDays = i % 30;
        const obs = status === "new" ? (i % 3) : 3 + (i % 10);
        db.put("seen-terms", `w${i}`, {
          id: `w${i}`,
          term: i % 5 === 0 ? `long tail word number ${i} guide` : `词${i}`,
          status,
          intent,
          observations: obs,
          sources: ["suggest-expansion"],
          relatedSearches: [],
          seed: `seed${i % 100}`,
          firstSeenAt: new Date(now - ageDays * 86400000).toISOString(),
          lastSeenAt: new Date(now - (i % 3) * 86400000).toISOString(),
          daysSeen: status === "sustained" ? ["2026-10-08", "2026-10-09", "2026-10-10"].slice(0, 1 + (i % 3)) : [],
          offTopic: i % 50 === 0,
          producedBy: "suggest-expansion/1.0.0",
          createdAt: new Date(now - ageDays * 86400000).toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    });
    assert.equal(db.list("seen-terms").length, TOTAL);
    const kv = db.kv;
    // 预热（JIT/页缓存），随后各测 3 次取最大
    querySeenTerms(kv, { limit: 50, offset: 0 });
    seenTermZones(kv);
    querySeenTerms(kv, { limit: 50, offset: 0, q: "guide" });
    const time = (fn: () => unknown) => {
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        fn();
        runs.push(performance.now() - t0);
      }
      return Math.max(...runs);
    };
    const pageMs = time(() => querySeenTerms(kv, { limit: 50, offset: 15000 }));
    const zonesMs = time(() => seenTermZones(kv));
    const searchMs = time(() => querySeenTerms(kv, { limit: 50, offset: 0, q: "guide" }));
    console.log(`    [压测] 分页 ${pageMs.toFixed(1)}ms / 三区 ${zonesMs.toFixed(1)}ms / 搜索 ${searchMs.toFixed(1)}ms`);
    assert.ok(pageMs < 100, `分页 ${pageMs.toFixed(1)}ms 超 100ms 预算`);
    assert.ok(zonesMs < 50, `三区 ${zonesMs.toFixed(1)}ms 超 50ms 预算`);
    assert.ok(searchMs < 100, `搜索 ${searchMs.toFixed(1)}ms 超 100ms 预算`);
    // 口径抽查
    const list = querySeenTerms(kv, { limit: 50, offset: 0 });
    assert.equal(list.items.length, 50);
    assert.ok(list.total >= TOTAL);
    const weights: Record<string, number> = { sustained: 0, rising: 1, new: 2 };
    for (let i = 1; i < list.items.length; i++) {
      const a = list.items[i - 1], b = list.items[i];
      assert.ok(weights[a.status] <= weights[b.status], "status 权重应升序");
      if (a.status === b.status) assert.ok((a.lastSeenAt || "") >= (b.lastSeenAt || ""), "同状态 lastSeenAt 降序");
    }
    const zones = seenTermZones(kv);
    assert.ok(zones.fresh.items.every((t: any) => t.status === "new"), "新词区只含 new");
    assert.ok(zones.fresh.items.length <= 20 && zones.fresh.total > 0);
    assert.ok(zones.hot.items.every((t: any) => t.observations >= 3 && Date.parse(t.firstSeenAt) >= Date.now() - 7 * 86400000 && !t.offTopic), "突增区 obs≥3 且 7 天内非圈外");
    assert.ok(zones.sustained.items.every((t: any) => t.status === "sustained"), "持续区只含 sustained");
    const byDays = (t: any) => (t.daysSeen || []).length;
    for (let i = 1; i < zones.sustained.items.length; i++)
      assert.ok(byDays(zones.sustained.items[i - 1]) >= byDays(zones.sustained.items[i]), "持续区按 daysSeen 长度降序");
    const filtered = querySeenTerms(kv, { limit: 10, offset: 0, status: "rising", intent: "question", q: "guide" });
    assert.ok(filtered.items.every((t: any) => t.status === "rising" && t.intent === "question" && t.id.includes("guide") === false), "筛选叠加生效");
    assert.ok(filtered.items.every((t: any) => t.term.includes("guide") || t.term.includes("word")), "q 命中 term");
    const counts = seenIntentCounts(kv);
    assert.equal(counts.all, TOTAL);
  } finally { cleanup(dir); }
});
