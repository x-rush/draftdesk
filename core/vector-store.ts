import { shanghaiDayOf } from "./tick-guard";
// R10.24-5（R10.23）Redis 向量事件线：组摘要（idx:eventline）+ 增量词（idx:termcluster）。
// 嵌入走百炼 compatible-mode /embeddings（text-embedding-v3，1024 维，与主模型同一把 Key）。
// 全链容错：REDIS_URL 未配置（fresh clone/测试）、Redis 不可达、RediSearch 不可用或嵌入
// 失败时一律降级为 no-op 并返回 null——向量线永不阻断采集/写回主链（每进程只记一次降级日志）。
// 语义去重窗口：跨日 [now-48h, 今日零点)，刻意排除当日向量——当日大纲本就派生自当日组，
// 不排除会把每条大纲都误杀在自己的组摘要上。

export const VECTOR_DIMS = 1024;
export const EMBED_MODEL = "text-embedding-v3";
export const DUPLICATE_SIMILARITY = 0.92;
const EMBED_BATCH = 10;

type VectorHit = {
  key: string;
  title: string;
  jobId: string;
  attention: string;
  date: number;
  similarity: number;
};

type RedisLike = { call: (...args: Array<string | Buffer | number>) => Promise<unknown> };
type VectorState = { client: RedisLike | null; resolved: boolean; degraded: boolean; failedAt: number };

const g = globalThis as unknown as { __draftdeskVectors?: VectorState };
function state(): VectorState {
  return (g.__draftdeskVectors ||= { client: null, resolved: false, degraded: false, failedAt: 0 });
}
function logOnce(msg: string) {
  if (state().degraded) return;
  state().degraded = true;
  console.warn(`[vectors] ${msg}（本次进程内向量线停用，主链不受影响）`);
}

async function getClient(): Promise<RedisLike | null> {
  if (!process.env.REDIS_URL) return null;
  const s = state();
  // R10.27-F5：连接失败负缓存 10 分钟（原 resolved:true 永不重试直至进程重启——
  // Redis 短暂重启后整进程向量线瘫痪）；成功即恢复正常路径
  if (s.client) return s.client;
  if (s.resolved && Date.now() - (s.failedAt || 0) < 10 * 60000) return null;
  s.resolved = true;
  try {
    const { default: Redis } = await import("ioredis");
    const c = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 500, 2000)),
    });
    c.on("error", () => {}); // 断连事件走命令级降级，不允许未处理 error 事件炸进程
    await c.connect();
    s.client = c as RedisLike;
    s.failedAt = 0;
    return s.client;
  } catch (e) {
    s.failedAt = Date.now();
    logOnce(`Redis 连接失败：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// —— 嵌入（百炼 compatible-mode；失败抛给调用方降级，用量记 meta 供日报引用） ——

const g2 = globalThis as unknown as { __ddEmbedFailAt?: number };
// R10.27-F15：嵌入失败负缓存 10 分钟——API 降质时每条大纲固定 +30s 超时且互相拖垮限流；
// 窗口内语义查重直接降级跳过（写入照常，大纲打 semanticDedupSkipped 标记）
function embedBlocked(): boolean {
  return !!g2.__ddEmbedFailAt && Date.now() - g2.__ddEmbedFailAt < 10 * 60000;
}

export async function embedTexts(db: import("./store").Store, texts: string[]): Promise<Float32Array[]> {
  const cfg = db.config();
  if (!cfg.apiKey || !cfg.baseUrl) throw new Error("未配置模型 Key，无法嵌入");
  const out: Float32Array[] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const chunk = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: chunk, dimensions: VECTOR_DIMS, encoding_format: "float" }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const data = await res.json();
    tokens += Number(data?.usage?.total_tokens || 0);
    for (const item of data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index))
      out.push(Float32Array.from(item.embedding));
  }
  const day = shanghaiDayOf(); // R10.31：上海日（日报「今日用量」口径）
  const prev = db.get<{ calls: number; texts: number; tokens: number }>("meta", "vector-embed:" + day);
  db.put("meta", "vector-embed:" + day, {
    calls: (prev?.calls || 0) + Math.ceil(texts.length / EMBED_BATCH),
    texts: (prev?.texts || 0) + texts.length,
    tokens: (prev?.tokens || 0) + tokens,
  });
  return out;
}

function vecBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

async function ensureIndex(c: { call: Function }, name: string, prefix: string, extra: string[]) {
  try {
    await c.call(
      "FT.CREATE", name, "ON", "hash", "PREFIX", "1", prefix,
      "SCHEMA", "vec", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", String(VECTOR_DIMS), "DISTANCE_METRIC", "COSINE",
      ...extra,
    );
  } catch (e) {
    const msg = String(e instanceof Error ? (e as Error).message : e);
    if (!/already exists/i.test(msg)) throw new Error(`FT.CREATE ${name}: ${msg}`);
  }
}

async function hsetVector(
  c: { call: Function }, index: string, prefix: string, key: string, vec: Float32Array,
  fields: Array<[string, string | number]>, extraSchema: string[],
) {
  await ensureIndex(c, index, prefix, extraSchema);
  const args: Array<string | Buffer> = [prefix + key, "vec", vecBlob(vec)];
  for (const [k, v] of fields) args.push(k, String(v));
  await c.call("HSET", ...args);
}

type SearchOptions = { topK?: number; sinceTs?: number; untilTs?: number };

async function searchIndex(
  c: { call: Function }, index: string, vec: Float32Array, opts: SearchOptions,
): Promise<VectorHit[]> {
  const topK = Math.min(20, Math.max(1, opts.topK || 5));
  const range = opts.sinceTs !== undefined || opts.untilTs !== undefined
    ? `(@date:[${opts.sinceTs ?? 0} ${opts.untilTs ?? "+inf"}])`
    : "*";
  const query = `${range}=>[KNN ${topK} @vec $q AS score]`;
  const raw = await c.call(
    "FT.SEARCH", index, query,
    "RETURN", "6", "title", "jobId", "attention", "date", "term", "score",
    "LIMIT", "0", String(topK),
    "PARAMS", "2", "q", vecBlob(vec),
    "DIALECT", "2",
  );
  // FT.SEARCH 原始回复为扁平交替：[total, key, [f, v, f, v, ...], key, [f, v, ...], ...]
  //（无客户端规范化包装——ioredis 实测，2026-10-23 首日实弹修正）
  const rows = Array.isArray(raw) ? raw : [];
  const hits: VectorHit[] = [];
  for (let i = 1; i + 1 < rows.length; i += 2) {
    const flat = rows[i + 1];
    if (!Array.isArray(flat)) continue;
    const f: Record<string, string> = {};
    for (let j = 0; j + 1 < flat.length; j += 2) f[String(flat[j])] = String(flat[j + 1]);
    hits.push({
      key: String(rows[i]),
      title: f.title || f.term || "",
      jobId: f.jobId || "",
      attention: f.attention || "",
      date: Number(f.date || 0),
      similarity: 1 - Number(f.score || 1),
    });
  }
  return hits;
}

// —— 对外：写入（fire-and-forget 调用，失败只降级） ——

// R10.26-4③：嵌入输入与查询侧同构——标题+首句（reason/appGap 的首个分句），
// 富文本拼接会稀释余弦相似度使 0.92 阈值几乎不可达（真重复漏杀）
function eventEmbedText(gr: { title: string; reason?: string; appGap?: string }): string {
  const firstSentence = (s?: string) => (s ? String(s).split(/[。.!?！？\n]/)[0] : "");
  return [gr.title, firstSentence(gr.reason), firstSentence(gr.appGap)].filter(Boolean).join("。").slice(0, 300);
}

// R10.26-4③：同 jobId 旧向量清理（整卡重写后旧组向量残留→次日误杀新大纲）+
// 顺带清 7 天前过期向量（>48h 去重窗口，安全余量；防键空间无限增长）
async function pruneEventVectors(c: RedisLike, jobId?: string): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  let cursor = "0";
  do {
    const next = (await c.call("SCAN", cursor, "MATCH", "dd:v:eventline:*", "COUNT", "200")) as unknown as [string, string[]];
    if (!Array.isArray(next)) break;
    cursor = next[0];
    const keys = next[1] || [];
    for (const key of keys) {
      if (jobId && key.startsWith("dd:v:eventline:" + jobId + ":")) { await c.call("DEL", key); continue; }
      const fields = (await c.call("HMGET", key, "date")) as unknown as string[];
      if (fields && Number(fields[0]) && Number(fields[0]) < cutoff) await c.call("DEL", key);
    }
  } while (cursor !== "0");
}

export async function indexEventGroups(
  db: import("./store").Store,
  jobId: string,
  groups: Array<{ id: string; title: string; attention?: string; reason?: string; appGap?: string; angles?: Array<{ platform: string; angle: string }> }>,
): Promise<void> {
  const c = await getClient();
  if (!c || !groups.length) return;
  try {
    const texts = groups.map(eventEmbedText);
    const vecs = await embedTexts(db, texts);
    const nowSec = Math.floor(Date.now() / 1000);
    // R10.29-1 P0：prune 必须在 HSET 之前——写在循环后会删光本批刚写入的键
    //（R10.26-4③ 引入的回归：AOF 铁证 10-27 批 HSET×38→紧随 DEL×38，eventline 自 10-26 起零新键，
    // 语义去重失效/白烧嵌入）。执行序：清同 jobId 旧键+过期键 → 写入本批 → 计数真实。
    await pruneEventVectors(c, jobId);
    let indexed = 0;
    for (let i = 0; i < groups.length; i++) {
      await hsetVector(c, "idx:eventline", "dd:v:eventline:", `${jobId}:${groups[i].id}`, vecs[i], [
        ["title", groups[i].title.slice(0, 300)],
        ["jobId", jobId],
        ["attention", groups[i].attention || ""],
        ["date", nowSec],
      ], ["title", "TEXT", "jobId", "TAG", "attention", "TAG", "date", "NUMERIC"]);
      indexed++;
    }
    // R10.27-A#3：完整性标记——prune 已前置、HSET 全成功后写，indexed 计数真实
    db.put("meta", "vector-index:" + jobId, { at: new Date().toISOString(), expected: groups.length, indexed });
  } catch (e) {
    db.put("meta", "vector-index:" + jobId, { at: new Date().toISOString(), expected: groups.length, indexed: 0, error: String(e instanceof Error ? e.message : e).slice(0, 160) });
    logOnce(`组摘要索引失败：${e instanceof Error ? e.message : e}`);
  }
}

// R10.27-A#3：对账读口——批次向量的期望/实写状态（供外部 Agent 每日校验与补跑决策）
export function vectorIndexStatus(db: import("./store").Store, jobId: string): { expected: number; indexed: number; error?: string; at?: string } | null {
  const mark = db.get<any>("meta", "vector-index:" + jobId);
  if (!mark) return null;
  return { expected: mark.expected, indexed: mark.indexed, ...(mark.error ? { error: mark.error } : {}), ...(mark.at ? { at: mark.at } : {}) };
}

export async function indexTermCluster(db: import("./store").Store, words: string[]): Promise<void> {
  const c = await getClient();
  const clean = [...new Set(words.filter(Boolean))].slice(0, 200);
  if (!c || !clean.length) return;
  try {
    const vecs = await embedTexts(db, clean);
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < clean.length; i++) {
      await hsetVector(c, "idx:termcluster", "dd:v:termcluster:", Buffer.from(clean[i]).toString("hex"), vecs[i], [
        ["term", clean[i].slice(0, 120)],
        ["date", nowSec],
      ], ["term", "TEXT", "date", "NUMERIC"]);
    }
  } catch (e) {
    logOnce(`词簇索引失败：${e instanceof Error ? e.message : e}`);
  }
}

// —— 对外：检索（Agent 端点 + 大纲语义去重共用） ——

export async function searchVectors(
  db: import("./store").Store,
  index: "eventline" | "termcluster",
  text: string,
  opts: SearchOptions = {},
): Promise<VectorHit[] | null> {
  const c = await getClient();
  if (!c || !text.trim() || embedBlocked()) return null;
  try {
    // R10.27-A#2：查询嵌入与索引侧同构（同为 300 字裁剪口径，缓解富文本稀释）
    const [vec] = await embedTexts(db, [text.slice(0, 300)]);
    if (!vec) return null;
    const name = index === "eventline" ? "idx:eventline" : "idx:termcluster";
    return await searchIndex(c, name, vec, opts);
  } catch (e) {
    g2.__ddEmbedFailAt = Date.now(); // R10.27-F15：失败即开 10 分钟负缓存
    logOnce(`向量检索失败：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// R10.23-3：跨日语义去重——与前 48h（截至今日零点、不含当日）组摘要相似度 >0.92 视为重复事件。
// 返回 null = 无重复；{degraded:true} = 向量线不可用（调用方写入时打标记，R10.27-F）。
export async function findSemanticDuplicate(
  db: import("./store").Store,
  title: string,
): Promise<{ matchedEvent: VectorHit; score: number } | { degraded: true } | null> {
  const c = await getClient();
  if (!c || embedBlocked()) return { degraded: true };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const startToday = Math.floor(Date.parse(day + "T00:00:00+08:00") / 1000);
  const hits = await searchVectors(db, "eventline", title, { topK: 1, sinceTs: startToday - 48 * 3600, untilTs: startToday - 1 });
  if (hits === null) return { degraded: true };
  if (!hits.length) return null;
  const best = hits[0];
  return best.similarity > DUPLICATE_SIMILARITY
    ? { matchedEvent: best, score: Number(best.similarity.toFixed(4)) }
    : null;
}
