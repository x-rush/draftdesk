import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../core/store";
import { searchWeb } from "../core/sources";
import type { Plan } from "../core/schema";

function webPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "web-search-test",
    name: "网页搜索编排测试策略",
    kind: "editorial",
    goal: "验证搜索后端选择与补位编排。",
    audience: "个人开发者",
    keywords: ["AI"],
    excludeKeywords: [],
    includeDomains: [],
    sourceIds: ["web"],
    lookbackDays: 14,
    maxEvidence: 6,
    maxQueries: 2,
    maxItems: 2,
    maxModelCalls: 3,
    maxTokens: 60000,
    scheduleEnabled: false,
    dailyTime: "03:00",
    publishPolicy: "manual",
    ...overrides,
  } as Plan;
}

const TAVILY_URL = "https://api.tavily.com/search";
const SEARXNG_PREFIX = "http://searxng:8080/search";

function webResult(url: string, extra: Record<string, unknown> = {}) {
  return { title: "AI 工具观察", url, content: "AI 工具测评线索", ...extra };
}

test("hybrid：Tavily 相关结果充足时直接返回，不调用 SearXNG", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-hybrid-enough-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), tavilyKey: "t-key", webSearchProvider: "hybrid" });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return Response.json({
        results: ["https://a.example.org/1", "https://a.example.org/2", "https://a.example.org/3"].map((u) => webResult(u)),
      });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.equal(found.length, 3);
    assert.deepEqual(urls, [TAVILY_URL]);
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hybrid：Tavily 结果不足时 SearXNG 补位，按 URL 去重且 Tavily 优先", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-hybrid-backfill-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), tavilyKey: "t-key", webSearchProvider: "hybrid" });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (String(url) === TAVILY_URL)
        return Response.json({ results: [webResult("https://a.example.org/only")] });
      assert.ok(String(url).startsWith(SEARXNG_PREFIX), "补位请求应发往 SearXNG");
      return Response.json({
        results: [webResult("https://a.example.org/only"), webResult("https://b.example.org/extra")],
      });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.deepEqual(found.map((e) => e.url), ["https://a.example.org/only", "https://b.example.org/extra"]);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], TAVILY_URL);
    assert.ok(urls[1].startsWith(SEARXNG_PREFIX));
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hybrid：未配置 Tavily Key 不报错，搜索由 SearXNG 承担", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-hybrid-nokey-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), tavilyKey: undefined, webSearchProvider: "hybrid" });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return Response.json({ results: [webResult("https://b.example.org/local")] });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.equal(found.length, 1);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith(SEARXNG_PREFIX));
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hybrid：Tavily 失败时 SearXNG 补位；双双失败才向上抛错", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-hybrid-failover-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), tavilyKey: "t-key", webSearchProvider: "hybrid" });
    globalThis.fetch = (async (url: any) => {
      if (String(url) === TAVILY_URL) return new Response("{}", { status: 503 });
      return Response.json({ results: [webResult("https://b.example.org/fallback")] });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.deepEqual(found.map((e) => e.url), ["https://b.example.org/fallback"]);
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await assert.rejects(() => searchWeb(db, webPlan(), "AI 工具", new AbortController().signal), /HTTP 503/);
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searxng：域名限定在客户端兜底过滤，publishedDate 映射进证据", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-searxng-only-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), webSearchProvider: "searxng" });
    const recent = new Date(Date.now() - 3600000).toISOString();
    globalThis.fetch = (async (url: any) => {
      assert.ok(String(url).includes("site%3Aexample.org"));
      return Response.json({
        results: [
          webResult("https://www.example.org/post", { publishedDate: recent }),
          webResult("https://foreign.example.com/other"),
          webResult("http://www.example.org/insecure"),
        ],
      });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan({ includeDomains: ["example.org"] }), "AI 工具", new AbortController().signal);
    assert.equal(found.length, 1);
    assert.equal(found[0].url, "https://www.example.org/post");
    assert.equal(found[0].publishedAt, recent);
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺省配置为混合档：无 Key 由 SearXNG 承担；显式 tavily 保持旧行为", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dd-search-default-"));
  const db = new Store(dir);
  const original = globalThis.fetch;
  try {
    db.put("config", "main", { ...db.config(), tavilyKey: undefined });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return Response.json({ results: [webResult("https://b.example.org/local")] });
    }) as typeof fetch;
    const found = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.equal(found.length, 1);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith(SEARXNG_PREFIX));
    db.put("config", "main", { ...db.config(), tavilyKey: undefined, webSearchProvider: "tavily" });
    await assert.rejects(() => searchWeb(db, webPlan(), "AI 工具", new AbortController().signal), /未配置 Tavily Key/);
    db.put("config", "main", { ...db.config(), tavilyKey: "t-key", webSearchProvider: "tavily" });
    urls.length = 0;
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return Response.json({ results: [webResult("https://a.example.org/1")] });
    }) as typeof fetch;
    const tavilyOnly = await searchWeb(db, webPlan(), "AI 工具", new AbortController().signal);
    assert.equal(tavilyOnly.length, 1);
    assert.deepEqual(urls, [TAVILY_URL]);
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
