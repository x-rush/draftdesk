// 热词捕获守护测试：worker 闸门置位条件 + 24h 兜底提取（mock 模型）+ 主路径写入抑制。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { seenTermsGate, seenTermsTick, markSeenTermsWrite } from "../core/seen-extract";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function setup(dir: string) {
  const db = new Store(dir);
  const today = new Date().toISOString().slice(0, 10);
  db.put("plans", "p1", { id: "p1", name: "策略一", scheduleEnabled: true, dailyTime: "01:00", sourceIds: [], kind: "editorial", maxEvidence: 10, maxQueries: 4, maxModelCalls: 8, maxTokens: 400000 });
  return { db, today };
}

test("闸门：当日计划任务全部 completed 且无活跃 → 置位；有运行中 → 不置位", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-gate-"));
  let db: Store | undefined;
  try {
    db = setup(dir).db;
    // 运行中的任务 → 不置位
    db.put("jobs", "j-run", { id: "j-run", planId: "p1", state: "running", createdAt: new Date().toISOString(), evidenceIds: [], calls: 0, reservedTokens: 0, actualTokens: 0, warnings: [], steps: [] });
    assert.equal(seenTermsGate(db), undefined);
    // 完成于今日 → 置位
    db.put("jobs", "j-done", { id: "j-done", planId: "p1", state: "completed", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), evidenceIds: [], calls: 0, reservedTokens: 0, actualTokens: 0, warnings: [], steps: [] });
    db.del("jobs", "j-run");
    const gate = seenTermsGate(db);
    assert.equal(gate?.date, new Date().toISOString().slice(0, 10));
    // 幂等：同日再取返回同闸门
    assert.equal(seenTermsGate(db)?.date, gate?.date);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("兜底：闸门 24h 后无主路径写入 → mock 模型提取入库；同日不重复；主路径写入抑制兜底", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-fallback-"));
  let db: Store | undefined;
  try {
    db = setup(dir).db;
    const yesterday = new Date(Date.now() - 25 * 3600000);
    db.put("meta", "seen-terms-gate", { date: yesterday.toISOString().slice(0, 10), at: yesterday.toISOString() });
    let calls = 0;
    const mockRunner = async () => {
      calls++;
      return { text: JSON.stringify([{ term: "兜底提取词", sources: ["hn-algolia"], offTopic: false }]) };
    };
    // 兜底前置条件：模型 Key 已配置（无 Key 静默跳过是设计行为）
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    // 标题流素材（兜底从 discovery 候选取标题）
    db.put("discovery", "fb-j", { jobId: "fb-j", at: new Date().toISOString(), planName: "p", candidates: [{ url: "https://f.example/1", title: "兜底流标题一", sourceId: "s", sourceName: "S", status: "watch", reason: "r", observedAt: new Date().toISOString() }], sources: [] });
    // 闸门 24h 前置位、无写入 → 兜底提取
    seenTermsTick(db, mockRunner);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 1, "兜底应调用模型");
    const row = db.get<any>("seen-terms", "兜底提取词");
    assert.equal(row?.status, "new");
    // 同日不重复兜底（fallback meta 幂等）
    const callsAfterFirst = calls;
    seenTermsTick(db, mockRunner);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, callsAfterFirst, "同日重复触发");
    // 主路径写入（晚于闸门）→ 抑制兜底
    const dir2 = mkdtempSync(path.join(tmpdir(), "draftdesk-fallback2-"));
    try {
      db.close();
      db = new Store(dir2);
      setup(dir2);
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
