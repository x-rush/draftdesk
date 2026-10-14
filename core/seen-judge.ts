// 判定层 + 站点发现（海外定位批 5/6，第五轮 §5/§6 扩容放宽）：
// · obsRatio：近 2 天 observations 日均 ÷ 前 3 天日均（基线窗口 7→3 天；obsByDay 按日记数）。
//   不足 3 天基线时 judgeVerdict 走保守兜底（只用 observations/daysSeen，只出 可以试试/不值得做）。
// · SERP 竞争度：内网 SearXNG（DDG html 兜底）抓 {term} site:vercel.app OR site:github.io
//   OR site:pages.dev OR site:netlify.app——四类静态平台上有没有人已经做了同题独立站。
//   serpDedicated=竞争站条数 / serpInternal=独立 host 数，入库永久缓存（同词不二查）；
//   失败静默次日重试，连续 3 天失败 console 告警。
// · 值不值得做（只对 relevance=strong 且已查 SERP 词）：推荐=obsRatio≥2 且零竞争站（必须满基线）；
//   可以试试=obsRatio≥1 且 serpDedicated≤2；不值得做=obsRatio<0.5 或 serpDedicated≥5。
// · 站点发现：竞争度查询顺便产出 site-discoveries（host/平台/命中词/首次发现/SERP 排名/
//   品牌词标记）。品牌词（域名含品牌名 或 suggest 无该词）→「不建议做」。
// 吞吐扩容（§5）：积压 >500 时每天 3 批、每批 200 词（批间隔 ≥4h），≤500 每天 1 批 100 词；
// 完成键记「本批游标与批次号」而非当日一次，同日可多批。SearXNG 间隔 500ms 不变。
import type { Store } from "./store";
import { termId, bumpSeenTermsVersion } from "./seen-terms";
import { fetchSuggest, Limiter } from "./seen-dig";
import { GEPHEI_TTL_MS, seoSourceEnabled, seoBudgetLeft, seoSpend, fetchKeywordMetrics, fetchSerp, seoApi } from "./seo-source";

const DAY_MS = 86400000;
// 吞吐扩容（第五轮 §5，「按积压动态批数」落到验收口径）：
// 积压 ≤500 → 每天 1 批 × 100；500<积压≤2000 → 每天 3 批 × 200（早/午/晚，间隔 ≥4h）；
// 积压 >2000 → 重档 12 批 × 250 = 3000 词/日（间隔 ≥100 分钟）——3×200=600/日
// 清不动 7112 存量（48h 验收 <2000 需 ~2556/日），重档由验收反推；SearXNG 500ms 间隔不变。
const JUDGE_TOP = 100;
const JUDGE_TOP_MID = 200;
const JUDGE_TOP_HEAVY = 250;
const BUSY_THRESHOLD = 500;
const HEAVY_THRESHOLD = 2000;
const MID_MAX_BATCHES = 3;
const HEAVY_MAX_BATCHES = 12;
const GAP_MID_MS = 4 * 60 * 60000;
const GAP_HEAVY_MS = 100 * 60000;
const DDG_INTERVAL_MS = 500;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Accept-Language": "en;q=0.9" };
// 品牌词黑名单：命中即「不建议做」（大厂域名/产品词没有独立站机会）
// 品牌与低值模式规则表（收尾批 §3①）：规则驱动替代散落正则；reapplySiteRules 按表复核存量。
export type SiteRule = { id: string; pattern: RegExp; kind: "brand" | "portfolio"; reason: string };
export const SITE_RULES: SiteRule[] = [
  { id: "brand-ai-labs", kind: "brand", pattern: /openai|anthropic|claude|gemini|midjourney|perplexity|x\.ai/i, reason: "域名含 AI 大厂品牌名" },
  { id: "brand-bigtech", kind: "brand", pattern: /google|microsoft|github|amazon|netlify|facebook|apple|nvidia|bytedance|baidu|alibaba|tencent|notion|slack|zoom|figma|spotify|youtube|tesla/i, reason: "域名含大厂品牌名" },
  // 个人作品集/简历页：非品牌但无产品参考价值 → 降权折叠（不做「不建议做」硬判）
  { id: "portfolio", kind: "portfolio", pattern: /portfolio|(^|[.-])about([.-]|$)|(^|[.-])cv([.-]|$)|(^|[.-])resume([.-]|$)/i, reason: "个人作品集/简历页" },
];

// 平台后缀（四大静态托管）：品牌匹配前剥掉——user.github.io / foo.netlify.app
// 是用户站不是品牌站（旧 BRAND_RE 子串匹配曾把整个 github.io 全军误标「不建议做」）。
const PLATFORM_SUFFIX = /\.(?:vercel\.app|github\.io|pages\.dev|netlify\.app)$/i;

export function matchSiteRule(host: string): SiteRule | undefined {
  const core = host.replace(PLATFORM_SUFFIX, "");
  return SITE_RULES.find((r) => r.pattern.test(core));
}
const STATIC_PLATFORMS: [RegExp, string][] = [
  [/\.vercel\.app$/i, "vercel"],
  [/\.github\.io$/i, "github.io"],
  [/\.pages\.dev$/i, "pages.dev"],
  [/\.netlify\.app$/i, "netlify"],
];

function day(offset: number, now = new Date()): string {
  return new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

// obsRatio（判定层 5，第五轮 §6 放宽）：近 2 天日均 ÷ 前 3 天日均；
// 前 3 天无观测 → undefined（无基线，judgeVerdict 走保守兜底）。
export function computeObsRatio(term: { obsByDay?: Record<string, number> }, now: Date = new Date()): number | undefined {
  const byDay = term.obsByDay || {};
  const recent = (byDay[day(0, now)] || 0) + (byDay[day(1, now)] || 0);
  let prev = 0;
  for (let o = 2; o <= 4; o++) prev += byDay[day(o, now)] || 0;
  if (!prev) return undefined;
  return (recent / 2) / (prev / 3);
}

export type TermVerdict = "推荐" | "可以试试" | "不值得做" | "竞争度待查";

// 「谷歌自答」守门（第五轮批 2b §4.8②）：单位换算/汇率/翻译/计算类词的流量被
// Google 自答框直接吃掉，做站上限「可以试试」、不判「推荐」（保守分支本就 ≤可以试试）。
// 命中是词级正则；存量已出档词读时复算即生效，无需迁移。
const GOOGLE_ANSWER_RE = /unit|converter|calculator|exchange.?rate|currency|翻译|换算|单位|汇率/i;

export function isGoogleAnswerTerm(term: string | undefined): boolean {
  return !!term && GOOGLE_ANSWER_RE.test(term);
}

// 值不值得做三档判定（第五轮 §6）：
// · 满基线（obsByDay 前 3 天有观测）：完整三档，「推荐」必须满基线且非谷歌自答类词；
// · 不足基线：保守兜底——只用 observations 总量与 daysSeen，只出 可以试试/不值得做，
//   已查 SERP 的词立即出档不再滞留「待查」（读时计算，改口径即回填）。
export function judgeVerdict(term: { term?: string; serpDedicated?: number; obsByDay?: Record<string, number>; observations?: number; daysSeen?: string[] }, now: Date = new Date()): { verdict: TermVerdict; reason: string } {
  if (typeof term.serpDedicated !== "number") return { verdict: "竞争度待查", reason: "SERP 竞争度未查" };
  const googleAnswer = isGoogleAnswerTerm(term.term);
  const ratio = computeObsRatio(term, now);
  if (ratio !== undefined) {
    const obs = ratio.toFixed(2);
    if (ratio < 0.5) return { verdict: "不值得做", reason: `obs ${obs} 明显退坡` };
    if (term.serpDedicated! >= 5) return { verdict: "不值得做", reason: `竞争站 ${term.serpDedicated} 个扎堆` };
    if (ratio >= 2 && term.serpDedicated === 0) {
      if (googleAnswer) return { verdict: "可以试试", reason: `谷歌自答类词（换算/汇率/单位），obs ${obs} 再好也只做到可以试试` };
      return { verdict: "推荐", reason: `obs ${obs} 上升且零竞争站` };
    }
    if (ratio >= 1 && term.serpDedicated! <= 2) return { verdict: "可以试试", reason: `obs ${obs}、竞争站 ${term.serpDedicated}` };
    return term.serpDedicated! <= 4
      ? { verdict: "可以试试", reason: `obs ${obs}、竞争站 ${term.serpDedicated}（中位）` }
      : { verdict: "不值得做", reason: `obs ${obs}、竞争站 ${term.serpDedicated}` };
  }
  const obs = term.observations ?? 0;
  const days = term.daysSeen?.length ?? 0;
  if (term.serpDedicated! >= 5) return { verdict: "不值得做", reason: `竞争站 ${term.serpDedicated} 个扎堆（未满基线）` };
  if (obs >= 2 && term.serpDedicated === 0) return { verdict: "可以试试", reason: googleAnswer ? `谷歌自答类词，观测 ${obs} 次零竞争站（未满基线，保守档）` : `观测 ${obs} 次零竞争站（未满基线，保守档）` };
  if (days >= 2 && obs >= 3 && term.serpDedicated! <= 2) return { verdict: "可以试试", reason: `${days} 天复现、竞争站 ${term.serpDedicated}（未满基线）` };
  return { verdict: "不值得做", reason: `观测 ${obs} 次、竞争站 ${term.serpDedicated}，无增速基线` };
}

// score 口径（配额纪律）：观测次数即热度分；每天只查 TOP100。
export function wordScore(term: { observations?: number }): number {
  return term.observations ?? 0;
}

// ---- SERP 派生字段（批 2b §4.8③，免费派生不改判定阈值）----
// · exact：host 含完整词（去空格小写包含，词长 ≥4 防误匹配）——精确匹配域名数
// · homeShare：首页占比（URL 路径深度启发；存量词只有 serpHosts 无 url → null）
// · forumShare：论坛/视频站占比（reddit/youtube/quora 等归类）
// 数据源：优先 serpAll（新查词全量结果）；降级 serpHosts（存量词，只有四大平台 host）。
const FORUM_VIDEO_HOST = /reddit|youtube|quora|stackoverflow|tiktok|twitter|x\.com|instagram|news\.ycombinator|medium|hackernoon|dev\.to|pinterest|facebook/i;

export type SerpDerived = { exact: number; homeShare: number | null; forumShare: number; total: number; source: "full" | "hosts-only" };

// 数据源优先级：serpWeb（普通查询，论坛/视频占比的真实原料）> serpAll（带 site: 过滤
// 的平台站结果，结构性无论坛站）> serpHosts（存量词）。homeShare 需要 URL。
export function deriveSerpFields(t: { term?: string; serpWeb?: { host: string; url: string }[]; serpAll?: { host: string; url: string }[]; serpHosts?: string[] }): SerpDerived | null {
  const source: "full" | "hosts-only" = t.serpWeb?.length ? "full" : t.serpAll?.length ? "full" : "hosts-only";
  const all = t.serpWeb?.length ? t.serpWeb
    : t.serpAll?.length ? t.serpAll
      : (t.serpHosts?.length ? t.serpHosts.map((h) => ({ host: h, url: `https://${h}/` })) : []);
  if (!all.length) return null;
  const id = termId(t.term || "");
  const exact = id.length >= 4 ? all.filter((e) => termId(e.host).includes(id)).length : 0;
  let home: number | null = null;
  if (t.serpWeb?.length || t.serpAll?.length) {
    const homeCount = all.filter((e) => {
      try { const p = new URL(e.url).pathname.replace(/\/+$/, ""); return p === "" || p.split("/").length <= 1; } catch { return true; }
    }).length;
    home = Math.round((homeCount / all.length) * 100);
  }
  const forum = all.filter((e) => FORUM_VIDEO_HOST.test(e.host)).length;
  return { exact, homeShare: home, forumShare: Math.round((forum / all.length) * 100), total: all.length, source };
}

// ---- SERP 竞争观测升级（第七轮 W7-2）----
// serpTop10Home：SERP 前 10 中首页数（路径深度 ≤1，与 homeShare 同一启发式）；
// serpTop3Tier：前 3 名 host 的整站量级档位（Similarweb 免费档 best-effort：
// >10万 large / 1–10万 mid / <1万 small / 探测到但无流量 none；探测失败不落字段）。
// 存量词不回填，新观测自然累积；SW 结果与失败都入 web-traffic 缓存（成功 90 天 /
// 失败 3 天后才重试），每批探测预算硬顶，不拖慢判定主流程。
export type TrafficTier = "large" | "mid" | "small" | "none";
const TIER_RANK: Record<TrafficTier, number> = { large: 3, mid: 2, small: 1, none: 0 };
const SW_TTL_MS = 90 * DAY_MS;
const SW_FAIL_RETRY_MS = 3 * DAY_MS;
const SW_TIMEOUT_MS = 4000;
const SW_PER_BATCH = 20;

function isHomepage(url: string): boolean {
  try { const p = new URL(url).pathname.replace(/\/+$/, ""); return p === "" || p.split("/").length <= 1; } catch { return true; }
}

export function top10HomeCount(hits: SerpHit[]): number {
  return hits.slice(0, 10).filter((h) => isHomepage(h.url)).length;
}

export function maxTrafficTier(tiers: (TrafficTier | undefined)[]): TrafficTier | undefined {
  return tiers.filter((t): t is TrafficTier => !!t).sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0];
}

// 月访问量 → 量级档位（>10万 large / 1–10万 mid / <1万 small / 0 none；SW 与哥飞共用一套口径）
export function visitsToTier(monthly: number): TrafficTier {
  return monthly > 100000 ? "large" : monthly >= 10000 ? "mid" : monthly > 0 ? "small" : "none";
}

function cacheTraffic(db: Store, host: string, tier: TrafficTier, visits: number | undefined, source: "sw" | "gephei") {
  db.put("web-traffic", host.toLowerCase(), { tier, ...(visits !== undefined ? { visits } : {}), source, at: new Date().toISOString() });
}

function cachedTier(db: Store, host: string): TrafficTier | undefined {
  const cached = db.get<any>("web-traffic", host.toLowerCase());
  if (!cached?.tier) return undefined;
  return Date.now() - Date.parse(cached.at || 0) < SW_TTL_MS ? cached.tier as TrafficTier : undefined;
}

// Similarweb 免费档监测哨（W7-3 定位降级）：哥飞未配置/未命中时的量级来源。
export async function trafficTierOf(host: string, db: Store, doFetch: typeof fetch, budget: { left: number }): Promise<TrafficTier | undefined> {
  const id = host.toLowerCase();
  const cached = db.get<any>("web-traffic", id);
  if (cached) {
    const age = Date.now() - Date.parse(cached.at || 0);
    if (cached.tier && age < SW_TTL_MS) return cached.tier as TrafficTier;
    if (!cached.tier && age < SW_FAIL_RETRY_MS) return undefined;
  }
  if (budget.left <= 0) return cached?.tier as TrafficTier | undefined;
  budget.left--;
  try {
    const response = await doFetch(`https://data.similarweb.com/api/v1/data?domain=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(SW_TIMEOUT_MS),
      headers: { "User-Agent": UA["User-Agent"], Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`similarweb HTTP ${response.status}`);
    const data = await response.json() as { EstimatedMonthlyVisits?: Record<string, number> };
    const visits = Object.values(data.EstimatedMonthlyVisits || {});
    if (!visits.length) throw new Error("similarweb 无流量数据");
    const monthly = Math.max(...visits);
    const tier = visitsToTier(monthly);
    cacheTraffic(db, id, tier, monthly, "sw");
    return tier;
  } catch {
    db.put("web-traffic", id, { at: new Date().toISOString() });
    return undefined;
  }
}

// 哥飞量级补位（W7-3 权威源，老大批2 指令：serpTop3Tier 缺口用 serp 接口补位）：
// serp(term) 前 10 结果自带流量估计则直接派生前 3 档位（并缓存对应 host）；
// 结果不带流量时对缺失 host 逐个 domainTraffic。按调用计预算（积分纪律）。
export async function gepheiTierOf(term: string, hosts: string[], db: Store, doFetch: typeof fetch, outer?: AbortSignal): Promise<TrafficTier | undefined> {
  if (!seoSourceEnabled(db)) return undefined;
  try {
    if (seoBudgetLeft(db) > 0) {
      const results = await fetchSerp(db, term, doFetch, outer);
      seoSpend(db, 1);
      const withTraffic = results.slice(0, 3).filter((r) => typeof r.traffic === "number");
      if (withTraffic.length) {
        const tiers = withTraffic.map((r) => {
          const tier = visitsToTier(r.traffic!);
          cacheTraffic(db, r.host, tier, r.traffic, "gephei");
          return tier;
        });
        return maxTrafficTier(tiers);
      }
    }
  } catch { /* serp 通道失败落逐 host */ }
  let best: TrafficTier | undefined;
  for (const h of hosts) {
    if (seoBudgetLeft(db) <= 0) break;
    try {
      const raw = await seoApi.domainTraffic(db, h, doFetch, outer) as any;
      seoSpend(db, 1);
      const visits = typeof raw === "number" ? raw : Number(raw?.visits ?? raw?.traffic ?? raw?.monthly_traffic ?? raw?.data?.visits ?? NaN);
      if (Number.isFinite(visits)) {
        const tier = visitsToTier(visits);
        cacheTraffic(db, h, tier, visits, "gephei");
        best = maxTrafficTier([best, tier]);
      }
    } catch { /* 单 host 失败继续 */ }
  }
  return best;
}

// ---- siteGate 站群门槛（第七轮 W7-4，哥飞判断参数内化）----
// 判定 tick 达标即自动标 siteCandidate=true（siteCandidateBy=builtin-gate-v1），替代人工标注；
// 外部 Agent 经 GET /agent/siteGate 读同一份规则（规则同源，v1 硬编码白名单废弃）。
// 三指标（monthlySearch/kd/cpc）齐全且带 90 天内 gepheiFetchedAt（哥飞权威源，W7-3）走全门槛；
// 缺失/过期走降级判定（strong + SERP 竞争≤上限 + global），理由注明「价值未验证」；
// 改 config.siteGate 数值双端行为跟随（内置 sweep 只增不撤，撤标走人工）。
export type SiteGate = { requireStrong: boolean; serpDedicatedMax: number; monthlySearchMin: number; kdMax: number; cpcMin: number };
export const DEFAULT_SITE_GATE: SiteGate = { requireStrong: true, serpDedicatedMax: 1, monthlySearchMin: 300, kdMax: 29, cpcMin: 0.1 };

export function siteGateOf(db: Store): SiteGate {
  const cfg = db.get<any>("config", "siteGate");
  return { ...DEFAULT_SITE_GATE, ...(cfg && typeof cfg === "object" ? cfg : {}) };
}

// 哥飞权威指标新鲜度：gepheiFetchedAt 在 90 天内才算全门槛原料（过期=缺失，走降级）
export function seoMetricsFresh(t: { gepheiFetchedAt?: string }): boolean {
  return typeof t.gepheiFetchedAt === "string" && Number.isFinite(Date.parse(t.gepheiFetchedAt)) && Date.now() - Date.parse(t.gepheiFetchedAt) < GEPHEI_TTL_MS;
}

// 综合价值分（W7-3/W7-10 口径）：月搜 × CPC ÷ KD。三指标齐备且新鲜才可算（kd<1 按 1 防除零）。
export function valueScoreOf(t: { monthlySearch?: number; kd?: number; cpc?: number; gepheiFetchedAt?: string }): number | undefined {
  if (!seoMetricsFresh(t)) return undefined;
  const { monthlySearch, kd, cpc } = t;
  if (typeof monthlySearch !== "number" || typeof kd !== "number" || typeof cpc !== "number") return undefined;
  return Math.round((monthlySearch * cpc / Math.max(1, kd)) * 10) / 10;
}

export function evalSiteGate(
  term: { relevance?: string; region?: string; serpDedicated?: number; monthlySearch?: number; kd?: number; cpc?: number; gepheiFetchedAt?: string },
  gate: SiteGate,
): { pass: boolean; reason: string } {
  if ((term.region ?? "global") !== "global") return { pass: false, reason: "非 global 词不进站群池" };
  if (gate.requireStrong && term.relevance !== "strong") return { pass: false, reason: "relevance 未达 strong" };
  if (typeof term.serpDedicated !== "number" || term.serpDedicated > gate.serpDedicatedMax)
    return { pass: false, reason: `SERP 竞争站 ${typeof term.serpDedicated === "number" ? term.serpDedicated : "未查"} 超过上限 ${gate.serpDedicatedMax}` };
  const full = seoMetricsFresh(term) && typeof term.monthlySearch === "number" && typeof term.kd === "number" && typeof term.cpc === "number";
  if (!full) return { pass: true, reason: `降级门槛达标：strong + SERP 竞争 ${term.serpDedicated}≤${gate.serpDedicatedMax}（三指标未配，价值未验证）` };
  const misses: string[] = [];
  if (term.monthlySearch! < gate.monthlySearchMin) misses.push(`月搜 ${term.monthlySearch}<${gate.monthlySearchMin}`);
  if (term.kd! > gate.kdMax) misses.push(`KD ${term.kd}>${gate.kdMax}`);
  if (term.cpc! < gate.cpcMin) misses.push(`CPC ${term.cpc}<${gate.cpcMin}`);
  if (misses.length) return { pass: false, reason: `全门槛未达：${misses.join("，")}` };
  return { pass: true, reason: `全门槛达标：月搜 ${term.monthlySearch}/KD ${term.kd}/CPC ${term.cpc}，SERP 竞争 ${term.serpDedicated}≤${gate.serpDedicatedMax}` };
}

// 自动标注 sweep：判定 tick 批末跑——达标词 upsert 进 seo-terms（站群卡消费集合，
// generateFromSiteCandidates 读 siteCandidate:true 出卡）。已标词（含外部 Agent 标注）
// 一律跳过不覆写；单次上限 200 防写爆，余量随下一批判定自然接续。
// SEO 数据源开启时（W7-3）：降级达标的词先经哥飞补查三指标落库（seen-terms 词库字段
// + gepheiFetchedAt 时间戳），按全门槛重判——达标出标（价值分可算）、不过保持不标；
// 补查失败/预算尽保持降级口径出标（增值源故障不丢候选）。
export async function siteGateAutoMark(db: Store, doFetch: typeof fetch = fetch, limit = 200): Promise<{ marked: number; scanned: number; enriched: number }> {
  const gate = siteGateOf(db);
  const seoOn = seoSourceEnabled(db);
  const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
  let marked = 0, enriched = 0;
  const all = db.list<any>("seen-terms");
  for (const t of all) {
    if (marked >= limit) break;
    const word = String(t.term || t.id || "").trim();
    if (!word || t.status === "archived") continue;
    if (markedIds.has(termId(word))) continue;
    let verdict = evalSiteGate(t, gate);
    let metrics: { monthlySearch?: number; kd?: number; cpc?: number; gepheiFetchedAt?: string } = {};
    // 哥飞补查：降级达标但无新鲜指标 → 拉三指标落库并按全门槛重判（每日预算闸内）
    if (verdict.pass && !seoMetricsFresh(t) && seoOn && seoBudgetLeft(db) > 0) {
      try {
        const [m] = [...(await fetchKeywordMetrics(db, [word], doFetch)).values()];
        if (m && (m.monthlySearch !== undefined || m.kd !== undefined || m.cpc !== undefined || m.intent !== undefined)) {
          enriched++;
          metrics = { ...(m.monthlySearch !== undefined ? { monthlySearch: m.monthlySearch } : {}), ...(m.kd !== undefined ? { kd: m.kd } : {}), ...(m.cpc !== undefined ? { cpc: m.cpc } : {}), gepheiFetchedAt: new Date().toISOString() };
          // 词库落库（W7-8 外部 Agent 同一落点字段）。哥飞意图四分映射词库 intent 轴
          //（transactional→commercial；navigational 在词库轴无对应不猜测），只补缺不覆盖。
          const intentMap: Record<string, string> = { informational: "informational", commercial: "commercial", transactional: "commercial" };
          const mappedIntent = m.intent ? intentMap[m.intent] : undefined;
          const prevTerm = db.get<any>("seen-terms", termId(word));
          if (prevTerm) {
            db.put("seen-terms", termId(word), {
              ...prevTerm, ...metrics,
              ...(mappedIntent && !prevTerm.intent ? { intent: mappedIntent } : {}),
              updatedAt: new Date().toISOString(),
            });
            bumpSeenTermsVersion(db);
          }
          verdict = evalSiteGate({ ...t, ...metrics }, gate);
        }
      } catch { /* 补查失败保持降级口径 */ }
    }
    if (!verdict.pass) continue;
    // seo-terms id 口径 = term 小写（保空格），与 PUT agent/seo-terms 一致
    const seoId = word.toLowerCase();
    const prev = db.get<any>("seo-terms", seoId);
    if (prev?.siteCandidate === true) { markedIds.add(termId(word)); continue; }
    const stamp = new Date().toISOString();
    db.put("seo-terms", seoId, {
      ...(prev ?? {}),
      ...metrics,
      id: seoId,
      term: word,
      siteCandidate: true,
      siteCandidateBy: "builtin-gate-v1",
      siteRationale: verdict.reason,
      updatedAt: stamp,
      ...(prev?.createdAt ? {} : { createdAt: stamp }),
    });
    markedIds.add(termId(word));
    marked++;
  }
  if (marked || enriched) console.log(`[seen-judge] siteGate 自动标注 ${marked} 词${enriched ? `（哥飞补查 ${enriched} 词指标）` : ""}（builtin-gate-v1，扫描 ${all.length}）`);
  return { marked, scanned: all.length, enriched };
}

// 站群候选池判定口（第六轮批 B §2.5② 双通道 + 第七轮 W7-1 意图通道）：
// 观测 = global + obs≥3 + 来源≥2；竞争 = strong + SERP 已查 + 竞争≤siteGate 上限；
// 意图 = strong + demandIntent=tool（工具语义词直通候选池）。读时计算，改 siteGate 即生效。
export function siteCandidateEligibleOf(
  t: { region?: string; observations?: number; sources?: unknown; relevance?: string; serpDedicated?: number; demandIntent?: string },
  gate: SiteGate = DEFAULT_SITE_GATE,
): boolean {
  if ((t.region ?? "global") !== "global") return false;
  const sourceCount = Array.isArray(t.sources) ? t.sources.length : 0;
  if ((t.observations ?? 0) >= 3 && sourceCount >= 2) return true;
  if (t.relevance === "strong" && typeof t.serpDedicated === "number" && t.serpDedicated <= gate.serpDedicatedMax) return true;
  if (t.relevance === "strong" && t.demandIntent === "tool") return true;
  return false;
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

// SearXNG 裸查询（searxng 主力层共用）：无 site: 过滤的普通查询供形态分析（serpWeb）。
export async function searchSearxngRaw(db: Store, query: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<SerpHit[]> {
  const base = (db.config().searxngUrl || "http://searxng:8080").replace(/\/+$/, "");
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
  return results;
}

export async function searchSerp(db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<{ engine: string; results: SerpHit[] }> {
  const errors: string[] = [];
  try {
    const results = await searchSearxngRaw(db, `"${term}" ${SITE_FILTERS}`, doFetch, outer);
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

// ---- 判定 tick（第五轮 §5 吞吐扩容）----
// 只查 relevance=strong 的 global 词中未查过的，按 score 降序取批：
// 积压 ≤500 每天 1 批 100 词；>500 每天 3 批 200 词（同批间隔 ≥4h）。
// 完成键记「批次号 + 本批游标（末词 id）」而非当日一次，同日可多批；
// 已查词（serpDedicated 已落库）天然退出队列，游标即隐式推进。
// 全程 fire-and-forget；每词一次 SERP + 一次 suggest（hasDemand 判定），500ms 基础间隔，
// 失败指数退避 1s→2s→4s→8s 封顶（挤过限流窗口），成功复位。
// 「立即整理」（seen-dig-manual）晚于当日完成键时越过批闸重跑——失败词同池重试。
export function seenJudgeTick(db: Store, doFetch: typeof fetch = fetch, opts: { backoffBaseMs?: number; now?: Date; intervalMs?: number } = {}) {
  const nowDate = opts.now ?? new Date();
  const today = nowDate.toISOString().slice(0, 10);
  const doneKey = "seen-judge-done:" + today;
  const done = db.get<any>("meta", doneKey);
  const manual = db.get<any>("meta", "seen-dig-manual");
  const byManual = !!manual?.date && manual.date === today && (!done || manual.at > done.at);
  const queue = db.list<any>("seen-terms")
    .filter((t) => t.status !== "archived" && t.relevance === "strong" && (t.region ?? "global") === "global" && typeof t.serpDedicated !== "number")
    .sort((a, b) => wordScore(b) - wordScore(a));
  if (!queue.length) {
    if (byManual && !done) db.put("meta", doneKey, { at: nowDate.toISOString(), date: today, batches: 0, queue: 0, queried: 0, failed: 0, sites: 0 });
    return;
  }
  // busy 是日级标志（busyDay 一旦置位全天保持）：首批吞掉后积压与 done.queue
  // 都会跌破阈值，若按当前积压判 maxBatches 会掉回 1，把当天剩余批次闸死。
  const busy = queue.length > BUSY_THRESHOLD || done?.busyDay === true;
  const heavy = queue.length > HEAVY_THRESHOLD || done?.heavyDay === true;
  const maxBatches = heavy ? HEAVY_MAX_BATCHES : busy ? MID_MAX_BATCHES : 1;
  const gapMs = heavy ? GAP_HEAVY_MS : GAP_MID_MS;
  if (!byManual && done) {
    if ((done.batches ?? 1) >= maxBatches) return;
    if (done.at && nowDate.getTime() - Date.parse(done.at) < gapMs) return;
  }
  // 批量 200 词（含退避）可能超旧 20 分钟窗：running 守卫放宽到 45 分钟
  const running = db.get<any>("meta", "seen-judge-running");
  if (running && Date.now() - Date.parse(running.at) < 45 * 60000) return;
  const batch = queue.slice(0, heavy ? JUDGE_TOP_HEAVY : busy ? JUDGE_TOP_MID : JUDGE_TOP);
  db.put("meta", "seen-judge-running", { at: new Date().toISOString() });
  const batchNo = (done?.batches ?? 0) + 1;
  void (async () => {
    console.log(`[seen-judge] 判定开始（第 ${batchNo}/${maxBatches} 批，积压 ${queue.length}）：本批 ${batch.length} 词（obsRatio + SERP 竞争度 + 站点发现）`);
    let queried = 0, failed = 0, sites = 0;
    const reasons: Record<string, number> = {};
    let consecutiveFailures = 0;
    const backoffBase = opts.backoffBaseMs ?? 1000;
    const swBudget = { left: SW_PER_BATCH };
    try {
      const outer = AbortSignal.timeout(40 * 60000);
      await new Limiter(opts.intervalMs ?? DDG_INTERVAL_MS, 1).run(batch.map((t) => async () => {
        try {
          const { engine, results } = await searchSerp(db, t.term, doFetch, outer);
          consecutiveFailures = 0;
          const platformResults = results.map((r, i) => ({ ...r, rank: i + 1, platform: platformOf(r.host) })).filter((r) => r.platform);
          const hosts = new Set(platformResults.map((r) => r.host));
          // 形态查询（批 2b §4.8③）：不带 site: 的普通查询，论坛/视频占比的原料
          //（带过滤查询的结果里结构性没有论坛站）。失败静默，不阻塞判定主流程。
          let webResults: SerpHit[] = [];
          try { webResults = await searchSearxngRaw(db, `"${t.term}"`, doFetch, outer); } catch { /* 静默 */ }
          // 竞争观测结构化（第七轮 W7-2/W7-3）：前 10 首页数 + 前 3 名流量档位。
          // 档位探测链：web-traffic 缓存 → 哥飞权威补位（serp 接口，配置时）→ Similarweb 监测哨。
          const serpSource = webResults.length ? webResults : results;
          const serpTop10Home = top10HomeCount(serpSource);
          let serpTop3Tier: TrafficTier | undefined;
          try {
            const hosts = [...new Set(serpSource.slice(0, 3).map((r) => r.host))];
            serpTop3Tier = maxTrafficTier(hosts.map((h) => cachedTier(db, h)));
            if (!serpTop3Tier && hosts.length) {
              if (seoSourceEnabled(db)) serpTop3Tier = await gepheiTierOf(t.term, hosts, db, doFetch, outer);
              if (!serpTop3Tier) serpTop3Tier = maxTrafficTier(await Promise.all(hosts.map((h) => trafficTierOf(h, db, doFetch, swBudget))));
            }
          } catch { /* 静默 */ }
          // suggest 需求判定：失败不阻塞（按有需求处理，不误标品牌词）
          let demand = true;
          try { demand = hasSuggestDemand(t.term, await fetchSuggest(t.term, "en", doFetch, outer)); } catch { /* 静默 */ }
          for (const r of platformResults) {
            const rule = matchSiteRule(r.host);
            const brand = rule?.kind === "brand" || !demand;
            mergeSiteDiscovery(db, r.host, r.platform!, t.term, r.rank, brand, !demand ? "suggest 无该词" : rule?.kind === "brand" ? rule.reason : undefined);
            if (rule?.kind === "portfolio") {
              const p = db.get<any>("site-discoveries", r.host);
              if (p && !p.portfolio) db.put("site-discoveries", r.host, { ...p, portfolio: true, portfolioReason: rule.reason, updatedAt: new Date().toISOString() });
            }
            sites++;
          }
          const prev = db.get<any>("seen-terms", String(t.id));
          if (prev) {
            db.put("seen-terms", String(t.id), {
              ...prev,
              serpDedicated: platformResults.length,
              serpInternal: hosts.size,
              serpHosts: [...hosts].slice(0, 10),
              // 全量结果摘要（批 2b §4.8③）：三派生字段的原料（存量词只有 serpHosts）
              serpAll: results.slice(0, 24).map((r) => ({ host: r.host, url: r.url.slice(0, 120), title: r.title.slice(0, 80) })),
              serpWeb: webResults.slice(0, 15).map((r) => ({ host: r.host, url: r.url.slice(0, 120) })),
              // 结构化竞争观测（第七轮 W7-2）：新观测词带字段，存量不回填
              serpTop10Home,
              ...(serpTop3Tier ? { serpTop3Tier } : {}),
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
      // 完成键 = 本批游标：batches 计批次号，cursor 记本批末词 id（下批从队列余量自然接续）；
      // at 用注入时钟（与批间隔闸同源），生产环境即真实时间。
      const summary = { at: nowDate.toISOString(), date: today, batches: batchNo, busyDay: busy, heavyDay: heavy, queue: queue.length, queried, failed, sites, reasons, cursor: String(batch[batch.length - 1]?.id ?? "") };
      db.put("meta", doneKey, summary);
      db.put("meta", "seen-judge-last", summary);
      db.del("meta", "seen-judge-running");
      const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n}×${r.slice(0, 50)}`).join("；");
      console.log(`[seen-judge] 第 ${batchNo} 批完成：查询 ${queried}（失败 ${failed}${topReasons ? "：" + topReasons : ""}）/ 发现站点 ${sites} / 游标 ${summary.cursor.slice(0, 24)}`);
      // siteGate 自动标注（第七轮 W7-4）：批末 sweep，新达标词即日出标（替代人工标注）；
      // SEO 数据源开启时先经哥飞补查三指标（W7-3，异步不阻塞收尾）
      void siteGateAutoMark(db, doFetch).catch((e) =>
        console.error("[seen-judge] siteGate 自动标注失败（不影响判定主流程）:", e instanceof Error ? e.message : e));
    }
  })();
}

// ---- 规则表存量复核（收尾批 §3①）----
// 按 SITE_RULES 重扫 site-discoveries：增量补标不翻旧账——
// 已 brand=true 的保留原 reason（含「suggest 无该词」判据）；未标而表命中的升 brand；
// portfolio 命中的补 portfolio 标记（降权折叠用）。迁移 site-discovery-rules-v1 调用。
export function reapplySiteRules(db: Store): { scanned: number; branded: number; portfolio: number; unbranded: number } {
  let scanned = 0, branded = 0, portfolio = 0, unbranded = 0;
  for (const d of db.list<any>("site-discoveries")) {
    scanned++;
    const rule = matchSiteRule(d.host);
    const patch: Record<string, unknown> = {};
    if (rule?.kind === "brand" && !d.brand) {
      patch.brand = true;
      patch.brandReason = rule.reason;
      branded++;
    } else if (rule === undefined && d.brand && typeof d.brandReason === "string" && d.brandReason.includes("品牌名")) {
      // 双向复核：域名子串判据标的（reason 含「品牌名」）但剥平台后缀后不命中 → 清误标；
      // 「suggest 无该词」判据的 brand 保留（独立判据，不由本表翻转）。
      patch.brand = false;
      patch.brandReason = "";
      unbranded++;
    }
    if (rule?.kind === "portfolio" && !d.portfolio) {
      patch.portfolio = true;
      patch.portfolioReason = rule.reason;
      portfolio++;
    }
    if (Object.keys(patch).length) db.put("site-discoveries", d.host, { ...d, ...patch, updatedAt: new Date().toISOString() });
  }
  return { scanned, branded, portfolio, unbranded };
}
