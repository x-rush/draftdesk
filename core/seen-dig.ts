// 热词掘金 v3：每日挖掘引擎（容器内网络专用——suggestqueries 宿主机不可达）。
// 引擎 A（主力）：seen-terms 种子 × [a-z] + 中文后缀 × 双语 → Google 联想展开，
//   结果以 status=new + seed 血缘入 seen-terms（幂等：已存在词只推进 lastSeenAt/observations）。
// 频控：并发 ≤5、请求间隔 ≥200ms、单轮请求预算硬顶；失败静默跳过，不阻塞整理主流程。
// 触发：随热词整理闸门（每日一次幂等）或 UI「立即整理」手动请求。
import type { Store } from "./store";
import { classifyIntent, observeSuggestion, termId } from "./seen-terms";

const DAY_MS = 86400000;
const SEED_LIMIT = 10;
const REQUEST_BUDGET = 700;
const INTERVAL_MS = 200;
const CONCURRENCY = 5;
const SUFFIXES = ["怎么", "如何", "为什么", "哪个好", "教程", "工具", "替代", "免费"];
const HLS = ["zh-CN", "en"];

type DoFetch = typeof fetch;

// 种子词库：rising/sustained 优先（观测次数降序），缺口由 24h 内新词补齐
//（=AI 提词日报与外部双写的当日产出）。圈外词与 archived 不做种子。
export function collectSeeds(db: Store, limit = SEED_LIMIT): { term: string; status: string }[] {
  const terms = db.list<any>("seen-terms").filter((t) => t.status !== "archived" && !t.offTopic);
  const now = Date.now();
  const priority = terms.filter((t) => t.status === "rising" || t.status === "sustained")
    .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0));
  const fresh = terms.filter((t) => (t.status ?? "new") !== "rising" && (t.status ?? "new") !== "sustained" && Date.parse(t.lastSeenAt || 0) >= now - DAY_MS);
  const seen = new Set<string>();
  const out: { term: string; status: string }[] = [];
  for (const t of [...priority, ...fresh]) {
    const id = termId(t.term);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ term: t.term, status: t.status ?? "new" });
    if (out.length >= limit) break;
  }
  return out;
}

// 单种子展开计划：字母 a–z + 中文后缀，各配双语 hl。
export function expansionQueries(seed: string): { q: string; hl: string }[] {
  const out: { q: string; hl: string }[] = [];
  for (const hl of HLS) {
    for (const letter of "abcdefghijklmnopqrstuvwxyz") out.push({ q: `${seed} ${letter}`, hl });
    for (const suffix of SUFFIXES) out.push({ q: `${seed}${suffix}`, hl });
  }
  return out;
}

// 联想响应解析：兼容 client=chrome（[q,[[s,0],…]]）、client=firefox（[q,[s,…]]）
// 与 {g:[{q}]} 三种返回形状。
export function parseSuggestPayload(raw: string): string[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (Array.isArray(data)) {
    const second = data[1];
    if (Array.isArray(second)) {
      return second.map((x) => (Array.isArray(x) ? String(x[0] ?? "") : String(x ?? "")));
    }
    return [];
  }
  if (data && typeof data === "object" && Array.isArray((data as { g?: unknown }).g))
    return ((data as { g?: Array<{ q?: unknown }> }).g ?? []).map((x) => String(x?.q ?? ""));
  return [];
}

function suggestUrl(q: string, hl: string): string {
  return `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}&hl=${hl}`;
}

export async function fetchSuggest(q: string, hl: string, doFetch: DoFetch, outer?: AbortSignal): Promise<string[]> {
  const response = await doFetch(suggestUrl(q, hl), {
    signal: AbortSignal.any([outer ?? AbortSignal.timeout(10 * 60000), AbortSignal.timeout(8000)]),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!response.ok) throw new Error(`suggest HTTP ${response.status}`);
  const suggestions = parseSuggestPayload(await response.text());
  return suggestions.map((s) => s.trim()).filter((s) => s.length >= 1 && s.length <= 80);
}

// 频控调度器：最多 concurrency 个在飞；相邻两次派发间隔 ≥ intervalMs。
// acquire 循环复核 nextSlot：多个 worker 的定时器同批到期时，后到者重读
// 已被推进的 nextSlot 继续等，绝不同毫秒并发派发。
export class Limiter {
  private nextSlot = 0;
  constructor(private intervalMs: number, private concurrency: number) {}
  async run<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const acquire = async () => {
      while (true) {
        const wait = this.nextSlot - Date.now();
        if (wait <= 0) {
          this.nextSlot = Date.now() + this.intervalMs;
          return;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(this.concurrency, tasks.length)) }, async () => {
      while (true) {
        const index = next++;
        if (index >= tasks.length) return;
        await acquire();
        results[index] = await tasks[index]();
      }
    });
    await Promise.all(workers);
    return results;
  }
}

// 引擎 A 主流程：种子→展开→频控抓取→去重入库。返回统计供日志与验收。
// intervalMs/concurrency/budget 可注入（测试用快速档；线上默认 200ms/5/700）。
export async function runSuggestExpansion(db: Store, doFetch: DoFetch = fetch, opts: {
  intervalMs?: number; concurrency?: number; budget?: number;
} = {}): Promise<{
  seeds: number; requests: number; failed: number; newTerms: number; updated: number; terms: number;
}> {
  const budget = opts.budget ?? REQUEST_BUDGET;
  const seeds = collectSeeds(db);
  const stats = { seeds: seeds.length, requests: 0, failed: 0, newTerms: 0, updated: 0, terms: 0 };
  if (!seeds.length) return stats;
  const outer = AbortSignal.timeout(10 * 60000);
  const written = new Set<string>();
  const tasks: (() => Promise<void>)[] = [];
  for (const seed of seeds)
    for (const { q, hl } of expansionQueries(seed.term))
      tasks.push(async () => {
        if (stats.requests >= budget || outer.aborted) return;
        stats.requests++;
        let suggestions: string[];
        try { suggestions = await fetchSuggest(q, hl, doFetch, outer); }
        catch { stats.failed++; return; }
        for (const term of suggestions) {
          const id = termId(term);
          if (written.has(id)) continue;
          written.add(id);
          const prev = db.get<any>("seen-terms", id);
          observeSuggestion(db, term, seed.term, { source: "suggest-expansion" });
          if (prev) stats.updated++;
          else stats.newTerms++;
        }
      });
  await new Limiter(opts.intervalMs ?? INTERVAL_MS, opts.concurrency ?? CONCURRENCY).run(tasks);
  stats.terms = written.size;
  return stats;
}

function doneKey(date: string) { return "seen-dig-done:" + date; }

// ── 引擎 B · People Also Ask ──
// 对 rising 词直抓 Google SERP，解析「大家还在问」区块的问题词；
// 被墙/限流抛错由调用方静默跳过（不做硬依赖）。
const PAA_MARKERS = ["大家还在问", "People also ask"];
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function parsePaa(html: string): string[] {
  const marker = PAA_MARKERS.map((m) => html.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (marker === undefined) return [];
  const window = html.slice(marker, marker + 40000);
  const out: string[] = [];
  for (const match of window.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
    const text = match[1].replace(/<[^>]+>/g, "").replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (e) => ENTITIES[e] ?? e).trim();
    if (text.length >= 8 && text.length <= 120 && !out.includes(text)) out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

export async function fetchPaa(q: string, doFetch: DoFetch, outer?: AbortSignal): Promise<string[]> {
  const response = await doFetch(`https://www.google.com/search?q=${encodeURIComponent(q)}&hl=zh-CN&num=10`, {
    signal: AbortSignal.any([outer ?? AbortSignal.timeout(10 * 60000), AbortSignal.timeout(12000)]),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`serp HTTP ${response.status}`);
  const html = await response.text();
  if (/unusual traffic|captcha/i.test(html.slice(0, 4000))) throw new Error("serp blocked");
  return parsePaa(html);
}

// 引擎 B 主流程：rising 词（上限 8，观测降序）逐个查 PAA，问题词入 seen-terms
// （intent=question，seed=rising 词）。单词失败跳过，300ms 间隔防限流。
export async function runPaa(db: Store, doFetch: DoFetch = fetch): Promise<{ rising: number; questions: number; skipped: number }> {
  const stats = { rising: 0, questions: 0, skipped: 0 };
  const rising = db.list<any>("seen-terms")
    .filter((t) => t.status === "rising" && !t.offTopic)
    .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0))
    .slice(0, 8);
  const outer = AbortSignal.timeout(8 * 60000);
  for (const term of rising) {
    stats.rising++;
    try {
      const questions = await fetchPaa(term.term, doFetch, outer);
      for (const q of questions) {
        const prev = db.get<any>("seen-terms", termId(q));
        observeSuggestion(db, q, term.term, { source: "paa", intent: "question" });
        if (!prev) stats.questions++;
      }
    } catch { stats.skipped++; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return stats;
}

// ── 引擎 C · Trends Rising（相关查询·上升）──
// Trends 关键词页底部 Rising 标签：Breakout=增长>5000% 竞争低，蓝海信号。
// 走 trends/api/relatedqueries（响应带 )]}', 前缀）；失败不阻塞主流程。
export function parseRelatedRising(raw: string): { query: string; value: string }[] {
  const start = raw.indexOf("{");
  if (start < 0) return [];
  try {
    const data = JSON.parse(raw.slice(start));
    const lists = data?.default?.rankedList;
    if (!Array.isArray(lists)) return [];
    const rising = lists.length > 1 ? lists[1] : lists[0];
    const out: { query: string; value: string }[] = [];
    for (const item of rising?.rankedKeyword || []) {
      const query = item?.query?.query;
      if (typeof query === "string" && query.trim()) out.push({ query: query.trim().slice(0, 80), value: String(item.formattedValue ?? item.value ?? "") });
    }
    return out;
  } catch { return []; }
}

export async function fetchRelatedRising(keyword: string, geo: string, doFetch: DoFetch, outer?: AbortSignal): Promise<{ query: string; value: string }[]> {
  const req = encodeURIComponent(JSON.stringify({ keyword, geo }));
  const response = await doFetch(`https://trends.google.com/trends/api/relatedqueries?hl=zh-CN&tz=-480&req=${req}`, {
    signal: AbortSignal.any([outer ?? AbortSignal.timeout(10 * 60000), AbortSignal.timeout(12000)]),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`relatedqueries HTTP ${response.status}`);
  return parseRelatedRising(await response.text());
}

// 引擎 C 主流程：取启用的 trends 源地区 → RSS Top 关键词（前 5）→ Rising 查询入库
//（seed=关键词，source=trends-rising）。RSS 或接口失败静默跳过。
export async function runTrendsRising(db: Store, doFetch: DoFetch = fetch): Promise<{ keywords: number; rising: number; skipped: number }> {
  const stats = { keywords: 0, rising: 0, skipped: 0 };
  const sources = db.list<any>("sources").filter((s) => s.type === "trends" && s.enabled);
  if (!sources.length) return stats;
  const outer = AbortSignal.timeout(8 * 60000);
  const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" };
  for (const source of sources) {
    const geo = source.region || "US";
    try {
      const rss = await doFetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
        signal: AbortSignal.any([outer, AbortSignal.timeout(12000)]), headers: UA,
      });
      if (!rss.ok) throw new Error(`rss HTTP ${rss.status}`);
      const titles = [...(await rss.text()).matchAll(/<title>([^<]{1,160})<\/title>/g)]
        .map((m) => m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim())
        .filter(Boolean).slice(1, 6);
      for (const keyword of titles) {
        stats.keywords++;
        try {
          await new Promise((r) => setTimeout(r, 300));
          for (const { query } of await fetchRelatedRising(keyword, geo, doFetch, outer)) {
            const prev = db.get<any>("seen-terms", termId(query));
            observeSuggestion(db, query, keyword, { source: "trends-rising" });
            if (!prev) stats.rising++;
          }
        } catch { stats.skipped++; }
      }
    } catch { stats.skipped++; }
  }
  return stats;
}

// 每分钟 tick：手动请求（UI「立即整理」）优先，其次随整理闸门每日一次。
// 全程 fire-and-forget：挖掘耗时数分钟，不得阻塞研究任务循环。
export function seenDiggingTick(db: Store, doFetch: DoFetch = fetch, opts: { intervalMs?: number; concurrency?: number; budget?: number } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const manual = db.get<any>("meta", "seen-dig-manual");
  const gate = db.get<any>("meta", "seen-terms-gate");
  const byManual = manual?.date === today;
  const byGate = gate?.date === today;
  if (!byManual && !byGate) return;
  if (db.get("meta", doneKey(today))) return;
  const running = db.get<any>("meta", "seen-dig-running");
  if (running && Date.now() - Date.parse(running.at) < 15 * 60000) return;
  db.put("meta", "seen-dig-running", { at: new Date().toISOString() });
  void (async () => {
    console.log("[seen-dig] 热词挖掘开始（联想展开 → PAA → Trends Rising）");
    try {
      const a = await runSuggestExpansion(db, doFetch, opts);
      console.log(`[seen-dig] 引擎A 联想展开：种子 ${a.seeds} / 请求 ${a.requests}（失败 ${a.failed}）/ 新词 ${a.newTerms} / 更新 ${a.updated}`);
      const b = await runPaa(db, doFetch).catch((e) => ({ rising: 0, questions: 0, skipped: 0, error: String(e) }));
      console.log(`[seen-dig] 引擎B PAA：rising ${b.rising} / 问题词 ${b.questions}（跳过 ${(b as any).skipped ?? 0}）`);
      const c = await runTrendsRising(db, doFetch).catch((e) => ({ keywords: 0, rising: 0, skipped: 0, error: String(e) }));
      console.log(`[seen-dig] 引擎C TrendsRising：关键词 ${c.keywords} / 上升词 ${c.rising}（跳过 ${(c as any).skipped ?? 0}）`);
      const summary = { at: new Date().toISOString(), suggest: a, paa: b, trends: c };
      db.put("meta", doneKey(today), summary);
      db.put("meta", "seen-dig-last", { date: today, ...summary });
    } catch (e) {
      console.error("[seen-dig] 挖掘失败:", e instanceof Error ? e.message : e);
    } finally {
      db.del("meta", "seen-dig-running");
      db.del("meta", "seen-dig-manual");
    }
  })();
}
