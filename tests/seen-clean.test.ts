// 种子池污染清洗守护（清洗批①③④）：血缘反查 BFS 归档、白名单豁免、
// judgeSeenTerm 只写判定不虚增观测、优先级 off>strong>weak、回填判定跳过 archived。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { cleanSeedPollution } from "../core/seen-clean";
import { judgeSeenTerm, observeSeenTerm, termId } from "../core/seen-terms";
import { judgeUnjudgedTerms } from "../core/seen-extract";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function putTerm(db: Store, term: string, extra: Record<string, unknown> = {}) {
  db.put("seen-terms", termId(term), {
    id: termId(term), term, status: "rising", observations: 3, sources: ["rss"], relatedSearches: [],
    firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), daysSeen: [], ...extra,
  });
}

test("清洗：11 跑题种子 + 血缘家族词归档出库；白名单豁免；无关词不动", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-clean-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 根（跑题种子本体，含繁体/英文变体）
    putTerm(db, "自动驾驶", { relevance: "strong" });
    putTerm(db, "自動駕駛", { relevance: "strong" });
    putTerm(db, "自动点击器");
    // 家族一代：seed 指向根
    putTerm(db, "自动驾驶 等级划分", { seed: "自动驾驶" });
    putTerm(db, "tesla fsd 订阅", { seed: "tesla" });
    // 家族二代：seed 指向一代（BFS 传递闭包）
    putTerm(db, "fsd 价格", { seed: "tesla fsd 订阅" });
    // 白名单（④ 别误伤）：血缘沾了污染种子也必须活
    putTerm(db, "AI短剧授权平台", { seed: "自动驾驶" });
    putTerm(db, "AI生成内容版权");
    putTerm(db, "claude skills 教程");
    // 无关 clean 词
    putTerm(db, "n8n 工作流", { seed: "n8n", relevance: "strong" });
    const report = cleanSeedPollution(db);
    assert.equal(report.roots, 3, "三个种子本体出池");
    assert.equal(report.family, 3, "三个家族词（含二代）出池");
    assert.equal(report.archived, 6);
    for (const term of ["自动驾驶", "自動駕駛", "自动点击器", "自动驾驶 等级划分", "tesla fsd 订阅", "fsd 价格"]) {
      const doc: any = db.get<any>("seen-terms", termId(term));
      assert.equal(doc.status, "archived", `${term} 应归档`);
      assert.equal(doc.relevance, "off");
      assert.equal(doc.offTopic, true);
      assert.equal(doc.archivedReason, "seed-pollution-clean-v1");
    }
    for (const term of ["AI短剧授权平台", "AI生成内容版权", "claude skills 教程", "n8n 工作流"]) {
      const doc: any = db.get<any>("seen-terms", termId(term));
      assert.notEqual(doc.status, "archived", `${term} 白名单/无关词不应被动`);
    }
    // 幂等：再跑一遍 0 归档
    const again = cleanSeedPollution(db);
    assert.equal(again.archived, 0);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("judgeSeenTerm：只写 relevance 不动观测；优先级 off>strong>weak；off 联动 offTopic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-judge-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const first = observeSeenTerm(db, "某个词", { sources: ["hn-algolia"] });
    assert.equal(first.observations, 1);
    assert.equal(first.relevance, undefined);
    // strong 写入
    judgeSeenTerm(db, "某个词", "strong");
    const strong = db.get<any>("seen-terms", termId("某个词"));
    assert.equal(strong.relevance, "strong");
    assert.equal(strong.observations, 1, "判定不得虚增观测");
    assert.equal(strong.daysSeen.length, 1, "判定不动 daysSeen");
    // weak 不许打回 strong
    judgeSeenTerm(db, "某个词", "weak");
    assert.equal(db.get<any>("seen-terms", termId("某个词")).relevance, "strong");
    // off 可覆盖 strong（安全优先）并联动 offTopic
    judgeSeenTerm(db, "某个词", "off");
    const off = db.get<any>("seen-terms", termId("某个词"));
    assert.equal(off.relevance, "off");
    assert.equal(off.offTopic, true);
    assert.equal(off.observations, 1);
    // 不存在的词：静默无操作
    assert.equal(judgeSeenTerm(db, "不存在的词", "strong"), undefined);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("回填判定：只判未判定词（archived/已判跳过），空池零调用", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backfill-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    putTerm(db, "词甲", { relevance: undefined, observations: 5 });
    putTerm(db, "词乙", { relevance: undefined, observations: 3 });
    putTerm(db, "已判词", { relevance: "strong" });
    putTerm(db, "归档词", { status: "archived", relevance: undefined });
    let calls = 0;
    const mockRunner = async () => {
      calls++;
      return { text: JSON.stringify([{ term: "词甲", relevance: "strong" }, { term: "词乙", relevance: "off" }, { term: "归档词", relevance: "strong" }]) };
    };
    const judged = await judgeUnjudgedTerms(db, mockRunner);
    assert.equal(calls, 1);
    assert.equal(judged, 2, "只有两个未判定词被写");
    assert.equal(db.get<any>("seen-terms", termId("词甲")).relevance, "strong");
    assert.equal(db.get<any>("seen-terms", termId("词乙")).relevance, "off");
    assert.equal(db.get<any>("seen-terms", termId("词乙")).offTopic, true);
    assert.equal(db.get<any>("seen-terms", "归档词").relevance, undefined, "archived 不被回填改写");
    // 空池：不再调用模型
    const judged2 = await judgeUnjudgedTerms(db, mockRunner);
    assert.equal(judged2, 0);
    assert.equal(calls, 1, "空池应零成本跳过");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
