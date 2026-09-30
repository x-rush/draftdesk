import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-janitor-"));
process.env.DRAFTDESK_DATA_DIR = dir;
const { runJanitor, RETENTION } = await import("../core/janitor");
const { store } = await import("../core/store");
import { evidence, topic } from "./fixtures";

after(() => {
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("janitor：超窗热榜与未被引用的证据自动消费，被引用证据保留，同日只跑一次", async () => {
  const db = store();
  const old = new Date(Date.now() - (RETENTION.hotspots.autoConsumeOlderThanDays + 3) * 86400000).toISOString();
  const fresh = new Date().toISOString();
  const oldEvidenceAt = new Date(Date.now() - (RETENTION.evidence.autoConsumeOlderThanDays + 5) * 86400000).toISOString();
  db.put("discovery", "rec-old", { jobId: "rec-old", at: old, planName: "旧策略", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://old.example.org/a", title: "旧热榜", sourceId: "s", sourceName: "旧源", status: "watch", reason: "原始热点", observedAt: old },
  ]});
  db.put("discovery", "rec-new", { jobId: "rec-new", at: fresh, planName: "新策略", limit: 5, mode: "analysis", sources: [], candidates: [
    { url: "https://new.example.org/b", title: "新热榜", sourceId: "s", sourceName: "新源", status: "watch", reason: "原始热点", observedAt: fresh },
  ]});
  // 旧证据两条：一条被产物引用（保留），一条无引用（自动消费）；再加一条新证据（保留）
  db.put("evidence", "ev-old-free", { ...evidence[0], id: "ev-old-free", title: "旧证据无引用", collectedAt: oldEvidenceAt });
  db.put("evidence", "ev-old-used", { ...evidence[0], id: "ev-old-used", title: "旧证据被引用", collectedAt: oldEvidenceAt });
  db.put("evidence", "ev-fresh", { ...evidence[0], id: "ev-fresh", title: "新证据", collectedAt: fresh });
  const saved = db.saveArtifact(topic, "job-x", "review", []);
  db.put("artifacts", saved.id, { ...db.get<any>("artifacts", saved.id), evidenceIds: ["ev-old-used"] });

  const first = runJanitor(db);
  assert.ok(first, "首跑应执行");
  assert.equal(first!.hotspots, 1, "旧热榜自动消费");
  assert.equal(first!.evidence, 1, "仅未被引用的旧证据自动消费");
  assert.ok(db.get("consumption", "hotspots:https://old.example.org/a"));
  assert.ok(db.get("consumption", "evidence:ev-old-free"));
  assert.ok(!db.get("consumption", "evidence:ev-old-used"), "被引用证据不消费");
  assert.ok(!db.get("consumption", "evidence:ev-fresh"));
  assert.ok(!db.get("consumption", "hotspots:https://new.example.org/b"));

  // 同日二跑节流
  assert.equal(runJanitor(db), null);

  // 消费后：remaining 只数未消费，feed 默认隐藏已消费
  const summary = (await import("../core/agent-read")).consumptionSummary(db, "hotspots");
  assert.equal(summary.total, 2);
  assert.equal(summary.remaining, 1);
  assert.equal(summary.consumed, 1);
  const { hotspotFeed } = await import("../core/hotspots");
  const hide = hotspotFeed(db.list("discovery"), new URLSearchParams(), 20, (await import("../core/agent-read")).consumptionHotspotKeys(db));
  assert.equal(hide.total, 1);
  const include = hotspotFeed(db.list("discovery"), new URLSearchParams("hotspotConsumed=include"), 20, (await import("../core/agent-read")).consumptionHotspotKeys(db));
  assert.equal(include.total, 2);
});
