// 元数据断链守护测试：parser 产出的媒体元数据（mediaType/coverUrl/author/publishedAt）
// 必须走完 parser → candidateFromItem（落库构造点）→ hotspotFeed（视图投影）→
// agentHotspots（agent/MCP 投影）全链不丢。2026-10-10 曾在 evidence→candidate
// 字段挑选时全部丢失，此文件防止回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseBilibiliPopular } from "../core/hotlists";
import { candidateFromItem } from "../core/sources";
import { hotspotFeed } from "../core/hotspots";
import { agentHotspots } from "../core/agent-read";
import { Store } from "../core/store";
import type { DiscoveryRecord } from "../core/discovery";

// B站官方接口形状的最小 fixture：一条全字段视频 + 一条缺 pic 的视频
const bilibiliPayload = {
  code: 0,
  data: {
    list: [
      { bvid: "BV1meta", title: "元数据链路验证视频", owner: { name: "链路测试UP" }, stat: { view: 12345 }, pic: "https://i0.hdslb.com/bfs/archive/meta.jpg", short_link_v2: "https://b23.tv/meta" },
      { bvid: "BV1nopic", title: "没有封面的视频", owner: { name: "另一位UP" }, stat: { view: 99 }, short_link_v2: "https://b23.tv/nopic" },
    ],
  },
};

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

test("元数据全链：parser→落库构造→视图投影→agent 投影 四字段不丢", () => {
  // ① parser 层
  const items = parseBilibiliPopular(bilibiliPayload, "2026-10-10T00:00:00.000Z");
  assert.equal(items.length, 2);
  assert.equal(items[0].mediaType, "video");
  assert.equal(items[0].coverUrl, "https://i0.hdslb.com/bfs/archive/meta.jpg");
  assert.equal(items[0].author, "链路测试UP");
  assert.equal(items[1].mediaType, "video");
  assert.equal(items[1].coverUrl, undefined, "缺 pic 时 coverUrl 应缺省而不是空串");
  assert.ok(!("coverUrl" in items[1]));

  // ② 落库构造点（candidateFromItem）：四字段 + publishedAt（HN parser 有）
  const candidate = candidateFromItem(items[0], "bilibili-popular", "B站热门", 0, "watch", "原始热点");
  assert.equal(candidate.mediaType, "video");
  assert.equal(candidate.coverUrl, "https://i0.hdslb.com/bfs/archive/meta.jpg");
  assert.equal(candidate.author, "链路测试UP");
  assert.equal(candidate.publishedAt, undefined);
  // publishedAt 透传（EvidenceInput 有此字段，HN parser 产出）
  const withPublished = candidateFromItem({ ...items[0], publishedAt: "2026-10-01T00:00:00.000Z" }, "bilibili-popular", "B站热门", 0, "watch", "原始热点");
  assert.equal(withPublished.publishedAt, "2026-10-01T00:00:00.000Z");

  // ③ 视图投影（hotspotFeed）：新行携带元数据；同 URL 更新时最新观测优先
  const record: DiscoveryRecord = { jobId: "j1", at: "2026-10-10T00:01:00.000Z", planName: "热词与内容机会", mode: "analysis", limit: 100, candidates: [candidate], sources: [] };
  const feed = hotspotFeed([record], new URLSearchParams("hotspotConsumed=include"));
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].mediaType, "video");
  assert.equal(feed.items[0].coverUrl, candidate.coverUrl);
  assert.equal(feed.items[0].author, "链路测试UP");
  const newer: DiscoveryRecord = { ...record, jobId: "j2", at: "2026-10-10T00:02:00.000Z", candidates: [{ ...candidate, observedAt: "2026-10-10T00:02:00.000Z", author: "更新后的UP" }] };
  const feedMerged = hotspotFeed([newer, record], new URLSearchParams("hotspotConsumed=include"));
  assert.equal(feedMerged.items[0].author, "更新后的UP", "同 URL 更新时元数据应随最新观测");

  // ④ agent/MCP 投影（agentHotspots 真实走库）
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-metadata-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("discovery", "j1", record);
    const rows: any = agentHotspots(db, { limit: 10 });
    const row = (rows.items || []).find((x: any) => x.url === candidate.url);
    assert.ok(row, "agent 投影未返回该候选");
    assert.equal(row.mediaType, "video");
    assert.equal(row.coverUrl, candidate.coverUrl);
    assert.equal(row.author, "链路测试UP");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
