// 新站发现引擎守护（第五轮 §2，批 2a）：Show HN/PH 解析、host 去重、LLM 六类判定
//（含判定来源标注）、撞词标记、site-discoveries 交叉标注、tick 日闸与失败静默。
import { test } from "node:test";
import { shanghaiDayOf } from "../core/tick-guard";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { parseShowHnPayload, parseProductHuntFeed, upsertSiteLaunch, classifyLaunches, refreshLaunchAnnotations, clashTermsOf, siteLaunchesTick } from "../core/site-launches";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const HN_JSON = JSON.stringify({ hits: [
  { objectID: "1", title: "Show HN: My SaaS Tool", url: "https://mysaas.vercel.app", points: 12, num_comments: 3, author: "alice", created_at: "2026-10-12T00:00:00Z", story_text: "I built this because I needed it myself" },
  { objectID: "2", title: "Show HN: GitHub repo", url: "https://github.com/x/y", points: 5, num_comments: 1, author: "b" },
  { objectID: "3", title: "Ask HN: no url", url: null, points: 1, num_comments: 0, author: "c" },
] });

const PH_XML = `<rss><channel><item>
<title>ToolX - AI notes for teams</title>
<link>https://www.producthunt.com/posts/toolx</link>
<description>&lt;p&gt;Check it out at &lt;a href="https://toolx.io"&gt;toolx.io&lt;/a&gt;&lt;/p&gt;</description>
<pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate>
</item><item>
<title>NoDomain - just a PH page</title>
<link>https://www.producthunt.com/posts/nodomain</link>
<description>&lt;p&gt;Nothing but PH links &lt;a href="https://www.producthunt.com"&gt;PH&lt;/a&gt;&lt;/p&gt;</description>
</item></channel></rss>`;

const model = (async (_db: any, messages: any[]) => {
  const lines = (messages[0].content as string).split("\n").filter((l) => /^\d+\. Title:/.test(l));
  return { text: JSON.stringify(lines.map((l, i) => ({
    i: i + 1,
    titleZh: "转译 " + (i + 1),
    keywords: l.includes("SaaS") ? ["saas tool", "mysaas"] : ["toolx", "ai agents"],
    motive: "pain",
    motiveSource: "quote",
    reason: "原文关键句",
  }))) };
}) as any;

function fakeFetch(body: Record<string, string>) {
  return (async (url: any) => {
    const u = String(url);
    for (const [match, payload] of Object.entries(body)) {
      if (u.includes(match)) return new Response(payload, { status: 200 });
    }
    throw new Error("unexpected " + u.slice(0, 80));
  }) as unknown as typeof fetch;
}

const outer = AbortSignal.timeout(60000);


test("解析：Show HN 取部署域名（过滤 GitHub/无 url）；PH 从 description 抽外链官网（抽不到跳过）", () => {
  const hits = parseShowHnPayload(HN_JSON);
  assert.equal(hits.length, 1, "GitHub 仓库与无 url 帖被过滤");
  assert.equal(hits[0].host, "mysaas.vercel.app");
  assert.equal(hits[0].hnScore, 12);
  assert.equal(hits[0].hnComments, 3);
  assert.equal(hits[0].sourceUrl, "https://news.ycombinator.com/item?id=1");
  assert.ok(hits[0].text!.includes("needed it myself"));

  const { items, skipped } = parseProductHuntFeed(PH_XML);
  assert.equal(skipped, 0, "批 2b 口径：无官网域名也入库（仅坏条目跳过）");
  assert.equal(items.length, 2);
  assert.equal(items[0].host, "producthunt.com/posts/toolx", "host = PH 帖子去重标识");
  assert.equal(items[0].siteUrl, "https://toolx.io", "抽到的外链官网存 siteUrl");
  assert.equal(items[0].source, "producthunt-rss");
  assert.equal(items[1].host, "producthunt.com/posts/nodomain", "无域名条目照常入库");
  assert.equal(items[1].siteUrl, undefined);

  // Atom 形状（PH feed 实测）：link 是带属性对象，路径为 /products/<slug>
  const atomXml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>Scrape Anything by Context.dev</title>
  <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/context-dev"/>
  <content type="html">&lt;p&gt;Turn any website into clean data.&lt;/p&gt;&lt;p&gt;&lt;a href="https://www.producthunt.com/r/p/1277022"&gt;Discussion&lt;/a&gt;&lt;/p&gt;</content>
  </entry></feed>`;
  const atom = parseProductHuntFeed(atomXml);
  assert.equal(atom.skipped, 0, "Atom link 对象形状不再误跳过");
  assert.equal(atom.items.length, 1);
  assert.equal(atom.items[0].host, "producthunt.com/products/context-dev");
  assert.equal(atom.items[0].sourceUrl, "https://www.producthunt.com/products/context-dev");
  assert.equal(atom.items[0].siteUrl, undefined, "PH 自家重定向链接不算官网");
});

test("入库去重 + LLM 六类判定 + 撞词标记 + 交叉标注 + tick 日闸", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-launches-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    // 撞词素材：seen-terms 高分词「saas tool」（observations≥3）
    db.put("seen-terms", "saastool", { id: "saastool", term: "saas tool", status: "rising", observations: 5, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    // strong 低观测词也进撞词池（首批实测教训：obs>=3 口径把英文 strong 全挡在外面）
    db.put("seen-terms", "aiagents", { id: "aiagents", term: "AI agents", status: "new", observations: 1, relevance: "strong", sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    assert.equal(clashTermsOf(["saas tool"], new Map([["saastool", "saas tool"]])).length, 1, "精确命中");
    assert.deepEqual(clashTermsOf(["ai"], new Map([["saastool", "saas tool"]])), [], "短词不参与包含匹配");
    // 交叉标注素材：site-discoveries 预置同 host
    db.put("site-discoveries", "mysaas.vercel.app", { id: "mysaas.vercel.app", host: "mysaas.vercel.app", platform: "vercel", terms: ["saas tool"], firstFoundAt: "", bestRank: 1 });

    // tick 首跑：抓取 + 分类 + 标注全链
    siteLaunchesTick(db, model, fakeFetch({ "hn.algolia.com": HN_JSON, "producthunt.com/feed": PH_XML }));
    await new Promise((r) => setTimeout(r, 300));
    const launches = db.list<any>("site-launches");
    assert.equal(launches.length, 3, "Show HN 1 站 + PH 2 条（新口径无域名也入库）");
    const launch = db.get<any>("site-launches", "mysaas.vercel.app");
    assert.ok(launch.titleZh && launch.titleZh.startsWith("转译"), "LLM 中文转译入库（批内序号不定，按前缀断言）");
    assert.equal(launch.motive, "pain");
    assert.equal(launch.motiveSource, "quote", "判定来源=作者原话");
    assert.deepEqual(launch.keywords, ["saas tool", "mysaas"]);
    assert.ok(launch.judgedAt, "判定时间置位");
    assert.deepEqual(launch.clashTerms, ["saas tool"], "obs 高分词精确命中");
    assert.equal(launch.crossLinked, true, "site-discoveries 交叉标注");
    const ph = db.get<any>("site-launches", "producthunt.com/posts/toolx");
    assert.deepEqual(ph.clashTerms, ["AI agents"], "strong 低观测词也进撞词池（首批实测教训）");
    assert.equal(ph.crossLinked, false, "未交叉的站显式标 false");
    const done = db.get<any>("meta", "site-launches-done:" + shanghaiDayOf());
    assert.equal(done.added, 3, "HN 1 站 + PH 2 条");
    assert.equal(done.classified, 3, "三条都被分类（同批次 mock）");
    assert.equal(done.phSkipped, 0, "新口径无域名不跳过");
    assert.equal(done.clashed, 3, "mysaas 撞 obs 高分 + 两条 PH 撞 strong 低观测");
    assert.equal(done.crossLinked, 1);

    // mock 关键词锚定：toolx 条目标题含 "ToolX"
    // tick 日闸：同日二次调用不重跑（无新增）
    siteLaunchesTick(db, model, fakeFetch({ "hn.algolia.com": HN_JSON }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(db.list<any>("site-launches").length, 3, "日闸幂等");

    // 去重：已存在的 host upsert 只升 HN 数据
    const r = upsertSiteLaunch(db, { host: "mysaas.vercel.app", title: "t", sourceUrl: "s", source: "showhn", hnScore: 99 });
    assert.equal(r, "existed");
    assert.equal(db.get<any>("site-launches", "mysaas.vercel.app").hnScore, 99, "HN 分数只升不降");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("分类失败静默：坏模型输出不写判定字段，批次计数后继续（次日重试语义）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-launchfail-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    db.put("config", "main", { ...(db.get<any>("config", "main") || {}), apiKey: "test-key" });
    upsertSiteLaunch(db, { host: "fail.example.com", title: "Fail Tool", sourceUrl: "s", source: "showhn" });
    const badModel = (async () => ({ text: "not json at all" })) as any;
    const r = await classifyLaunches(db, badModel, outer);
    assert.equal(r.classified, 0);
    assert.equal(r.failedBatches, 1);
    const launch = db.get<any>("site-launches", "fail.example.com");
    assert.equal(launch.titleZh, undefined, "判定字段保留空待重试");
    assert.ok(!launch.judgedAt);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("refreshLaunchAnnotations 增量：高分词后到也能补撞词标记", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-launchmark-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    upsertSiteLaunch(db, { host: "late.example.com", title: "Late Tool", sourceUrl: "s", source: "showhn" });
    const l0 = db.get<any>("site-launches", "late.example.com");
    db.put("site-launches", l0.host, { ...l0, titleZh: "迟到工具", keywords: ["pdf converter"], judgedAt: new Date().toISOString() });
    let r = refreshLaunchAnnotations(db);
    assert.equal(r.clashed, 0, "无高分词不标");
    db.put("seen-terms", "pdfconverter", { id: "pdfconverter", term: "pdf converter", status: "rising", observations: 7, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: "", lastSeenAt: "" });
    r = refreshLaunchAnnotations(db);
    assert.equal(r.clashed, 1, "高分词后到补标");
    assert.deepEqual(db.get<any>("site-launches", "late.example.com").clashTerms, ["pdf converter"]);
  } finally {
    db?.close();
    cleanup(dir);
  }
});
