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
  // 预算分池（老大批3 拍板）：档位补位链/指标补查/新词采集 各配独立额度，互不抢占
  builtinTierBudget: number;
  builtinMetricsBudget: number; // metrics 池为「每月」额度（批4：月累计 30）
  builtinCollectBudget: number;
  // 授权勾选（批4 W7-11①⑤，默认关=纯手动模式零余额消耗）：付费接口自动调用需显式授权
  autoMetrics: boolean; // 允许自动查关键词指标（三指标/域名清单）
  autoCollect: boolean; // 允许自动月更标杆站与外链反推
};

export const DEFAULT_SEO_SOURCE: SeoSourceConfig = {
  enabled: false,
  provider: "gephei",
  token: "",
  baseUrl: "https://seo.web.cafe/api/v1",
  builtinTierBudget: 60,
  builtinMetricsBudget: 30,
  builtinCollectBudget: 100,
  autoMetrics: false,
  autoCollect: false,
};

const DAY_MS = 86400000;
// 哥飞权威数据新鲜度：90 天过期（过期视为缺失，走免费降级路径）
export const GEPHEI_TTL_MS = 90 * DAY_MS;

export function seoSourceOf(db: Store): SeoSourceConfig {
  const cfg = db.get<any>("config", "seoDataSource");
  const merged = { ...DEFAULT_SEO_SOURCE, ...(cfg && typeof cfg === "object" ? cfg : {}), provider: "gephei" as const };
  // 存量纠正（第七轮批3 联调）：预置过的旧 baseUrl 以 /api 结尾，真实合同是 /api/v1 前缀
  if (typeof merged.baseUrl === "string" && merged.baseUrl.endsWith("/api")) merged.baseUrl += "/v1";
  return merged;
}

export function seoSourceEnabled(db: Store): boolean {
  const s = seoSourceOf(db);
  return !!s.enabled && !!s.token;
}

// ---- 积分断路器（内置侧）：三池独立记账（tier=SERP 量级档位补位 / metrics=三指标补查 / collect=新词采集），
// 超限静默停（免费路径兜底）。老大批3 拍板：各池独立额度互不抢占。
export type SeoPool = "tier" | "metrics" | "collect";
// metrics 池为月粒度（批4 W7-11①「月累计 30」），tier/collect 仍按日
const POOL_META: Record<SeoPool, { prefix: string; budget: (s: SeoSourceConfig) => number; monthly?: boolean }> = {
  tier: { prefix: "seo-api-used:tier:", budget: (s) => s.builtinTierBudget },
  metrics: { prefix: "seo-api-used:metrics:", budget: (s) => s.builtinMetricsBudget, monthly: true },
  collect: { prefix: "seo-api-used:collect:", budget: (s) => s.builtinCollectBudget },
};

function poolKey(pool: SeoPool, now: Date): string {
  const meta = POOL_META[pool];
  const stamp = meta.monthly
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(now)
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  return meta.prefix + stamp;
}

export function seoBudgetUsed(db: Store, pool: SeoPool, now: Date = new Date()): number {
  return db.get<any>("meta", poolKey(pool, now))?.calls ?? 0;
}

export function seoBudgetLeft(db: Store, pool: SeoPool, now: Date = new Date()): number {
  return Math.max(0, POOL_META[pool].budget(seoSourceOf(db)) - seoBudgetUsed(db, pool, now));
}

export function seoSpend(db: Store, pool: SeoPool, words: number, now: Date = new Date()): void {
  if (words <= 0) return;
  const key = poolKey(pool, now);
  const prev = db.get<any>("meta", key)?.calls ?? 0;
  db.put("meta", key, { calls: prev + words, at: new Date().toISOString() });
}

// ---- 泛化 HTTP 客户端：端点与鉴权集中一处（联调校准只改这里）----
// 预置约定：POST JSON，Authorization: Bearer <token>。哥飞实际合同在批3 联调时校准。
type SeoEndpoints = Record<string, string>;
export const GEPHEI_ENDPOINTS: SeoEndpoints = {
  // —— 关键词 ——
  keywordVolume: "/keyword_volume",
  keywordDifficulty: "/keyword_difficulty",
  bulkKeywordDifficulty: "/bulk_keyword_difficulty",
  searchIntent: "/search_intent",
  keywordIdeas: "/keyword_ideas",
  lookupKeywords: "/lookup_keywords",
  searchKnownKeywords: "/search_known_keywords",
  keywordsBatches: "/keywords/batches",
  // —— SERP / 趋势 ——
  serp: "/serp",
  serpReview: "/serp_review",
  trendsRising: "/trends_rising",
  googleTrends: "/google_trends",
  translateDemand: "/translate_demand",
  // —— 网站 / 域名 ——
  siteKeywords: "/site_keywords",
  domainOverview: "/domain_overview",
  domainTraffic: "/domain_traffic",
  domainDr: "/domain_dr",
  findLinkProspects: "/find_link_prospects",
  domainAvailability: "/domain_availability",
  lookupDomains: "/lookup_domains",
  websiteWorth: "/website_worth",
  domainReview: "/domain_review",
  bulkDomainScan: "/bulk_domain_scan",
  searchKnownSites: "/search_known_sites",
  siteHistory: "/site_history",
  domainTimeline: "/domain_timeline",
  // —— 页面 / 变现 ——
  pageCoach: "/page_coach",
  onpageAudit: "/onpage_audit",
  adsenseAudit: "/adsense_audit",
  brandNaming: "/brand_naming",
  fetchUrl: "/fetch_url",
  // —— 知识库 ——
  loadGuide: "/load_guide",
  knowledgeAsk: "/knowledge_ask",
  knowledgeSearch: "/knowledge_search",
  knowledgeRead: "/knowledge_read",
}

export class SeoSourceOffError extends Error {
  constructor() { super("SEO 数据源未配置：设置页开启「SEO 数据源」并填写令牌后解锁（关闭状态下零外部调用）。"); }
}

// 开放 API 只扣钱包余额（每日赠送额度仅限网站内使用）——402 quota = 余额不足，
// 批量调用应短路当日而非逐词重试。
export class SeoQuotaError extends Error {
  constructor(message: string) { super(message); }
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
  if (response.status === 402) throw new SeoQuotaError("哥飞开放 API 积分余额不足（每日赠送额度不适用于开放 API）——到 seo.web.cafe/wallet/ 购买积分包后继续。");
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
  if (seoBudgetLeft(db, "metrics") <= 0) return out;
  const spend = Math.min(terms.length, seoBudgetLeft(db, "metrics"));
  seoSpend(db, "metrics", spend);
  const batch = terms.slice(0, spend);
  const safe = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch((e) => { if (e instanceof SeoQuotaError) throw e; return fallback; });
  // search_intent 永久内置 AI（批4 W7-11②：不自动查哥飞意图，省 5 分/词；仅手动回传顺带落库对照）
  const [volumes, difficulties] = await Promise.all([
    safe(gepheiCall(db, GEPHEI_ENDPOINTS.keywordVolume, { keywords: batch }, doFetch, outer), null as any),
    safe(gepheiCall(db, GEPHEI_ENDPOINTS.bulkKeywordDifficulty, { keywords: batch }, doFetch, outer), null as any),
  ]).catch((e) => {
    if (e instanceof SeoQuotaError) console.warn(`[seo-source] 哥飞余额不足，本批 ${batch.length} 词跳过（充值后次日自动恢复）`);
    throw e;
  });
  // 响应归一（2026-10-14 实测真实合同）：data.keywords = { 词: 值 } map——
  // volume 值={avg, competition, avgCpc, lowBid, highBid}；difficulty 值=纯数字；
  // intent 值={intent}。数组形态保留兼容（旧测试/mock）。
  const byTerm = (raw: any, pick: (v: any) => Partial<KeywordMetrics>): Map<string, KeywordMetrics> => {
    const m = new Map<string, KeywordMetrics>();
    let entries: [string, any][] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) entries.push([String(item?.keyword ?? item?.term ?? ""), item]);
    } else if (raw && typeof raw === "object") {
      const kw = raw.data?.keywords ?? raw.keywords ?? raw.data;
      if (kw && typeof kw === "object" && !Array.isArray(kw)) entries = Object.entries(kw);
      else if (Array.isArray(raw.data)) entries = raw.data.map((item: any) => [String(item?.keyword ?? ""), item]);
    }
    for (const [key, value] of entries) {
      const k = key.trim().toLowerCase();
      if (k) m.set(k, pick(value));
    }
    return m;
  };
  const v = byTerm(volumes, (v) => {
    const o = v && typeof v === "object" ? v : {};
    return { monthlySearch: num(o.avg ?? o.volume ?? o.search_volume), cpc: num(o.avgCpc ?? o.cpc) };
  });
  const d = byTerm(difficulties, (v) => ({ kd: typeof v === "number" ? v : num(v?.difficulty ?? v?.kd) }));
  for (const term of batch) {
    const key = term.trim().toLowerCase();
    // 显式赋值合并（弃用三连 spread：tsx 下曾出现后段键值静默丢失的诡异行为）
    const merged: KeywordMetrics = {};
    const mv = v.get(key), md = d.get(key);
    if (mv?.monthlySearch !== undefined) merged.monthlySearch = mv.monthlySearch;
    if (mv?.cpc !== undefined) merged.cpc = mv.cpc;
    if (md?.kd !== undefined) merged.kd = md.kd;
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
  // 官方合同：serp 参数名 q（≤200 字符），gl 默认 us
  const raw = await gepheiCall(db, GEPHEI_ENDPOINTS.serp, { q: term.slice(0, 200), gl: "us" }, doFetch, outer);
  return normalizeSerpResults(raw);
}

// ---- 全量扩展方法面（挖词/找词/找需求；批3 外部 Agent 日更与内置深查使用）----
export const seoApi = {
  keywordIdeas: (db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.keywordIdeas, { keyword: term }, doFetch, outer),
  // 官方合同：trends_rising 收词根数组（≤20，不传用预设词根表）
  trendsRising: (db: Store, roots: string[], doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.trendsRising, { roots: roots.slice(0, 20) }, doFetch, outer),
  googleTrends: (db: Store, term: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.googleTrends, { keyword: term }, doFetch, outer),
  siteKeywords: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.siteKeywords, { target: domain, limit: 50 }, doFetch, outer),
  domainOverview: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainOverview, { domain }, doFetch, outer),
  domainTraffic: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainTraffic, { domains: [domain] }, doFetch, outer),
  domainRating: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainRating, { domain }, doFetch, outer),
  // 官方合同：find_link_prospects 是卖链站市场快照（8万+ Guest Post 挂牌），按筛选器查询而非关键词
  findLinkProspects: (db: Store, opts: { minDr?: number; minTraffic?: number; limit?: number }, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.findLinkProspects, { minDr: opts.minDr ?? 20, minTraffic: opts.minTraffic ?? 1000, limit: opts.limit ?? 30 }, doFetch, outer),
  domainAvailability: (db: Store, domains: string[], doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.domainAvailability, { domains }, doFetch, outer),
  lookupDomains: (db: Store, domains: string[], doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.lookupDomains, { domains }, doFetch, outer),
  websiteWorth: (db: Store, domain: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.websiteWorth, { domain }, doFetch, outer),
  knowledgeSearch: (db: Store, query: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeSearch, { query }, doFetch, outer),
  knowledgeRead: (db: Store, id: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeRead, { id }, doFetch, outer),
  knowledgeAsk: (db: Store, question: string, doFetch: typeof fetch, outer?: AbortSignal) => gepheiCall(db, GEPHEI_ENDPOINTS.knowledgeAsk, { question }, doFetch, outer),
};

// ---- 连接测试（W7-10④ settings 按钮）：轻接口验证 token + 积分余额（/credits 端点预置，联调校准）----
// 不占预算池（单次轻探测，非业务调用）。
export async function seoConnectionTest(db: Store, doFetch: typeof fetch): Promise<{ ok: boolean; message: string; credits?: number }> {
  if (!seoSourceEnabled(db)) return { ok: false, message: "SEO 数据源未开启或令牌未填写——先打开开关并保存令牌。" };
  try {
    // 官方合同：GET /me 免费返回余额/剩余（零积分消耗的连接测试）
    const res = await doFetch(`${seoSourceOf(db).baseUrl.replace(/\/+$/, "")}/me`, {
      headers: { Authorization: `Bearer ${seoSourceOf(db).token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({})) as any;
    if (res.status === 402 || body?.code === "quota") {
      return { ok: true, message: "token 有效，但开放 API 积分余额为 0（每日赠送额度仅限网站内使用）——到 seo.web.cafe/wallet/ 购买积分包后功能自动生效。", credits: 0 };
    }
    if (!res.ok) return { ok: false, message: `连接失败：HTTP ${res.status}` };
    const credits = Number(body?.apiAvailable ?? body?.wallet?.balance ?? body?.balance ?? body?.credits ?? NaN);
    const daySpent = Number(body?.wallet?.daySpent ?? NaN);
    const gift = Number(body?.gift?.limit ?? NaN);
    const giftUsed = Number(body?.gift?.used ?? NaN);
    const extra = [
      Number.isFinite(daySpent) ? `今日已扣 ${daySpent}` : null,
      Number.isFinite(gift) && Number.isFinite(giftUsed) ? `网站赠送 ${giftUsed}/${gift}` : null,
    ].filter(Boolean).join("，");
    return { ok: true, message: `连接成功，token 有效，API 积分余额 ${Number.isFinite(credits) ? credits : "（字段待确认）"}${extra ? "（" + extra + "）" : ""}`, credits: Number.isFinite(credits) ? credits : undefined };
  } catch (e) {
    return { ok: false, message: "连接失败：" + (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
};

// —— 哥飞站内工具页深链（批4 W7-11①⑥：实测真实路径 2026-10-14 全部 200，禁止臆造 /tools/）——
// 准站群卡「待查指标」指导行用：词专属预填 kw 参数，老大点开即达零记忆。
export const GEPHEI_SITE = "https://seo.web.cafe";
export function gepheiToolLinks(term: string): { label: string; url: string }[] {
  const kw = encodeURIComponent(term);
  return [
    { label: "难度", url: `${GEPHEI_SITE}/kd/?kw=${kw}` },
    { label: "搜索量/拓词", url: `${GEPHEI_SITE}/ideas/?kw=${kw}` },
    { label: "SERP", url: `${GEPHEI_SITE}/serp/?kw=${kw}` },
    { label: "站点词", url: `${GEPHEI_SITE}/sitekw/?kw=${kw}` },
    { label: "流量", url: `${GEPHEI_SITE}/traffic/?kw=${kw}` },
    { label: "估值", url: `${GEPHEI_SITE}/worth/?kw=${kw}` },
    { label: "DR", url: `${GEPHEI_SITE}/dr/?kw=${kw}` },
  ];
}

// 手动回传（批4 W7-11④）：解析哥飞站内查询结果粘贴文本——JSON 优先，回退按行
// 切分（tab/竖线/多空格），字段序=词 月搜 KD CPC（后三可缺）。防御式，解析不出的行跳过。
export type ManualGepheiItem = { term: string; monthlySearch?: number; kd?: number; cpc?: number; intent?: string };
export function parseManualGephei(raw: string): { items: ManualGepheiItem[]; mode: "json" | "text" } {
  const text = String(raw || "").trim();
  if (!text) return { items: [], mode: "text" };
  try {
    const parsed = JSON.parse(text);
    const list: any[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
    const items: ManualGepheiItem[] = [];
    for (const item of list) {
      const term = String(item?.keyword ?? item?.term ?? "").trim().slice(0, 80);
      if (!term) continue;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      items.push({
        term,
        monthlySearch: num(item?.volume ?? item?.monthlySearch ?? item?.monthly_search),
        kd: num(item?.difficulty ?? item?.kd),
        cpc: num(item?.cpc),
        intent: typeof item?.intent === "string" ? item.intent.slice(0, 30) : undefined,
      });
    }
    if (items.length) return { items, mode: "json" };
  } catch { /* 回退文本模式 */ }
  const items: ManualGepheiItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\t|\s{2,}|\s*\|\s*/).filter(Boolean);
    if (cols.length < 2) continue;
    const term = cols[0].trim().slice(0, 80);
    const nums = cols.slice(1).map((c) => Number(String(c).replace(/[$,%]/g, ""))).filter((n) => Number.isFinite(n));
    if (!term || !nums.length) continue;
    items.push({ term, monthlySearch: nums[0], kd: nums[1], cpc: nums[2] });
  }
  return { items, mode: "text" };
}
