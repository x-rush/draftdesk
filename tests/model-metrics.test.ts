// 成本纪律批 7 守护：模型调用台账（cheap/full 拆分+升级计数）、读路由、
// structured cheap 档连续 2 次不过合同升 full 单次重试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { recordModelMetrics, recordModelUpgrade, recentModelMetrics, shanghaiDay } from "../core/model-metrics";
import { structured } from "../core/model";
import { z } from "zod";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function jobFixture(id: string): any {
  return { id, planId: "p", plan: { kind: "editorial", maxModelCalls: 99, maxTokens: 9999999 }, state: "running", createdAt: new Date().toISOString(), evidenceIds: [], calls: 0, reservedTokens: 0, actualTokens: 0, warnings: [], steps: [], cancelRequested: false };
}

test("台账：cheap/full 拆分累计 + 升级计数 + 近 N 天读取 + 上海时区日键", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-metrics-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    assert.match(shanghaiDay(), /^\d{4}-\d{2}-\d{2}$/);
    recordModelMetrics(db, "cheap", 100);
    recordModelMetrics(db, "cheap", 50);
    recordModelMetrics(db, "full", 1000);
    recordModelUpgrade(db);
    const [today] = recentModelMetrics(db, 7);
    assert.equal(today.calls, 3);
    assert.equal(today.tokens, 1150);
    assert.deepEqual([today.byPlan.cheap.calls, today.byPlan.cheap.tokens], [2, 150]);
    assert.deepEqual([today.byPlan.full.calls, today.byPlan.full.tokens], [1, 1000]);
    assert.equal(today.upgrades, 1);
    // 空日兜底形状
    const days = recentModelMetrics(db, 3);
    assert.equal(days.length, 3);
    assert.equal(days[2].calls, 0);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("structured cheap 档：连续 2 次不过合同 → 第 3 次升 full 重试并记升级", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-tier-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("jobs", "j1", jobFixture("j1"));
    const schema = z.object({ ok: z.literal(true) });
    const plans: string[] = [];
    const request = async (_db: any, _messages: any, opts: any) => {
      plans.push(opts.plan);
      if (opts.plan !== "full") return { text: "不是合法 JSON，模拟 cheap 输出不过合同" };
      return { text: JSON.stringify({ ok: true }), usage: 10 };
    };
    const result = await structured(db, jobFixture("j1"), "skill", {}, schema, AbortSignal.timeout(5000), request, "cheap");
    assert.equal(result.ok, true);
    assert.deepEqual(plans, ["cheap", "cheap", "full"], "cheap 两次失败后升 full 一次");
    const [today] = recentModelMetrics(db, 1);
    assert.equal(today.byPlan.full.calls, 0, "mock request 绕过 requestModel，台账只在真实调用时累计");
    assert.equal(today.upgrades, 1, "升档计数由 structured 直接记录");
    // full 档维持 2 次上限
    db.put("jobs", "j2", jobFixture("j2"));
    const plans2: string[] = [];
    const failing = async (_db: any, _m: any, opts: any) => { plans2.push(opts.plan); return { text: "not json" }; };
    await assert.rejects(structured(db, jobFixture("j2"), "skill", {}, schema, AbortSignal.timeout(5000), failing, "full"));
    assert.equal(plans2.length, 2, "full 档只有 2 次尝试");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
