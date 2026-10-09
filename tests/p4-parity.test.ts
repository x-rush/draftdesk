// PHASE 4 验收：汇总缓存语义一致性与失效守护 + 分页下沉参考对比。
// 参考实现 = 旧内存算法（与本文件内联），新实现必须与它在同一份数据上逐值一致——
// 包括「孤儿消费标记不计入 consumed」的交集语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { consumptionSummary, consumptionHotspotKeys } from "../core/agent-read";
import { urlKey } from "../core/hotspots";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

// 参考实现：与优化前逐字等价（消费 Map + discovery 展开 urlKey 去重 + 交集计数）
function referenceSummary(db: Store, target: "hotspots" | "evidence") {
  const consumed = new Map<string, any>();
  for (const c of db.list<any>("consumption")) if (c.target === target) consumed.set(c.identity, c);
  const byReason: Record<string, number> = {};
  let total = 0, consumedCount = 0;
  if (target === "hotspots") {
    const seen = new Set<string>();
    for (const record of db.list<any>("discovery"))
      for (const candidate of record.candidates || []) {
        const key = urlKey(candidate.url);
        if (seen.has(key)) continue;
        seen.add(key);
        total++;
        const entry = consumed.get(key);
        if (entry) { consumedCount++; byReason[entry.reason] = (byReason[entry.reason] || 0) + 1; }
      }
  } else {
    for (const e of db.list<any>("evidence")) {
      total++;
      const entry = consumed.get(e.id);
      if (entry) { consumedCount++; byReason[entry.reason] = (byReason[entry.reason] || 0) + 1; }
    }
  }
  return { target, total, consumed: consumedCount, remaining: total - consumedCount, byReason };
}

test("汇总缓存：与参考实现逐值一致（含孤儿标记交集语义）、水印失效、unconsume 即时反映", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-summary-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const at = new Date().toISOString();
    // 池：跨两条 discovery 的候选，含一条精确重复（去重语义）
    db.put("discovery", "d1", { jobId: "d1", at, mode: "analysis", candidates: [{ url: "https://a.example/1" }, { url: "https://a.example/2" }] });
    db.put("discovery", "d2", { jobId: "d2", at, mode: "analysis", candidates: [{ url: "https://a.example/2" }, { url: "https://a.example/3" }] });
    // 消费：池内一条 + 孤儿一条（不在任何 discovery 里，参考实现不计入 consumed）
    db.consumeIdentities("hotspots", ["https://a.example/1"], "off-domain", "test", undefined, false);
    db.consumeIdentities("hotspots", ["https://orphan.example/9"], "outdated", "test", undefined, false);

    const fresh = consumptionSummary(db, "hotspots");
    const ref = referenceSummary(db, "hotspots");
    assert.deepEqual(fresh, ref);
    assert.equal(fresh.total, 3);
    assert.equal(fresh.consumed, 1, "孤儿标记不得计入 consumed");
    assert.deepEqual(fresh.byReason, { "off-domain": 1 });

    // 缓存命中路径：再次调用逐值不变
    assert.deepEqual(consumptionSummary(db, "hotspots"), fresh);

    // 守护（PHASE 4-C）：新 discovery 落库后，下一次调用必须反映——无任何手动失效
    db.put("discovery", "d3", { jobId: "d3", at, mode: "analysis", candidates: [{ url: "https://a.example/4" }] });
    const afterAppend = consumptionSummary(db, "hotspots");
    assert.equal(afterAppend.total, 4, "新 discovery 落库但 total 未更新——缓存失效失效");
    assert.deepEqual(afterAppend, referenceSummary(db, "hotspots"));

    // 撤销即时反映（删除行同样改变水印）
    db.unconsumeIdentities("hotspots", ["https://a.example/1"], false);
    const afterUnconsume = consumptionSummary(db, "hotspots");
    assert.equal(afterUnconsume.consumed, 0);
    assert.equal(afterUnconsume.remaining, 4);

    // evidence 目标同口径
    const ev = consumptionSummary(db, "evidence");
    assert.deepEqual(ev, referenceSummary(db, "evidence"));
    // consumptionHotspotKeys 与池交集语义无关，只反映标记集合
    assert.deepEqual([...consumptionHotspotKeys(db)].sort(), ["https://orphan.example/9"]);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("listPaged：分页下沉后与内存排序切片逐项一致、翻页闭合", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-paging-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 30 簇：createdAt 交错（模拟乱序写入），created 已去重的秒级时间戳
    for (let i = 0; i < 30; i++) {
      const createdAt = new Date(Date.UTC(2026, 9, 1 + (i % 5), i % 24, i % 60)).toISOString();
      db.put("clusters", `clu-${String(i).padStart(2, "0")}`, { id: `clu-${String(i).padStart(2, "0")}`, topic: `簇${i}`, memberIds: [], memberCount: 0, kind: "k", createdAt });
    }
    const reference = db.list<any>("clusters").sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
    // 全量翻页（limit=7）与参考序列逐项一致
    let offset = 0, seen = 0;
    while (true) {
      const page: { items: Array<{ id: string }>; total: number } = db.kv.listPaged("clusters", { limit: 7, offset, orderBy: "createdAt", direction: "DESC" });
      for (const [j, item] of page.items.entries()) assert.equal(item.id, reference[seen + j]?.id, `第 ${seen + j} 项顺序不一致`);
      seen += page.items.length;
      assert.equal(page.total, reference.length);
      if (seen >= 30) break;
      offset += 7;
    }
    assert.equal(seen, reference.length);
    // 越界 offset 返回空页、total 仍在
    const beyond = db.kv.listPaged<any>("clusters", { limit: 7, offset: 999, orderBy: "createdAt", direction: "DESC" });
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.total, reference.length);
  } finally {
    db?.close();
    cleanup(dir);
  }
});
