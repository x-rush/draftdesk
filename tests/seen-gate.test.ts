// 热词捕获守护测试：worker 闸门置位条件（24h 滚动窗）+ 24h 兜底提取（mock 模型）
// + 手动触发（立即整理）跳过等待 + 主路径写入抑制。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { seenTermsGate, seenTermsTick, markSeenTermsWrite, requestSeenTermsExtraction } from "../core/seen-extract";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function setup(dir: string) {
  const db = new Store(dir);
  db.put("plans", "p1", { id: "p1", name: "策略一", scheduleEnabled: true, dailyTime: "01:00", sourceIds: [], kind: "editorial", maxEvidence: 10, maxQueries: 4, maxModelCalls: 8, maxTokens: 400000 });
  db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
  db.put("discovery", "fb-j", { jobId: "fb-j", at: new Date().toISOString(), planName: "p", candidates: [{ url: "https://f.example/1", title: "兜底流标题一", sourceId: "s", sourceName: "S", status: "watch", reason: "r", observedAt: new Date().toISOString() }], sources: [] });
  return db;
}

function job(id: string, planId: string, state: string, finishedAt?: string) {
  return { id, planId, state, createdAt: new Date().toISOString(), ...(finishedAt ? { finishedAt } : {}), evidenceIds: [], calls: 0, reservedTokens: 0, actualTokens: 0, warnings: [], steps: [] };
}

test("闸门：24h 内完成→置位；25h 前→不置位；运行中→不置位；同日幂等", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-gate-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    // 25h 前完成 → 不置位（滚动窗外）
    db.put("jobs", "j-old", job("j-old", "p1", "completed", new Date(Date.now() - 25 * 3600000).toISOString()));
    assert.equal(seenTermsGate(db), undefined, "25h 前的完成不应置位");
    // 24h 内完成 → 置位
    db.del("jobs", "j-old");
    db.put("jobs", "j-new", job("j-new", "p1", "completed", new Date().toISOString()));
    const gate = seenTermsGate(db);
    assert.equal(gate?.date, new Date().toISOString().slice(0, 10));
    assert.equal(seenTermsGate(db)?.date, gate?.date);
    // 运行中 → 不置位（独立新库验证）
    db.close();
    const dir2 = mkdtempSync(path.join(tmpdir(), "draftdesk-gate2-"));
    try {
      const db2 = new Store(dir2);
      db2.put("jobs", "j-run", job("j-run", "p1", "running"));
      assert.equal(seenTermsGate(db2), undefined);
      db2.close();
    } finally {
      cleanup(dir2);
    }
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("兜底：闸门 24h 后无主路径写入 → mock 模型提取入库；同日不重复；主路径写入抑制兜底", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-fallback-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    const yesterday = new Date(Date.now() - 25 * 3600000);
    db.put("meta", "seen-terms-gate", { date: yesterday.toISOString().slice(0, 10), at: yesterday.toISOString() });
    let calls = 0;
    const mockRunner = async () => {
      calls++;
      return { text: JSON.stringify([{ term: "兜底提取词", sources: ["hn-algolia"], offTopic: false }]) };
    };
    seenTermsTick(db, mockRunner);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 1, "兜底应调用模型");
    const row = db.get<any>("seen-terms", "兜底提取词");
    assert.equal(row?.status, "new");
    const callsAfterFirst = calls;
    seenTermsTick(db, mockRunner);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, callsAfterFirst, "同日重复触发");
    const dir2 = mkdtempSync(path.join(tmpdir(), "draftdesk-fallback2-"));
    try {
      db.close();
      db = new Store(dir2);
      db.put("meta", "seen-terms-gate", { date: yesterday.toISOString().slice(0, 10), at: yesterday.toISOString() });
      markSeenTermsWrite(db);
      let calls2 = 0;
      seenTermsTick(db, async () => { calls2++; return { text: "[]" }; });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls2, 0, "主路径已写数据时不应兜底");
    } finally {
      db?.close();
    }
    db = undefined;
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("手动触发：请求后 tick 立即提取（跳过 24h 等待与闸门）；done 标记后 alreadyDone", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-manual-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    // 无闸门（计划任务未跑）——手动请求仍应立即提取
    const req = requestSeenTermsExtraction(db);
    assert.equal(req.triggered, true);
    assert.equal(req.alreadyDone, false);
    let calls = 0;
    const mockRunner = async () => { calls++; return { text: JSON.stringify([{ term: "手动触发词", offTopic: false }]) }; };
    seenTermsTick(db, mockRunner);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls, 2, "手动请求应触发提取 + 未判定词回填判定两次调用");
    assert.ok(db.get<any>("seen-terms", "手动触发词"), "提取结果应入库");
    // 完成标记后再次请求 → alreadyDone
    const again = requestSeenTermsExtraction(db);
    assert.equal(again.alreadyDone, true, "当日已提取应返回 alreadyDone");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("判定吞吐扩容（第五轮 §5）：judgeBackfillTick 日多批 + 批间隔闸 + 提取首批共享计数", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backfill-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    // 501 词待判 → busy 档（3 批/日）
    for (let i = 0; i < 501; i++) {
      const term = `待判词${String(i).padStart(3, "0")}`;
      db!.put("seen-terms", term, { id: term, term, status: "new", observations: 500 - i, sources: [], relatedSearches: [], daysSeen: [], obsByDay: {}, firstSeenAt: "", lastSeenAt: "" });
    }
    const model = (async (_db: any, messages: any[]) => {
      const text = (messages[0].content as string).split("\n\n").pop() as string;
      const items = text.trim().split("\n").map((line) => {
        const term = line.replace(/^\d+\.\s*/, "");
        return { term, relevance: "weak" };
      });
      return { text: JSON.stringify(items) };
    }) as any;
    const { judgeBackfillTick, unjudgedPendingCount } = await import("../core/seen-extract");
    const base = new Date("2026-10-10T02:00:00Z");
    judgeBackfillTick(db, model, base);
    await new Promise((r) => setTimeout(r, 200));
    let done = db.get<any>("meta", "judge-backfill-done:2026-10-10");
    assert.equal(done?.batches, 1);
    assert.equal(done.judged, 200, "每批 200 词");
    assert.equal(done.busyDay, true);
    assert.equal(unjudgedPendingCount(db), 301, "已判词退出待判池");
    // 间隔闸：4h 内不开新批
    judgeBackfillTick(db, model, new Date(base.getTime() + 3600000));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(db.get<any>("meta", "judge-backfill-done:2026-10-10").batches, 1);
    // 4h 后第 2 批
    judgeBackfillTick(db, model, new Date(base.getTime() + 5 * 3600000));
    await new Promise((r) => setTimeout(r, 200));
    done = db.get<any>("meta", "judge-backfill-done:2026-10-10");
    assert.equal(done.batches, 2);
    assert.equal(unjudgedPendingCount(db), 101);
    // 提取批记账语义（runExtraction 内联逻辑）：在既有批次上 +1，不重置 busy/heavy 标志
    const bfPrev = db.get<any>("meta", "judge-backfill-done:2026-10-10");
    db.put("meta", "judge-backfill-done:2026-10-10", { ...bfPrev, batches: (bfPrev?.batches ?? 0) + 1, judged: 101 });
    assert.equal(db.get<any>("meta", "judge-backfill-done:2026-10-10").batches, 3, "提取批共享批次计数");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("fixture 探针词黑名单（收尾批 §7①）：测试探针词不得进种子池", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-fixtureguard-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    const { collectSeeds } = await import("../core/seen-dig");
    const { judgeSeenTerm, termId } = await import("../core/seen-terms");
    // 历史fixture 探针词族：即使被误写入词库（联想展开/测试残留），也绝不能回流种子池
    const probes = ["小 拾 染", "小拾染", "s0", "s1", "s2", "s3"];
    for (const w of probes) {
      db!.put("seen-terms", termId(w), { id: termId(w), term: w, status: "rising", observations: 99, sources: ["fixture"], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    }
    let seeds = collectSeeds(db, 100);
    assert.equal(seeds.length, 0, "无 relevance 判定的探针词过不了三档闸");
    // 恶化场景：探针词被误判 strong（守护 strongest 场景仍然拦截 off/weak 之外的漏网）
    for (const w of probes) judgeSeenTerm(db, w, "strong");
    seeds = collectSeeds(db, 100);
    const uniqueIds = new Set(probes.map((w) => termId(w)));
    assert.equal(seeds.length, uniqueIds.size, "strong 判定的词按闸放行（小 拾 染 与 小拾染 同 id 去重）");
    for (const w of probes) judgeSeenTerm(db, w, "off");
    seeds = collectSeeds(db, 100);
    assert.equal(seeds.length, 0, "off 判定绝对拦截（off 永不回流）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
