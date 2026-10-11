// 判定层 + 站点发现守护（海外定位批 5/6）：obsRatio 口径、三档判定规则、
// DDG 解析、obsByDay 按日记数、判定 tick（竞争度入库/站点发现/品牌词/永久缓存/失败计数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { computeObsRatio, judgeVerdict, parseDdgResults, platformOf, ddgQuery, seenJudgeTick, wordScore } from "../core/seen-judge";
import { observeSeenTerm, observeSuggestion } from "../core/seen-terms";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

function dayKey(offset: number, base = new Date()): string {
  return new Date(base.getTime() - offset * 86400000).toISOString().slice(0, 10);
}

test("obsRatio：近2天日均 ÷ 前7天日均；无基线 undefined", () => {
  const now = new Date();
  const byDay: Record<string, number> = {};
  for (let o = 0; o <= 1; o++) byDay[dayKey(o, now)] = 4;
  for (let o = 2; o <= 8; o++) byDay[dayKey(o, now)] = 1;
  assert.equal(computeObsRatio({ obsByDay: byDay }, now), 4, "(8/2)/(7/7)=4");
  assert.equal(computeObsRatio({}, now), undefined, "无 obsByDay 无基线");
  assert.equal(computeObsRatio({ obsByDay: { [dayKey(0, now)]: 3 } }, now), undefined, "仅近2天有观测无基线");
});

test("值不值得做三档：推荐/可以试试/不值得做/竞争度待查 四分支", () => {
  const now = new Date();
  const mk = (recent: number, prev: number, serp?: number) => {
    const byDay: Record<string, number> = {};
    for (let o = 0; o <= 1; o++) byDay[dayKey(o, now)] = recent;
    for (let o = 2; o <= 8; o++) byDay[dayKey(o, now)] = prev;
    return { serpDedicated: serp, obsByDay: byDay };
  };
  assert.deepEqual(judgeVerdict({}, now), { verdict: "竞争度待查", reason: "DDG 竞争度未查" });
  assert.equal(judgeVerdict(mk(4, 1, 0), now).verdict, "推荐", "obs 4 且零竞争站");
  assert.equal(judgeVerdict(mk(1, 1, 2), now).verdict, "可以试试", "obs 1 竞争站 2");
  assert.equal(judgeVerdict(mk(0.2, 1, 1), now).verdict, "不值得做", "obs 0.2 退坡");
  assert.equal(judgeVerdict(mk(4, 1, 6), now).verdict, "不值得做", "竞争站 6 扎堆");
  assert.equal(judgeVerdict({ serpDedicated: 0, obsByDay: {} }, now).verdict, "竞争度待查", "无 obs 基线待查");
});

test("DDG 解析：result__a + uddg 解码 + 平台识别", () => {
  const html = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://my-tool.vercel.app/")}&rut=abc">Tool Site</a></div>
  <a class="result__a" href="https://example.com/x">Not platform</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://user.github.io/ai-notes/")}&rut=def">Notes</a>`;
  const results = parseDdgResults(html);
  assert.equal(results.length, 3, "解析全部 result__a（平台过滤由 platformOf 负责）");
  assert.equal(results[0].host, "my-tool.vercel.app");
  assert.equal(platformOf(results[0].host), "vercel");
  assert.equal(results[1].host, "example.com");
  assert.equal(platformOf(results[1].host), undefined);
  assert.equal(results[2].host, "user.github.io");
  assert.equal(platformOf(results[2].host), "github.io");
  assert.ok(ddgQuery("ai tool").includes("site:netlify.app"));
  assert.equal(wordScore({ observations: 7 }), 7);
});

test("obsByDay：observeSeenTerm 同日不重复计数；observeSuggestion 每次推进；空格合并按日取 max", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-obsday-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const day = new Date().toISOString().slice(0, 10);
    observeSeenTerm(db, "词一", { day });
    observeSeenTerm(db, "词一", { day });
    assert.equal(db.get<any>("seen-terms", "词一").obsByDay[day], 1, "同日重复提取不膨胀");
    observeSuggestion(db, "词二", "seed", { source: "youtube-suggest" });
    observeSuggestion(db, "词二", "seed", { source: "youtube-suggest" });
    assert.equal(db.get<any>("seen-terms", "词二").obsByDay[day], 2, "联想每次 +1");
    db.put("seen-terms", "词三", { id: "词三", term: "词三", status: "new", observations: 1, sources: [], relatedSearches: [], daysSeen: [], obsByDay: { [day]: 3 }, firstSeenAt: "", lastSeenAt: "" });
    db.put("seen-terms", "词 三", { id: "词 三", term: "词 三", status: "new", observations: 2, sources: [], relatedSearches: [], daysSeen: [], obsByDay: { [day]: 5 }, firstSeenAt: "", lastSeenAt: "" });
    const { mergeSpaceVariants } = await import("../core/seen-terms");
    mergeSpaceVariants(db);
    assert.equal(db.get<any>("seen-terms", "词三").obsByDay[day], 5, "合并按日取 max");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

const DDG_HTML = `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://nice-app.vercel.app/")}&rut=a">Nice App</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://openai-tool.vercel.app/")}&rut=b">OpenAI Tool</a>`;

test("判定 tick：竞争度入库 + 站点发现 + 品牌词 + 永久缓存；失败静默计天数", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-judge-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const today = new Date().toISOString();
    const put = (term: string, extra: Record<string, unknown> = {}) => db!.put("seen-terms", term.toLowerCase(), {
      id: term.toLowerCase(), term, status: "rising", observations: 9, sources: ["hn-algolia"], relatedSearches: [],
      daysSeen: [], firstSeenAt: today, lastSeenAt: today, relevance: "strong", region: "global", ...extra,
    });
    put("nice app");
    put("cn 词不该被查", { region: "cn" });
    put("弱词不该被查", { relevance: "weak" });
    let ddgCalls = 0, suggestCalls = 0;
    const fakeFetch = (async (url: any) => {
      const u = String(url);
      ddgCalls++;
      if (u.includes("html.duckduckgo.com")) return new Response(DDG_HTML, { status: 200 });
      if (u.includes("suggestqueries.google.com")) { suggestCalls++; return new Response('["q",[["nice app free",0]]]', { status: 200 }); }
      throw new Error("unexpected " + u);
    }) as unknown as typeof fetch;
    seenJudgeTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 120));
    const term = db.get<any>("seen-terms", "nice app");
    assert.equal(term.serpDedicated, 2, "两个平台站结果");
    assert.equal(term.serpInternal, 2);
    assert.equal(term.serpFailDays, 0);
    // 站点发现：候选 + 品牌词（域名含 openai → 不建议做）
    const nice = db.get<any>("site-discoveries", "nice-app.vercel.app");
    assert.ok(nice, "候选站应入库");
    assert.equal(nice.brand, false);
    assert.equal(nice.terms[0], "nice app");
    const openai = db.get<any>("site-discoveries", "openai-tool.vercel.app");
    assert.equal(openai.brand, true, "域名含品牌名 → 不建议做");
    assert.equal(openai.brandReason, "域名含品牌名");
    // suggest 无该词 → brand（用第二个词验证 suggest 路径）
    assert.ok(suggestCalls >= 1);
    // 永久缓存：当日 done 键后不再发请求
    const callsAfter = ddgCalls;
    seenJudgeTick(db, fakeFetch);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ddgCalls, callsAfter, "当日 done 键幂等");
    // 失败计数：查过的词不再进队列，构造一个会失败的词
    db.put("seen-terms", "fail 词", { id: "fail 词", term: "fail 词", status: "rising", observations: 9, sources: [], relatedSearches: [], daysSeen: [], firstSeenAt: today, lastSeenAt: today, relevance: "strong", region: "global" });
    // 模拟次日：清 done 键（失败词重试语义由 serpDedicated 缺失驱动）
    db.del("meta", "seen-judge-done:" + new Date().toISOString().slice(0, 10));
    const failing = (async () => { ddgCalls++; throw new Error("blocked"); }) as unknown as typeof fetch;
    seenJudgeTick(db, failing);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(db.get<any>("seen-terms", "fail 词").serpFailDays, 1, "失败词计 serpFailDays");
    assert.equal(typeof db.get<any>("seen-terms", "nice app").serpDedicated, "number", "已查词不重查");
  } finally {
    db?.close();
    cleanup(dir);
  }
});
