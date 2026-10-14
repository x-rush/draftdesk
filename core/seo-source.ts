// SEO 数据源适配器（第七轮批2 W7-3）：可选增值数据源，默认关闭、关闭时零外部调用。
// 泛化 HTTP 客户端 + 语义方法面（monthlySearch/difficulty/cpc/intent + 全量扩展）——
// 换数据源只换 provider 实现，siteGate/判定/价值分逻辑不动。
// 内置唯一 provider = gephei（哥飞 SEO 工具箱 seo.web.cafe/api，会员积分制，自行注册）：
// 仓库不携带任何令牌；端点路径与鉴权头集中在本文件一处，联调批3 校准时只改这里。
// 数据权威级：哥飞数据带 gepheiFetchedAt 时间戳、90 天过期，为 SERP/意图/趋势/三指标
// 四类数据的权威源，覆盖自采同名数据；自采探针（SearXNG/Similarweb）降为日常监测哨。
import type { Store } from "./store";

export type SeoSourceConfig = {
  enabled: boolean;
  provider: "gephei";
  token: string;
  baseUrl: string;
  builtinDailyBudget: number;
};

export const DEFAULT_SEO_SOURCE: SeoSourceConfig = {
  enabled: false,
  provider: "gephei",
  token: "",
  baseUrl: "https://seo.web.cafe/api",
  builtinDailyBudget: 200,
};

const DAY_MS = 86400000;
// 哥飞权威数据新鲜度：90 天过期（过期视为缺失，走免费降级路径）
export const GEPHEI_TTL_MS = 90 * DAY_MS;

export function seoSourceOf(db: Store): SeoSourceConfig {
  const cfg = db.get<any>("config", "seoDataSource");
  return { ...DEFAULT_SEO_SOURCE, ...(cfg && typeof cfg === "object" ? cfg : {}), provider: "gephei" };
}

export function seoSourceEnabled(db: Store): boolean {
  const s = seoSourceOf(db);
  return !!s.enabled && !!s.token;
}

// ---- 积分断路器（内置侧）：按「词/次探测」计数的日预算，超限静默停（免费路径兜底）----
function budgetKey(day: string) { return "seo-api-used:" + day; }

export function seoBudgetUsed(db: Store): number {
  const day = new Date().toISOString().slice(0, 10);
  return db.get<any>("meta", budgetKey(day))?.calls ?? 0;
}

export function seoBudgetLeft(db: Store): number {
  return Math.max(0, seoSourceOf(db).builtinDailyBudget - seoBudgetUsed(db));
}

export function seoSpend(db: Store, words: number): void {
  if (words <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = budgetKey(day);
  const prev = db.get<any>("meta", key)?.calls ?? 0;
  db.put("meta", key, { calls: prev + words, at: new Date().toISOString() });
}

// ---- 泛化 HTTP 客户端：端点与鉴权集中一处（联调校准只改这里）----
// 预置约定：POST JSON，Authorization: Bearer <token>。哥飞实际合同在批3 联调时校准。
type SeoEndpoints = Record<string, string>;
export const GEPHEI_ENDPOINTS: SeoEndpoints = {
  keywordVolume: "/keyword_volume",
  keywordDifficulty: "/bulk_keyword_difficulty",
  searchIntent: "/search_intent",
  keywordIdeas: "/keyword_ideas",
  trendsRising: "/trends_rising",
  googleTrends: "/google_trends",
  serp: "/serp",
  siteKeywords: "/site_keywords",
  domainOverview: "/domain_overview",
  domainTraffic: "/domain_traffic",
  domainRating: "/domain_rating",
  findLinkProspects: "/find_link_prospects",
  domainAvailability: "/domain_availability",
  lookupDomains: "/lookup_domains",
  websiteWorth: "/website_worth",
  knowledgeSearch: "/knowledge_search",
  knowledgeRead: "/knowledge_read",
  knowledgeAsk: "/knowledge_ask",
};

export class SeoSourceOffError extends Error {
  constructor() { super("SEO 数据源未配置：设置页开启「SEO 数据源」并填写令牌后解锁（关闭状态下零外部调用）。"); }
}

export async function gepheiCall<T = any>(db: Store, endpoint: string, payload: Record<string, unknown>, doFetch: typeof fetch, outer?: AbortSignal): Promise<T> {
  const src = seoSourceOf(db);
  if (!src.enabled || !src.token) throw new SeoSourceOffError();
  const base = src.baseUrl.replace(/\/+$/, "");
  const response = await doFetch(`${base}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${src.token}`, Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([outer ?? AbortSignal.timeout(60000), AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error(`gephei ${endpoint} HTTP ${response.status}`);
  return await response.json() as T;
}

// ---- 语义方法面：三指标 + intent（换数据源不改 siteGate 逻辑的隔离层）----
export type KeywordMetrics = { monthlySearch?: number; kd?: number; cpc?: number; intent?: string };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pick = (obj: unknown, ...keys: string[]): unknown => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if ((obj as any)[k] !== undefined && (obj as any)[k] !== null) return (obj as any)[k];
  return undefined;
};

// 响应归一（防御式，兼容 {data:{…}} 包装 / 裸对象 / 数组首项三种形状）：
// 月搜 volume|search_volume|monthly_search(es)|ms；KD difficulty|kd；CPC cpc；
// 意图 intent|search_intent（informational/commercial/navigational/transactional 等）。
export function normalizeKeywordMetrics(raw: unknown): KeywordMetrics {
  let o = raw;
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === "object" && "data" in (o as any)) o = (o as any).data;
  if (Array.isArray(o)) o = o[0];
  if (!o || typeof o !== "object") return {};
  const intent = pick(o, "intent", "search_intent");
  return {
    monthlySearch: num(pick(o, "volume", "search_volume", "monthly_search", "monthlySearches", "ms")),
    kd: num(pick(o, "difficulty", "kd", "keyword_difficulty")),
    cpc: num(pick(o, "cpc", "cost_per_click")),
    intent: typeof intent === "string" ? intent.slice(0, 30) : undefined,
  };
}

// 批量三指标（W7-8 同款三接口：keyword_volume + bulk_keyword_difficulty + search_intent）：
// 内部并行三调用，按词归一合并；按词计积分预算。单词失败不影响其他词（该词字段缺省走降级）。
export async function fetchKeywordMetrics(db: Store, terms: string[], doFetch: typeof fetch, outer?: AbortSignal): Promise<Map<string, KeywordMetrics>> {
  const out = new Map<string, KeywordMetrics>();
  if (!terms.length || !seoSourceEnabled(db)) return out;
  if (seoBudgetLeft(db) <= 0) return out;
  const spend = Math.min(terms.length, seoBudgetLeft(db));
  seoSpend(db, spend);
  const batch = terms.slice(0, spend);
  const safe = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
  const [volumes, difficulties, intents] = await Promise.all([
    safe(gepheiCall(db, GEPHEI_ENDPOINTS.keywordVolume, { keywords: batch }, doFetch, outer), null as any),
    safe(gepheiCall(db, GEPHEI_ENDPOINTS.keywordDifficulty, { keywords: batch }, doFetch, outer), null as any),
    safe(gepheiCall(db, GEPHEI_ENDPOINTS.searchIntent, { keywords: batch }, doFetch, outer), null as any),
  ]);
  const byTerm = (raw: any): Map<string, KeywordMetrics> => {
    const m = new Map<string, KeywordMetrics>();
    const list: any[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Array.isArray(raw.data) ? raw.data : Object.entries(raw).map(([keyword, v]) => ({ keyword, ...(typeof v === "object" ? v : { volume: v }) })) : [];
    for (const item of list) {
      const key = String(item?.keyword || item?.term || "").trim().toLowerCase();
      if (key) m.set(key, normalizeKeywordMetrics(item));
    }
    return m;
  };
  const v = byTerm(volumes), d = byTerm(difficulties), i = byTerm(intents);
  for (const term of batch) {
    const key = term.trim().toLowerCase();
    // 显式赋值合并（弃用三连 spread：tsx 下曾出现后段键值静默丢失的诡异行为）
    const merged: KeywordMetrics = {};
    const mv = v.get(key), md = d.get(key), mi = i.get(key);
    if (mv?.monthlySearch !== undefined) merged.monthlySearch = mv.monthlySearch;
    if (mv?.cpc !== undefined) merged.cpc = mv.cpc;
    if (md?.kd !== undefined) merged.kd = md.kd;
    if (mi?.intent !== undefined) merged.intent = mi.intent;
    if (merged.monthlySearch !== undefined || merged.kd !== undefined || merged.cpc !== undefined || merged.intent !== undefined) out.set(term, merged);
  }
  return out;
}

// SERP 权威源（前 10 完整解析）：覆盖自采探针粗测。防御式抽每结果流量估计
//（traffic|estimated_traffic|visits|monthly_traffic），带流量的结果用于量级档位派生。
export type SeoSerpResult = { host: string; url?: string; title?: string; rank?: number; traffic?: number };

export function normalizeSerpResults(raw: unknown): SeoSerpResult[] {
  let list: any[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") list = (raw as any).data ?? (raw as any).results ?? (raw as any).organic ?? [];
  const out: SeoSerpResult[] = [];
  let rank = 0;
  for (const item of list.slice(0, 10)) {
    rank++;
    let host = String(pick(item, "domain", "host", "site") || "");
    const url = pick(item, "url", "link");
    if (!host && typeof url === "string") { try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { continue; } }
    if (!host) continue;
    out.push({
      host: host.toLowerCase(),
      url: typeof url === "string" ? url.slice(0, 300) : undefined,
      title: typeof item?.title === "string" ? item.title.slice(0, 200) : undefined,
      rank: typeof item?.rank === "number" ? item.rank : rank,
      traffic: num(pick(item, "traffic", "estimated_traffic", "visits", "monthly_traffic", "traffic_monthly")),
    });
  }
  return out;
}

export async function fetchSerp(db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<SeoSerpResult[]> {
  if (!seoSourceEnabled(db)) throw new SeoSourceOffError();
  const raw = await gepheiCall(db, GEPHEI_ENDPOINTS.serp, { keyword: term }, doFetch, outer);
  return normalizeSerpResults(raw);
}

// ---- 全量扩展方法面（挖词/找词/找需求；批3 外部 Agent 日更与内置深查使用）----
export const seoApi = {
  keywordIdeas: (db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.keywordIdeas, { keyword: term }, doFetch, outer),
  trendsRising: (db: Store, geo: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.trendsRising, { geo }, doFetch, outer),
  googleTrends: (db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.googleTrends, { keyword: term }, doFetch, outer),
  siteKeywords: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.siteKeywords, { domain }, doFetch, outer),
  domainOverview: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainOverview, { domain }, doFetch, outer),
  domainTraffic: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainTraffic, { domain }, doFetch, outer),
  domainRating: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainRating, { domain }, doFetch, outer),
  findLinkProspects: (db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.findLinkProspects, { keyword: term }, doFetch, outer),
  domainAvailability: (db: Store, domains: string[], doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainAvailability, { domains }, doFetch, outer),
  lookupDomains: (db: Store, domains: string[], doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.lookupDomains, { domains }, doFetch, outer),
  websiteWorth: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.websiteWorth, { domain }, doFetch, outer),
  knowledgeSearch: (db: Store, query: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeSearch, { query }, doFetch, outer),
  knowledgeRead: (db: Store, id: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeRead, { id }, doFetch, outer),
  knowledgeAsk: (db: Store, question: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeAsk, { question }, doFetch, outer),
};
