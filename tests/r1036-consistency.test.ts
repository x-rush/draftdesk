// R10.36 口径一致性守护（老大 2026-10-30 拍板）：三处差距修复的锁定测试。
// ① AgentSetup 引导与 SKILL.md v1.1.0 同口径（一选题一条，无「多平台大纲」旧口径残留）；
// ② 方案 B：builtin 兜底只按主平台出稿（aiPolicy.outline 无消费方，UI 死开关已撤）；
// ③ aiPolicy 写口仍接受 outline 槽位字段（存量配置保存不炸）。
// 源文件字符串断言可靠（教训仅限 bundle 产物 minify；.tsx/.md 源文件原样）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1036-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

const read = (rel: string) => readFileSync(path.join(path.resolve(import.meta.dirname, ".."), rel), "utf8");

test("R10.36 ①：AgentSetup 引导与 SKILL.md 同口径——一选题一条，无「多平台大纲」旧口径", () => {
  const setup = read("components/AgentSetup.tsx");
  assert.ok(setup.includes("一个选题一条"), "高级档引导含新口径");
  assert.ok(setup.includes("platforms+推荐建议 recommendation"), "引导点名新字段");
  assert.ok(!setup.includes("多平台大纲"), "AgentSetup 无旧口径残留");
  const review = read("components/Review.tsx");
  assert.ok(!review.includes("多平台大纲生成"), "aiPolicy 死开关（无运行时消费方）已撤");
  assert.ok(review.includes("builtin 不产适合平台集合与推荐建议"), "方案 B 降级声明在 aiPolicy 分区");
  const settings = read("components/Settings.tsx");
  assert.ok(!settings.includes("四开关"), "Settings 开关清单与实际（triage/draft）一致");
  const skill = read("skills/daily-analysis/SKILL.md");
  assert.ok(skill.includes("一个选题一条"), "skill 包 v1.1.0 口径在");
});

test("R10.36 ②：方案 B——builtin 兜底只按主平台出稿，多平台行 platforms 不被出稿改写", async () => {
  const db = store();
  db.put("config", "main", { ...db.config(), apiKey: "test-only" });
  db.put("config", "consumerMode", "builtin");
  db.put("outlines", "out-b36", {
    id: "out-b36", clusterId: "clu-b36", platform: "gzh", platforms: ["gzh", "xhs-note", "tiebuhao"],
    category: "newtech", contentType: "长文", title: "多平台选题只按主平台出稿", outline: [], keyPoints: ["要点"],
    evidenceRefs: [], decision: "approved", decidedAt: new Date().toISOString(),
  });
  let captured = "";
  const draftModel = (async (_db: unknown, messages: { content: string }[]) => {
    captured = messages[0].content;
    return { text: JSON.stringify({ keyPoints: ["k"], outline: ["a"], draftBody: "x".repeat(120) }) };
  }) as any;
  const { outlineDraftTick } = await import("../core/outline-draft");
  outlineDraftTick(db, draftModel);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(captured.startsWith("为选题「多平台选题只按主平台出稿」写第一版内容大纲（公众号"), "提示词按主平台（platforms[0]）组织");
  const row = db.get<any>("outlines", "out-b36");
  assert.ok(row.draftBody, "builtin 出稿落地");
  assert.deepEqual(row.platforms, ["gzh", "xhs-note", "tiebuhao"], "适合平台集合不被出稿改写");
});

test("R10.36 ③：aiPolicy 写口仍接受 outline 槽位字段（存量配置保存不炸）", async () => {
  const r = await handle(
    new Request("http://127.0.0.1:5173/api/v1/aiPolicy", {
      method: "POST",
      headers: { host: "127.0.0.1:5173", "content-type": "application/json" },
      body: JSON.stringify({ triage: "cheap", outline: "off", draft: "cheap", aiWriter: "external" }),
    }),
    ["aiPolicy"],
  );
  assert.equal(r.status, 200, "带 outline 槽位的 aiPolicy 可保存（字段无消费方但配置槽保留）");
});
