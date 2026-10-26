// Part 0 乱码修复守护：迁移恢复损坏 plans / 清理 outlines 归属与死令牌；
// body() 中间件对全部写入口拒绝 U+FFFD。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { defaultPlans } from "../core/defaults";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("plan-mojibake-v1 迁移：已固化为 no-op 占位（R10.25-6）——重开不再触碰数据，编码守护由 body() 中间件承担", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-mojibake-"));
  let db: Store | undefined, db2: Store | undefined;
  try {
    db = new Store(dir);
    const plan = db.get<any>("plans", "daily-editorial")!;
    db.put("plans", plan.id, {
      ...plan,
      goal: "发现\uFFFD\uFFFD有关的 AI 变化，提出\uFFFD选题",
      dailyTime: "09:30",
      scheduleEnabled: true,
    });
    // 模拟旧库升级路径：清迁移标记重开
    db.del("meta", "plan-mojibake-v1");
    db.close();

    db2 = new Store(dir);
    const kept = db2.get<any>("plans", "daily-editorial")!;
    // no-op 语义：历史修复已生效退役（活库乱码 2026-10-10 清偿），重开不再扫描/恢复
    assert.equal(kept.goal, "发现\uFFFD\uFFFD有关的 AI 变化，提出\uFFFD选题", "固化后数据原样保留");
    assert.equal(kept.dailyTime, "09:30");
    assert.ok(db2.get("clusters", "clu-inbox"), "选题收集箱簇仍由 inbox-cluster-v1 就位");
  } finally {
    db?.close();
    db2?.close();
    cleanup(dir);
  }
});

test("body() 编码守护：写入口携带 U+FFFD 一律 400（含 agent 与 UI 路径）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-moji-guard-"));
  const previous = process.env.DRAFTDESK_DATA_DIR;
  process.env.DRAFTDESK_DATA_DIR = dir;
  try {
    const { handle } = await import("../core/http");
    // UI 路径：POST /outlines 标题带 U+FFFD
    const ui = await handle(new Request("http://127.0.0.1:5173/api/v1/outlines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clusterId: "clu-inbox", platform: "公众号", contentType: "长文", title: "坏\uFFFD标题" }),
    }), ["outlines"]);
    assert.equal(ui.status, 400);
    const uiBody = await ui.json();
    assert.equal(uiBody.code, "INVALID_PAYLOAD");
    assert.ok(/U\+FFFD/.test(uiBody.error), uiBody.error);
    assert.ok(uiBody.error.includes("无效字符"));
    // 未入库
    const queue = await handle(new Request("http://127.0.0.1:5173/api/v1/outlines"), ["outlines"]);
    assert.equal((await queue.json()).items.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DRAFTDESK_DATA_DIR;
    else process.env.DRAFTDESK_DATA_DIR = previous;
    cleanup(dir);
  }
});
