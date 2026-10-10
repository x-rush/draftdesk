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
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 1, "手动请求应触发提取");
    assert.ok(db.get<any>("seen-terms", "手动触发词"), "提取结果应入库");
    // 完成标记后再次请求 → alreadyDone
    const again = requestSeenTermsExtraction(db);
    assert.equal(again.alreadyDone, true, "当日已提取应返回 alreadyDone");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
