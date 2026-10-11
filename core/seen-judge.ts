// 判定层 + 站点发现（海外定位批 5/6）：
// · obsRatio：近 2 天 observations 日均 ÷ 前 7 天日均（obsByDay 按日记数，零外部依赖）。
// · SERP 竞争度：DDG html 抓 {term} site:vercel.app OR site:github.io OR site:pages.dev
//   OR site:netlify.app——四类静态平台上有没有人已经做了同题独立站。
//   serpDedicated=竞争站条数 / serpInternal=独立 host 数，入库永久缓存（同词不二查）；
//   失败静默次日重试，连续 3 天失败 console 告警。
// · 值不值得做（只对 relevance=strong 且已查 DDG 词）：
//   推荐=obsRatio≥2 且 serpDedicated=0；可以试试=obsRatio≥1 且 serpDedicated≤2；
//   不值得做=obsRatio<0.5 或 serpDedicated≥5；未查→「竞争度待查」。
// · 站点发现：竞争度查询顺便产出 site-discoveries（host/平台/命中词/首次发现/DDG 排名/
//   品牌词标记）。品牌词（域名含品牌名 或 suggest 无该词）→「不建议做」。
// 配额纪律：每天只查 score（=observations）TOP100，DDG 与 suggest 间隔 500ms 串行。
import type { Store } from "./store";
import { termId, bumpSeenTermsVersion } from "./seen-terms";
import { fetchSuggest, Limiter } from "./seen-dig";

const DAY_MS = 86400000;
const JUDGE_TOP = 100;
const DDG_INTERVAL_MS = 500;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Accept-Language": "en;q=0.9" };
// 品牌词黑名单：命中即「不建议做」（大厂域名/产品词没有独立站机会）
const BRAND_RE = /openai|google|anthropic|claude|gemini|microsoft|github|amazon|netflix|facebook|apple|nvidia|bytedance|baidu|alibaba|tencent|perplexity|midjourney|notion|slack|zoom|figma|spotify|youtube|tesla|x\.ai/i;
const STATIC_PLATFORMS: [RegExp, string][] = [
  [/\.vercel\.app$/i, "vercel"],
  [/\.github\.io$/i, "github.io"],
  [/\.pages\.dev$/i, "pages.dev"],
  [/\.netlify\.app$/i, "netlify"],
];

function day(offset: number, now = new Date()): string {
  return new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

// obsRatio（判定层 5）：近 2 天日均 ÷ 前 7 天日均；前 7 天无观测 → undefined（无基线）。
export function computeObsRatio(term: { obsByDay?: Record<string, number> }, now: Date = new Date()): number | undefined {
  const byDay = term.obsByDay || {};
  const recent = (byDay[day(0, now)] || 0) + (byDay[day(1, now)] || 0);
  let prev = 0;
  for (let o = 2; o <= 8; o++) prev += byDay[day(o, now)] || 0;
  if (!prev) return undefined;
  return (recent / 2) / (prev / 7);
}

export type TermVerdict = "推荐" | "可以试试" | "不值得做" | "竞争度待查";

// 值不值得做三档判定。调用方按需给 obsRatio（避免重复计算）。
export function judgeVerdict(term: { serpDedicated?: number; obsByDay?: Record<string, number> }, now: Date = new Date()): { verdict: TermVerdict; reason: string } {
  if (typeof term.serpDedicated !== "number") return { verdict: "竞争度待查", reason: "DDG 竞争度未查" };
  const ratio = computeObsRatio(term, now);
  if (ratio === undefined) return { verdict: "竞争度待查", reason: "obsRatio 无基线（前 7 天无观测）" };
  const obs = ratio.toFixed(2);
  if (ratio < 0.5) return { verdict: "不值得做", reason: `obs ${obs} 明显退坡` };
  if (term.serpDedicated! >= 5) return { verdict: "不值得做", reason: `竞争站 ${term.serpDedicated} 个扎堆` };
  if (ratio >= 2 && term.serpDedicated === 0) return { verdict: "推荐", reason: `obs ${obs} 上升且零竞争站` };
  if (ratio >= 1 && term.serpDedicated! <= 2) return { verdict: "可以试试", reason: `obs ${obs}、竞争站 ${term.serpDedicated}` };
  return term.serpDedicated! <= 4
    ? { verdict: "可以试试", reason: `obs ${obs}、竞争站 ${term.serpDedicated}（中位）` }
    : { verdict: "不值得做", reason: `obs ${obs}、竞争站 ${term.serpDedicated}` };
}

// score 口径（配额纪律）：观测次数即热度分；每天只查 TOP100。
export function wordScore(term: { observations?: number }): number {
  return term.observations ?? 0;
}

// ---- DDG SERP ----
const SITE_FILTERS = "site:vercel.app OR site:github.io OR site:pages.dev OR site:netlify.app";

export function ddgQuery(term: string): string {
  return `${term} ${SITE_FILTERS}`;
}

export function platformOf(host: string): string | undefined {
  const hit = STATIC_PLATFORMS.find(([re]) => re.test(host));
  return hit?.[1];
}

// 解析 result__a 链接；uddg 重定向参数解码；title 去标签。
export function parseDdgResults(html: string): { host: string; url: string; title: string }[] {
  const out: { host: string; url: string; title: string }[] = [];
  for (const match of html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let href = match[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { continue; } }
    try {
      const url = new URL(href);
      out.push({ host: url.hostname.replace(/^www\./, ""), url: url.toString(), title: match[2].replace(/<[^>]+>/g, "").trim() });
    } catch { continue; }
    if (out.length >= 30) break;
  }
  return out;
}

export async function fetchDdg(q: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<string> {
  const response = await doFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
    signal: AbortSignal.any([outer ?? AbortSignal.timeout(10 * 60000), AbortSignal.timeout(12000)]),
    headers: UA,
  });
  if (!response.ok) throw new Error(`ddg HTTP ${response.status}`);
  const html = await response.text();
  if (/anomaly|captcha|unusual traffic/i.test(html.slice(0, 4000))) throw new Error("ddg blocked");
  return html;
}

// ---- SERP 搜索层（第三轮 3）：DDG 对容器 IP 回 202 反爬挑战页（实弹 2/66 成功），
// 主力改内网 SearXNG（聚合后端、site: 语义正确、零反爬；hybrid 搜索同源），DDG html 降为兜底。
export type SerpHit = { host: string; url: string; title: string };

export async function searchSerp(db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<{ engine: string; results: SerpHit[] }> {
  const errors: string[] = [];
  const base = (db.config().searxngUrl || "http://searxng:8080").replace(/\/+$/, "");
  try {
    const query = `"${term}" ${SITE_FILTERS}`;
    const response = await doFetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
      signal: AbortSignal.any([outer ?? AbortSignal.timeout(10 * 60000), AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error(`searxng HTTP ${response.status}`);
    const data = JSON.parse(await response.text()) as { results?: { url?: string; title?: string }[] };
    const results: SerpHit[] = [];
    for (const item of data.results || []) {
      try {
        const url = new URL(String(item.url || ""));
        results.push({ host: url.hostname.replace(/^www\./, ""), url: url.toString(), title: String(item.title || "").replace(/<[^>]+>/g, "").trim() });
      } catch { continue; }
      if (results.length >= 30) break;
    }
    return { engine: "searxng", results };
  } catch (e) {
    errors.push("searxng: " + String((e as Error)?.message || e).slice(0, 80));
  }
  try {
    const html = await fetchDdg(ddgQuery(term), doFetch, outer);
    return { engine: "ddg", results: parseDdgResults(html) };
  } catch (e) {
    errors.push("ddg: " + String((e as Error)?.message || e).slice(0, 80));
    throw new Error(errors.join(" | "));
  }
}

// ---- 站点发现 ----
type SiteStore = Store;
function mergeSiteDiscovery(db: SiteStore, host: string, platform: string, term: string, rank: number, brand: boolean, brandReason?: string) {
  const prev = db.get<any>("site-discoveries", host);
  const doc = {
    id: host,
    host,
    platform,
    firstFoundAt: prev?.firstFoundAt ?? new Date().toISOString(),
    bestRank: Math.min(prev?.bestRank ?? 99, rank),
    terms: [...new Set([...(prev?.terms || []), term])].slice(0, 20),
    brand: prev?.brand || brand,
    brandReason: brand ? (prev?.brandReason && !prev.brand ? brandReason : prev?.brandReason ?? brandReason) : prev?.brandReason,
    updatedAt: new Date().toISOString(),
  };
  db.put("site-discoveries", host, doc);
}

// suggest 无该词（品牌词识别第二判据）：联想无此词 = 无真实搜索需求，命中站点「不建议做」。
function hasSuggestDemand(term: string, suggestions: string[]): boolean {
  const id = termId(term);
  return suggestions.some((s) => {
    const sid = termId(s);
    return sid.includes(id) || id.includes(sid);
  });
}

// ---- 每日判定 tick ----
// 只查 relevance=strong 的 global 词中 score TOP100 且未查过的；永久缓存不二查。
// 全程 fire-and-forget；每词一次 SERP + 一次 suggest（hasDemand 判定），500ms 基础间隔，
// 失败指数退避 1s→2s→4s→8s 封顶（挤过限流窗口），成功复位。
// 「立即整理」（seen-dig-manual）晚于当日完成键时重跑当日判定——失败词同池重试。
export function seenJudgeTick(db: Store, doFetch: typeof fetch = fetch, opts: { backoffBaseMs?: number } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const done = db.get<any>("meta", "seen-judge-done:" + today);
  const manual = db.get<any>("meta", "seen-dig-manual");
  const byManual = !!manual?.date && manual.date === today && (!done || manual.at > done.at);
  if (done && !byManual) return;
  const running = db.get<any>("meta", "seen-judge-running");
  if (running && Date.now() - Date.parse(running.at) < 20 * 60000) return;
  const queue = db.list<any>("seen-terms")
    .filter((t) => t.status !== "archived" && t.relevance === "strong" && (t.region ?? "global") === "global" && typeof t.serpDedicated !== "number")
    .sort((a, b) => wordScore(b) - wordScore(a))
    .slice(0, JUDGE_TOP);
  if (!queue.length) {
    if (byManual) db.put("meta", "seen-judge-done:" + today, { at: new Date().toISOString(), date: today, queue: 0, queried: 0, failed: 0, sites: 0 });
    return;
  }
  db.put("meta", "seen-judge-running", { at: new Date().toISOString() });
  void (async () => {
    console.log(`[seen-judge] 判定开始：队列 ${queue.length} 词（obsRatio + SERP 竞争度 + 站点发现）`);
    let queried = 0, failed = 0, sites = 0;
    const reasons: Record<string, number> = {};
    let consecutiveFailures = 0;
    const backoffBase = opts.backoffBaseMs ?? 1000;
    try {
      const outer = AbortSignal.timeout(10 * 60000);
      await new Limiter(DDG_INTERVAL_MS, 1).run(queue.map((t) => async () => {
        try {
          const { engine, results } = await searchSerp(db, t.term, doFetch, outer);
          consecutiveFailures = 0;
          const platformResults = results.map((r, i) => ({ ...r, rank: i + 1, platform: platformOf(r.host) })).filter((r) => r.platform);
          const hosts = new Set(platformResults.map((r) => r.host));
          // suggest 需求判定：失败不阻塞（按有需求处理，不误标品牌词）
          let demand = true;
          try { demand = hasSuggestDemand(t.term, await fetchSuggest(t.term, "en", doFetch, outer)); } catch { /* 静默 */ }
          for (const r of platformResults) {
            const brand = BRAND_RE.test(r.host) || !demand;
            mergeSiteDiscovery(db, r.host, r.platform!, t.term, r.rank, brand, !demand ? "suggest 无该词" : BRAND_RE.test(r.host) ? "域名含品牌名" : undefined);
            sites++;
          }
          const prev = db.get<any>("seen-terms", String(t.id));
          if (prev) {
            db.put("seen-terms", String(t.id), {
              ...prev,
              serpDedicated: platformResults.length,
              serpInternal: hosts.size,
              serpHosts: [...hosts].slice(0, 10),
              serpEngine: engine,
              serpCheckedAt: new Date().toISOString(),
              serpFailDays: 0,
              updatedAt: new Date().toISOString(),
            });
            bumpSeenTermsVersion(db);
          }
          queried++;
        } catch (e) {
          failed++;
          const reason = String((e as Error)?.message || e).slice(0, 100);
          reasons[reason] = (reasons[reason] || 0) + 1;
          const prev = db.get<any>("seen-terms", String(t.id));
          if (prev) {
            const failDays = (prev.serpFailDays || 0) + 1;
            db.put("seen-terms", String(t.id), { ...prev, serpFailDays: failDays, updatedAt: new Date().toISOString() });
            if (failDays === 3) console.warn(`[seen-judge] 告警：${t.term} 连续 3 天 SERP 查询失败（${reason.slice(0, 60)}）`);
          }
          // 指数退避（成功复位）：连续失败把节奏放慢到 1s→2s→4s→8s，避免顶着限流硬冲
          await new Promise((r) => setTimeout(r, Math.min(8000, backoffBase * 2 ** consecutiveFailures)));
          consecutiveFailures++;
        }
      }));
    } finally {
      const summary = { at: new Date().toISOString(), date: today, queue: queue.length, queried, failed, sites, reasons };
      db.put("meta", "seen-judge-done:" + today, summary);
      db.put("meta", "seen-judge-last", summary);
      db.del("meta", "seen-judge-running");
      const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n}×${r.slice(0, 50)}`).join("；");
      console.log(`[seen-judge] 判定完成：查询 ${queried}（失败 ${failed}${topReasons ? "：" + topReasons : ""}）/ 发现站点 ${sites}`);
    }
  })();
}
