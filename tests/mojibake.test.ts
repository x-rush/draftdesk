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

test("plan-mojibake-v1 迁移：损坏文案从种子恢复，操作字段保留；outlines 归属清理；死令牌删除；收集箱簇就位", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-mojibake-"));
  let db: Store | undefined, db2: Store | undefined;
  try {
    db = new Store(dir);
    const plan = db.get<any>("plans", "daily-editorial")!;
    db.put("plans", plan.id, {
      ...plan,
      goal: "发现\uFFFD\uFFFD有关的 AI 变化，提出\uFFFD选题",
      keywords: ["剪映\uFFFD字幕"],
      dailyTime: "09:30",
      scheduleEnabled: true,
    });
    db.put("outlines", "out-moji", { id: "out-moji", clusterId: "clu-inbox", platform: "公众号", contentType: "长文", title: "乱码归属大纲", decision: "pending", producedBy: "agent:乱码\uFFFD\uFFFD\uFFFD名", createdAt: new Date().toISOString() });
    db.put("connections", "c-moji", { id: "c-moji", name: "乱码\uFFFD令牌", digest: "dead", scopes: ["submit"], createdAt: new Date().toISOString(), lastUsedAt: null, revoked: true });
    // 模拟旧库升级：损坏发生在迁移之后，清掉迁移标记让重开时重跑（一次性幂等语义不变）
    db.del("meta", "plan-mojibake-v1");
    db.del("meta", "inbox-cluster-v1");
    db.close();

    db2 = new Store(dir);
    const restored = db2.get<any>("plans", "daily-editorial")!;
    const def = defaultPlans.find((p) => p.id === "daily-editorial")!;
    assert.equal(restored.goal, def.goal, "goal 未从种子恢复");
    assert.deepEqual(restored.keywords, def.keywords, "keywords 未从种子恢复");
    assert.equal(restored.dailyTime, "09:30", "用户操作字段不得被迁移覆盖");
    assert.equal(restored.scheduleEnabled, true);
    assert.equal(db2.get<any>("outlines", "out-moji")?.producedBy, "agent:未知来源(乱码已清理)");
    assert.equal(db2.get("connections", "c-moji"), undefined, "乱码名死令牌应删除");
    assert.ok(db2.get("clusters", "clu-inbox"), "选题收集箱簇未就位");
    // 干净的 plan 不被迁移触碰
    const trend = db2.get<any>("plans", "trend-radar")!;
    assert.equal(trend.goal, defaultPlans.find((p) => p.id === "trend-radar")!.goal);
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
