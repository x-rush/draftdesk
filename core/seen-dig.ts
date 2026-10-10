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
    console.log("[seen-dig] 热词挖掘开始（联想展开引擎）");
    try {
      const stats = await runSuggestExpansion(db, doFetch, opts);
      console.log(`[seen-dig] 完成：种子 ${stats.seeds} / 请求 ${stats.requests}（失败 ${stats.failed}）/ 新词 ${stats.newTerms} / 更新 ${stats.updated}`);
      db.put("meta", doneKey(today), { at: new Date().toISOString(), ...stats });
      db.put("meta", "seen-dig-last", { date: today, at: new Date().toISOString(), ...stats });
    } catch (e) {
      console.error("[seen-dig] 挖掘失败:", e instanceof Error ? e.message : e);
    } finally {
      db.del("meta", "seen-dig-running");
      db.del("meta", "seen-dig-manual");
    }
  })();
}
