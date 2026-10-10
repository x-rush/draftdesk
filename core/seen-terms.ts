// 热词捕获（信息架构 v2 增补）：seen-terms 数据层与晋级逻辑。
// 状态机：new（首见）→ rising（observations≥2）→ sustained（daysSeen 连续 3 天）→ archived（人工）。
// 双写合并（批复 D）：API PUT 走 mergeSeenTerm（sources 并集 / observations 取 max / status 只升不降）；
// 内置提取走 observeSeenTerm（observations+1 / daysSeen 记日期 / 晋级）。
// 结构化最小接口：Store 与 KV 都满足（避免把调用方绑死在 KV 类上）
type TermStore = { get<T>(collection: string, id: string): T | undefined; put<T>(collection: string, id: string, value: T): T };

export type SeenTermStatus = "new" | "rising" | "sustained" | "archived";
const RANK: Record<SeenTermStatus, number> = { new: 0, rising: 1, sustained: 2, archived: 3 };

// 搜索意图（热词掘金 v3）：规则判定先行，供词表筛选与选题匹配。
// 判定顺序按需求清单：教程/方法 → 对比/替代 → 价格/商业 → 疑问句式兜底。
export type SeenTermIntent = "informational" | "comparison" | "commercial" | "question";
export function classifyIntent(term: string): SeenTermIntent {
  const raw = term.trim();
  const lower = raw.toLowerCase();
  const zh = (...markers: string[]) => markers.some((m) => raw.includes(m));
  const en = (...markers: string[]) => markers.some((m) => new RegExp(`(^|[^a-z])${m}([^a-z]|$)`, "i").test(lower));
  // ① informational：怎么/如何/为什么/教程/方法/步骤/指南
  if (zh("怎么", "如何", "为什么", "教程", "方法", "步骤", "指南", "是什么") || en("how", "what is", "why", "guide", "tutorial", "walkthrough")) return "informational";
  // ② comparison：替代/对比/比较/vs/哪个好/同类
  if (zh("替代", "对比", "比较", "哪个好", "同类", "平替") || en("alternative", "vs", "versus", "compare", "comparison", "instead of")) return "comparison";
  // ③ commercial：价格/多少钱/收费/费用/免费/买
  if (zh("价格", "多少钱", "收费", "费用", "免费", "报价", "买") || en("price", "pricing", "cost", "free", "cheap", "discount", "deal", "buy")) return "commercial";
  // ④ question：疑问句式（问号结尾/句首疑问词/语气词/「是谁」句式）
  if (/[？?]$/.test(raw) || zh("吗", "么", "哪个", "哪些", "谁", "是多少") || en("is", "are", "can", "does", "do", "should", "which", "when", "where", "who", "will")) return "question";
  return "informational";
}

// 长尾词判定（词表徽章）：≥3 个空格分隔的词元视为长尾（博客选题金矿）。
// 中文连写无空格按 1 个词元处理；联想展开结果常含产品名+意图词，多为一词元以上。
export function isLongTail(term: string): boolean {
  return term.trim().split(/\s+/).length >= 3;
}

export function termId(term: string): string {
  return term.trim().toLowerCase();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// status 只升不降（archived 除外——archived 只能人工设置，机器永不降级/升级它）
function upgradeStatus(current: SeenTermStatus | undefined, next: SeenTermStatus): SeenTermStatus {
  if (current === "archived") return "archived";
  return RANK[next] > RANK[current ?? "new"] ? next : (current ?? "new");
}

export function getSeenTerm(kv: TermStore, term: string): any | undefined {
  return kv.get("seen-terms", termId(term));
}

// 外部 Agent upsert（批复 D 合并语义）
export function mergeSeenTerm(kv: TermStore, input: {
  term: string; sources?: string[]; relatedSearches?: string[]; offTopic?: boolean;
  status?: SeenTermStatus; frequency?: number; observations?: number; lastSeenAt?: string;
  seed?: string; intent?: SeenTermIntent;
}, by: string) {
  const id = termId(input.term);
  const prev = kv.get<any>("seen-terms", id);
  const status = input.status && input.status !== "archived" ? upgradeStatus(prev?.status, input.status) : prev?.status ?? "new";
  const doc = {
    id,
    term: prev?.term ?? input.term.trim(),
    firstSeenAt: prev?.firstSeenAt ?? input.lastSeenAt ?? now0(),
    lastSeenAt: [input.lastSeenAt, prev?.lastSeenAt].filter(Boolean).sort().at(-1),
    sources: [...new Set([...(prev?.sources || []), ...(input.sources || [])])],
    relatedSearches: [...new Set([...(prev?.relatedSearches || []), ...(input.relatedSearches || [])])],
    observations: Math.max(prev?.observations ?? 0, input.observations ?? 0, input.frequency ?? 0),
    status,
    offTopic: input.offTopic ?? prev?.offTopic,
    // 血缘（seed）只记首见种子；intent 显式传入优先，否则保留旧值
    seed: prev?.seed ?? input.seed,
    intent: input.intent ?? prev?.intent,
    daysSeen: prev?.daysSeen ?? [],
    producedBy: by,
    updatedAt: now0(),
    ...(prev?.createdAt ? {} : { createdAt: now0() }),
  };
  kv.put("seen-terms", id, doc);
  bumpSeenTermsVersion(kv);
  return doc;
}

// 内置提取/晋级（每日一次）：observations+1、daysSeen 记日期、按阈值晋级
export function observeSeenTerm(kv: TermStore, term: string, opts: { sources?: string[]; offTopic?: boolean; day?: string } = {}) {
  const id = termId(term);
  const prev = kv.get<any>("seen-terms", id);
  const day = opts.day ?? today();
  const daysSeen: string[] = [...new Set([...(prev?.daysSeen || []), day])].sort();
  // 一天一次计数：同日重复提取不膨胀 observations
  const observations = (prev?.observations ?? 0) + (prev?.daysSeen?.includes(day) ? 0 : 1);
  let status: SeenTermStatus = prev?.status ?? "new";
  if (status !== "archived") {
    if (status === "new" && observations >= 2) status = "rising";
    if (status === "rising" && has3Consecutive(daysSeen)) status = "sustained";
  }
  const doc = {
    id,
    term: prev?.term ?? term.trim(),
    firstSeenAt: prev?.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    sources: [...new Set([...(prev?.sources || []), ...(opts.sources || [])])],
    relatedSearches: prev?.relatedSearches || [],
    observations,
    status,
    daysSeen,
    offTopic: opts.offTopic ?? prev?.offTopic,
    seed: prev?.seed,
    intent: prev?.intent ?? classifyIntent(term),
    producedBy: prev?.producedBy ?? "builtin-extract/1.0.0",
    updatedAt: now0(),
    ...(prev?.createdAt ? {} : { createdAt: now0() }),
  };
  kv.put("seen-terms", id, doc);
  bumpSeenTermsVersion(kv);
  return doc;
}

// 联想展开入库（热词掘金 v3 引擎 A）：新词 status=new 带种子血缘；
// 已存在词只推进 lastSeenAt/observations（每日跑一次，天然同日至多 +1），
// seed 只记首见，intent 缺失时按规则补判。
export function observeSuggestion(kv: TermStore, term: string, seed: string, opts: { source?: string; intent?: SeenTermIntent } = {}) {
  const id = termId(term);
  const prev = kv.get<any>("seen-terms", id);
  if (prev) {
    const doc = {
      ...prev,
      lastSeenAt: new Date().toISOString(),
      observations: (prev.observations ?? 0) + 1,
      sources: [...new Set([...(prev.sources || []), ...(opts.source ? [opts.source] : [])])],
      seed: prev.seed ?? seed,
      intent: opts.intent ?? prev.intent ?? classifyIntent(term),
      updatedAt: now0(),
    };
    kv.put("seen-terms", id, doc);
    bumpSeenTermsVersion(kv);
    return doc;
  }
  const now = new Date().toISOString();
  const doc = {
    id,
    term: term.trim(),
    firstSeenAt: now,
    lastSeenAt: now,
    sources: [opts.source || "suggest-expansion"],
    relatedSearches: [],
    observations: 1,
    status: "new" as SeenTermStatus,
    daysSeen: [],
    seed,
    intent: opts.intent ?? classifyIntent(term),
    offTopic: undefined,
    producedBy: "suggest-expansion/1.0.0",
    updatedAt: now,
    createdAt: now,
  };
  kv.put("seen-terms", id, doc);
  bumpSeenTermsVersion(kv);
  return doc;
}

export function has3Consecutive(days: string[]): boolean {
  const set = new Set(days);
  const sorted = [...set].sort();
  for (let i = 2; i < sorted.length; i++) {
    const a = new Date(sorted[i - 2] + "T00:00:00Z").getTime();
    const b = new Date(sorted[i - 1] + "T00:00:00Z").getTime();
    const c = new Date(sorted[i] + "T00:00:00Z").getTime();
    if (c - b === 86400000 && b - a === 86400000) return true;
  }
  return false;
}

function now0() { return new Date().toISOString(); }

// 主路径写入标记：外部 Agent PUT 成功后调用，供 worker 兜底闸门判断「今日已有数据」。
export function markSeenTermsWrite(kv: TermStore) {
  kv.put("meta", "seen-terms-last-write", { at: new Date().toISOString() });
}

// ---- 规模化查询（热词掘金 v3 + 词表分页批）：全部经 kv.sqlRows 在 SQLite C 层完成，
// 3 万条量级目标：分页 <100ms / 三区 <50ms / q 搜索 <100ms。字段名均为内部常量。 ----
type SqlStore = { sqlRows(sql: string, ...params: any[]): Array<Record<string, unknown>>; get<T>(collection: string, id: string): T | undefined };
const parseRows = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.parse(String(r.body)));

// 写入版本号：merge/observe/observeSuggestion/归档出库各 bump 一次，
// 供三区缓存判断「自上次计算以来数据是否变过」。
export function bumpSeenTermsVersion(kv: TermStore) {
  const prev = kv.get<{ n: number }>("meta", "seen-terms-version");
  kv.put("meta", "seen-terms-version", { n: (prev?.n ?? 0) + 1 });
}

export type SeenListQuery = { limit: number; offset: number; status?: string; intent?: string; q?: string };
const STATUS_ORDER = `CASE json_extract(body,'$.status') WHEN 'sustained' THEN 0 WHEN 'rising' THEN 1 WHEN 'new' THEN 2 ELSE 3 END`;

export function querySeenTerms(kv: SqlStore, query: SeenListQuery): { items: any[]; total: number } {
  const status = query.status || "";
  const intent = query.intent || "";
  const q = (query.q || "").trim().toLowerCase().slice(0, 80);
  const where = [
    "collection='seen-terms'",
    "(?='' OR json_extract(body,'$.status')=?)",
    "(?='' OR json_extract(body,'$.intent')=?)",
    "(?='' OR json_extract(body,'$.id') LIKE '%'||?||'%')",
  ].join(" AND ");
  const params = [status, status, intent, intent, q, q];
  const total = (kv.sqlRows(`SELECT COUNT(*) c FROM documents WHERE ${where}`, ...params)[0] as { c: number }).c;
  const rows = kv.sqlRows(
    `SELECT body FROM documents WHERE ${where} ORDER BY ${STATUS_ORDER}, json_extract(body,'$.lastSeenAt') DESC LIMIT ? OFFSET ?`,
    ...params, query.limit, query.offset,
  );
  return { items: parseRows(rows), total };
}

// 雷达三区（服务端口径）：
// 🆕 新词 = status=new，firstSeenAt 降序；
// 📈 突增 = observations≥3 且 firstSeenAt 7 天内，观测降序；
// 🔥 持续 = status=sustained，daysSeen 长度降序。各限 20 并带总数（查看全部）。
// 列表与 COUNT 分离（窗口函数会破坏 LIMIT 短路，实测 2.4 万行全物化 81ms）；
// 每条查询都被表达式索引命中并在 LIMIT 处截断，3 万条 <50ms。
export function seenTermZones(kv: SqlStore, sinceDays = 7): { fresh: { items: any[]; total: number }; hot: { items: any[]; total: number }; sustained: { items: any[]; total: number } } {
  const version = kv.get<{ n: number }>("meta", "seen-terms-version")?.n ?? 0;
  if (zoneCache && zoneCache.v === version) return zoneCache.zones;
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const count = (sql: string, ...params: any[]) =>
    (kv.sqlRows(sql, ...params)[0] as { c: number } | undefined)?.c ?? 0;
  const fresh = {
    items: parseRows(kv.sqlRows(
      `SELECT body FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='new' ORDER BY json_extract(body,'$.firstSeenAt') DESC LIMIT 20`,
    )),
    total: count(`SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='new'`),
  };
  const hotWhere = `collection='seen-terms' AND json_extract(body,'$.status')!='archived' AND json_extract(body,'$.offTopic') IS NOT 1 AND json_extract(body,'$.observations')>=3 AND json_extract(body,'$.firstSeenAt')>=?`;
  const hot = {
    items: parseRows(kv.sqlRows(
      `SELECT body FROM documents WHERE ${hotWhere} ORDER BY json_extract(body,'$.observations') DESC LIMIT 20`,
      since,
    )),
    total: count(`SELECT COUNT(*) c FROM documents WHERE ${hotWhere}`, since),
  };
  const sustained = {
    items: parseRows(kv.sqlRows(
      `SELECT body FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='sustained' ORDER BY json_array_length(json_extract(body,'$.daysSeen')) DESC LIMIT 20`,
    )),
    total: count(`SELECT COUNT(*) c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='sustained'`),
  };
  const zones = { fresh, hot, sustained };
  zoneCache = { v: version, zones };
  return zones;
}
// 三区缓存：term 写入会 bump 版本；同版本内重复请求（雷达高频刷新）免掉
// 两条 2 万+级 COUNT 全程扫描，只跑 LIMIT 短路的列表查询。
let zoneCache: { v: number; zones: ReturnType<typeof seenTermZones> } | undefined;

// 意图计数（词表筛选 tab 角标）：一次 GROUP BY。
export function seenIntentCounts(kv: SqlStore): Record<string, number> {
  const rows = kv.sqlRows(
    `SELECT json_extract(body,'$.intent') intent, COUNT(*) c FROM documents WHERE collection='seen-terms' GROUP BY 1`,
  );
  const counts: Record<string, number> = { all: 0, question: 0, comparison: 0, informational: 0, commercial: 0 };
  for (const row of rows) {
    counts.all += Number(row.c);
    const key = String(row.intent || "");
    if (key in counts) counts[key] = Number(row.c);
  }
  return counts;
}
