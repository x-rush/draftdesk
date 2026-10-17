// R9-7 根治批守护：①中断调用预留释放 + 泄漏对账回收；②backfill 子批拆分与失败归因。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { requestModel } from "../core/model";
import { shanghaiDay } from "../core/model-metrics";
import { budgetAuditTick, RESCUE_THRESHOLD, ALERT_THRESHOLD } from "../core/budget-audit";
import { judgeUnjudgedTerms } from "../core/seen-extract";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function setup(dir: string, dailyTokenLimit = 600000) {
  const db = new Store(dir);
  db.put("config", "main", {
    ...(db.get<any>("config", "main") || {}),
    baseUrl: "https://dashscope.example/compatible-mode/v1",
    model: "test-model", profile: "测试", apiKey: "test-key", dailyTokenLimit,
  });
  return db;
}

// ---- ① 中断释放 ----
test("中断调用全额退预留：fetch 抛错/HTTP 500/超时后 reserved 回落到调用前", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-budget-release-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    const reservation = 20000;
    // 手动预置一笔在途预留（模拟 requestModel 已 reserve）
    db.reserve(reservation);
    const before = db.dayBudget().reserved;
    assert.equal(before, reservation);
    // fetch 抛错（网络断/中止）
    await assert.rejects(() => requestModel(db!, [{ role: "user", content: "x" }], {
      signal: new AbortController().signal,
      fetch: (async () => { throw new Error("network down"); }) as typeof fetch,
    }));
    assert.equal(db.dayBudget().reserved, before, "fetch 抛错后预留全额退回");
    // HTTP 500：调用前再预留一笔；失败后净效果=只留显式预留（调用自身的预留全额退回）
    db.reserve(reservation);
    await assert.rejects(() => requestModel(db!, [{ role: "user", content: "x" }], {
      signal: new AbortController().signal,
      fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    }));
    assert.equal(db.dayBudget().reserved, before + reservation, "HTTP 错误后调用预留全额退回（剩显式预留）");
    // 成功调用仍正常结算：charged = max(u+500, 1.2u) = 1500，多退少补（增量断言，不背基线）
    db.reserve(reservation);
    const c3 = db.dayBudget().reserved;
    const okBody = { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1000 } };
    const ok = await requestModel(db!, [{ role: "user", content: "x" }], {
      signal: new AbortController().signal,
      fetch: (async () => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    });
    assert.equal(ok.text, "ok");
    assert.equal(db.dayBudget().reserved, c3 + 1500, "成功路径按台账口径结算（charged=max(u+500,1.2u)=1500）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("预算自检：泄漏超回收阈值拉回台账口径，超告警阈值仅告警，正常偏差不动", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-budget-audit-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    // 台账：实耗 100k / 20 次 → expected = 125000 + 10000 = 135000
    db.put("model-metrics", shanghaiDay(), { id: shanghaiDay(), calls: 20, tokens: 100000, byPlan: { cheap: { calls: 20, tokens: 100000 }, full: { calls: 0, tokens: 0 } }, upgrades: 0 });
    // 场景1：泄漏 500k（停电挂死量级）→ 回收至 expected
    db.reserve(RESCUE_THRESHOLD + 300000);
    const inflated = db.dayBudget().reserved;
    assert.ok(inflated > RESCUE_THRESHOLD);
    budgetAuditTick(db, new Date());
    assert.ok(db.dayBudget().reserved <= 135000, `泄漏回收：${inflated} → ${db.dayBudget().reserved}`);
    // 同小时闸：再泄漏也不重复跑（闸内不回收）
    db.reserve(100000);
    budgetAuditTick(db, new Date());
    assert.ok(db.dayBudget().reserved >= 135000, "同小时已审计过，闸生效（未再次回收）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("预算自检：偏差在告警带只告警不动作；正常偏差零动作", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-budget-warn-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    db.put("model-metrics", shanghaiDay(), { id: shanghaiDay(), calls: 2, tokens: 10000, byPlan: { cheap: { calls: 2, tokens: 10000 }, full: { calls: 0, tokens: 0 } }, upgrades: 0 });
    // expected = 12500 + 1000 = 13500；预留 13500 + 80000（在告警带 ALERT<80000<RESCUE）
    db.reserve(13500 + Math.round((ALERT_THRESHOLD + RESCUE_THRESHOLD) / 2));
    const r1 = db.dayBudget().reserved;
    budgetAuditTick(db, new Date());
    assert.equal(db.dayBudget().reserved, r1, "告警带不回收");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- ② backfill 子批 ----
function seedPending(db: Store, n: number) {
  for (let i = 0; i < n; i++) {
    const term = `待判词${String(i).padStart(3, "0")}`;
    db.put("seen-terms", term, { id: term, term, status: "new", observations: n - i, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
  }
}
const judgeAllModel = (calls: string[]) => async (_db: any, messages: any[]) => {
  const list = (messages[0].content as string).split("\n\n").pop() as string;
  const terms = list.split("\n").map((l) => l.replace(/^\d+\.\s*/, ""));
  calls.push(terms.join(","));
  return { text: JSON.stringify(terms.map((term) => ({ term, relevance: "weak" }))) };
};

test("backfill 子批：200 词拆 4×50 全部成功 judged=200；prompt 每子批只含本子批词", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backfill-sub-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    seedPending(db!, 200);
    const calls: string[] = [];
    const judged = await judgeUnjudgedTerms(db!, judgeAllModel(calls) as any);
    assert.equal(calls.length, 4, "200 词 → 4 子批");
    assert.ok(calls.every((c) => c.split(",").length === 50), "每子批 50 词");
    assert.equal(judged, 200);
    const first = calls[0].split(",")[0];
    assert.ok(!calls[1].includes(first), "子批间不重叠");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("backfill 子批：超时类失败终止剩余子批并抛归因；部分成功时 judged 照常落账不抛", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-backfill-fail-"));
  let db: Store | undefined;
  try {
    db = setup(dir);
    seedPending(db!, 200);
    // 场景1：首子批超时 → 立即终止，抛错信息带子批归因
    let attempts = 0;
    const timeoutModel = async () => { attempts++; throw new Error("The operation was aborted due to timeout"); };
    await assert.rejects(
      () => judgeUnjudgedTerms(db!, timeoutModel as any),
      (e: Error) => { assert.match(e.message, /1\/4 子批失败/); assert.match(e.message, /timeout/); return true; },
    );
    assert.equal(attempts, 1, "超时后不连打剩余子批");
    // 场景2：第 1 子批成功、第 2 子批解析烂（继续）、第 3 子批成功、第 4 子批成功 → judged=150 不抛
    const flakyModel = async (_db: any, messages: any[]) => {
      const list = (messages[0].content as string).split("\n\n").pop() as string;
      const first = list.split("\n")[0]?.replace(/^\d+\.\s*/, "");
      if (first === "待判词050") return { text: "这不是JSON" };
      const terms = list.split("\n").map((l) => l.replace(/^\d+\.\s*/, ""));
      return { text: JSON.stringify(terms.map((term) => ({ term, relevance: "weak" }))) };
    };
    const judged = await judgeUnjudgedTerms(db!, flakyModel as any);
    assert.equal(judged, 150, "部分成功照常落账（200 - 解析烂的 50）");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
