import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activityPageSchema, officialActivityUrl, trustedActivityRulesUrl } from "../core/activity-import";
test("仅创作者中心或活动规则页可标记为官方活动证据",()=>{assert.equal(trustedActivityRulesUrl("https://creator.xiaohongshu.com/new/events"),true);assert.equal(trustedActivityRulesUrl("https://cp.kuaishou.com/creative/activity-calendar"),true);assert.equal(trustedActivityRulesUrl("https://www.bilibili.com/video/BV123"),false);assert.equal(trustedActivityRulesUrl("https://www.xiaohongshu.com/explore/123"),false);assert.equal(trustedActivityRulesUrl("https://creator.xiaohongshu.com.evil.example/new/events"),false);});
test("活动导入限制官方域名，不接受伪造子域、凭据和脚本地址",()=>{assert.equal(officialActivityUrl("https://creator.douyin.com/a"),true);for(const u of ["https://douyin.com.evil.test/a","https://evil-douyin.com/a","javascript:alert(1)","https://user:pass@douyin.com/a","http://douyin.com/a"])assert.equal(officialActivityUrl(u),false);});
test("活动文件校验版本、长度及来源，丢弃额外字段",()=>{const x={schemaVersion:"draftdesk.activity-page.v1",title:"活动规则",url:"https://www.bilibili.com/blackboard/a",text:"活动说明".repeat(30),cookie:"should-not-pass"};assert.equal("cookie" in activityPageSchema.parse(x),false);assert.equal(activityPageSchema.safeParse({...x,text:"短"}).success,false);assert.equal(activityPageSchema.safeParse({...x,schemaVersion:"other"}).success,false);});

test("快手实弹回归：2 字标题（社畜）不再被协议误拦（用户实弹批复）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-kuaishou-"));
  const prev = process.env.DRAFTDESK_DATA_DIR;
  process.env.DRAFTDESK_DATA_DIR = dir;
  try {
    const { handle } = await import("../core/http");
    const batch = {
      schemaVersion: "draftdesk.activity-batch.v1",
      platform: "快手",
      keywords: ["AI"],
      items: [
        { platform: "快手", title: "社畜", url: "https://cp.kuaishou.com/creative/activity-calendar", text: "带话题投稿，赢曝光", dateText: "活动时间：10.09-11.05", completeness: "summary", capturedAt: new Date().toISOString() },
        { platform: "快手", title: "小土狗", url: "https://cp.kuaishou.com/creative/activity-calendar", text: "带话题投稿，赢曝光", dateText: "活动时间：10.08-11.04", completeness: "summary", capturedAt: new Date().toISOString() },
      ],
      warnings: [],
      coverage: { scope: "screens", requestedPages: 2, scannedPages: 1, hasMore: true, visibleTotal: 179, note: "有限屏数采集" },
    };
    const res = await handle(new Request("http://127.0.0.1:5173/api/v1/activity-batches", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch),
    }), "activity-batches".split("/"));
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 201, JSON.stringify(body).slice(0, 200));
    assert.equal(body.count, 2, "2 字标题应入库（POST 返回 count）");
  } finally {
    if (prev === undefined) delete process.env.DRAFTDESK_DATA_DIR; else process.env.DRAFTDESK_DATA_DIR = prev;
    // Windows 下 Store 句柄释放有延迟，临时目录留在 %TEMP% 不强删
  }
});
