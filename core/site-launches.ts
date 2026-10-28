// 新站发现引擎（第五轮 §2，批 2a）：对标哥飞第二服务。
// 数据源：HN Algolia 按时间查 Show HN（url 字段=部署域名）+ Product Hunt RSS
//（description 里的外链=产品官网，抽不到域名的条目跳过——宁可少不可滥）。
// site-launches 集合：host 主键（同 host 不重复入库）/ 中文转译 + 核心关键词 + 六类动机判定
//（LLM cheap 档批量，判定来源标注 作者原话/推测）/ 撞词标记（核心词 ∩ seen-terms 高分词，
// 竞品早期形态信号）/ 与 site-discoveries 交叉标注。
// tick 每日一道闸，fire-and-forget；抓取/分类失败静默入台账，次日重试。
import { XMLParser } from "fast-xml-parser";
import type { Store } from "./store";
import { tickGuard, shanghaiDayOf } from "./tick-guard";
import { now } from "./store";
import { termId } from "./seen-terms";

export type LaunchMotive = "keyword" | "pain" | "others" | "hobby" | "business" | "unclear";
export const MOTIVE_LABELS: Record<LaunchMotive, string> = {
  keyword: "冲着关键词",
  pain: "解决自己痛点",
  others: "满足别人需求",
  hobby: "兴趣爱好",
  business: "商业机会",
  unclear: "没说清",
};
export const MOTIVE_SOURCE_LABELS: Record<string, string> = { quote: "作者原话", guess: "推测" };

export type SiteLaunch = {
  id: string; // host；PH 条目 = producthunt.com/posts/<slug> 去重标识（PH RSS 无官网域名，不强求）
  host: string;
  source: "showhn" | "producthunt-rss";
  sourceUrl: string;
  siteUrl?: string; // PH 条目偶有 description 外链官网（抽到就存，不强求）
  hnScore?: number;
  hnComments?: number;
  hnBy?: string;
  title: string;
  text?: string;
  titleZh?: string;
  keywords?: string[];
  motive?: LaunchMotive;
  motiveSource?: "quote" | "guess";
  motiveReason?: string;
  clashTerms?: string[];
  crossLinked?: boolean;
  firstFoundAt: string;
  judgedAt?: string;
  updatedAt: string;
};

type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full"; model?: string }) => Promise<{ text: string; usage?: unknown }>;

// Show HN 帖的 url 落在代码托管/写作平台的不算「新站」（否则集合被仓库灌满）
const NON_SITE_HOST = /^(news\.ycombinator\.com|hn\.algolia\.com|github\.com|gitlab\.com|bitbucket\.org|gist\.github\.com|medium\.com|dev\.to|substack\.com|twitter\.com|x\.com|www\.youtube\.com|youtu\.be)$/i;

function hostOf(url: string): string | undefined {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h && !NON_SITE_HOST.test(h) ? h : undefined;
  } catch { return undefined; }
}

// ---- 抓取解析 ----
export type LaunchInput = { host: string; title: string; sourceUrl: string; source: "showhn" | "producthunt-rss"; siteUrl?: string; hnScore?: number; hnComments?: number; hnBy?: string; text?: string };

export function parseShowHnPayload(json: string): LaunchInput[] {
  const data = JSON.parse(json) as { hits?: Array<Record<string, unknown>> };
  const out: LaunchInput[] = [];
  for (const hit of data.hits || []) {
    const url = typeof hit.url === "string" ? hit.url : "";
    const host = hostOf(url);
    if (!host) continue;
    out.push({
      host,
      title: String(hit.title || host).slice(0, 300),
      sourceUrl: `https://news.ycombinator.com/item?id=${String(hit.objectID || "")}`,
      source: "showhn",
      hnScore: Number(hit.points) || 0,
      hnComments: Number(hit.num_comments) || 0,
      hnBy: String(hit.author || "").slice(0, 60),
      text: String(hit.story_text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
    });
  }
  return out;
}

// PH RSS description 是转义后的 HTML：先解实体再抽外链域名
function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// PH feed（批 2b 口径调整）：实为 **Atom** 格式——link 是带属性对象（@_href），
// 必须按 rel=alternate 解析（批 2a 的 50/50 全跳过即此处形状误判）。外链官网抽到就存
//（siteUrl，PH content 里多为自家 /r/p/ 重定向链接，抽不到不强求）；
// host 用帖子真实路径去重标识（producthunt.com/products/<slug>），判定与撞词照常。
export function parseProductHuntFeed(xml: string): { items: LaunchInput[]; skipped: number } {
  const doc = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const raw = doc.rss?.channel?.item ?? doc.feed?.entry;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const items: LaunchInput[] = [];
  let skipped = 0;
  for (const item of list) {
    const title = String(item.title || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const linkRaw = item.link;
    let link = "";
    if (typeof linkRaw === "string") link = linkRaw;
    else {
      const links = Array.isArray(linkRaw) ? linkRaw : linkRaw ? [linkRaw] : [];
      const alt = links.find((l: any) => !l?.["@_rel"] || l["@_rel"] === "alternate");
      link = String(alt?.["@_href"] ?? "");
    }
    let path = "";
    try { path = new URL(link).pathname.replace(/\/+$/, "").toLowerCase(); } catch { skipped++; continue; }
    if (!title || !path || path === "") { skipped++; continue; }
    const html = decodeEntities(String(item.description ?? item["content:encoded"] ?? item.content ?? ""));
    let siteUrl: string | undefined;
    for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      const h = hostOf(m[1]);
      if (h && !/(^|\.)producthunt\.com$/i.test(h)) { siteUrl = m[1]; break; }
    }
    items.push({
      host: `producthunt.com${path}`.slice(0, 120),
      title: title.slice(0, 300),
      sourceUrl: link,
      source: "producthunt-rss",
      siteUrl,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
    });
  }
  return { items, skipped };
}

// ---- 入库（host 主键去重；firstFoundAt 只认首见）----
export function upsertSiteLaunch(db: Store, input: LaunchInput): "created" | "existed" {
  const prev = db.get<any>("site-launches", input.host);
  if (prev) {
    // HN 数据只升不降（二次抓到高分时更新），其余字段不动
    const hnScore = Math.max(prev.hnScore ?? 0, input.hnScore ?? 0);
    const hnComments = Math.max(prev.hnComments ?? 0, input.hnComments ?? 0);
    if (hnScore !== prev.hnScore || hnComments !== prev.hnComments) {
      db.put("site-launches", input.host, { ...prev, hnScore, hnComments, updatedAt: now() });
    }
    return "existed";
  }
  const doc: SiteLaunch = {
    id: input.host,
    host: input.host,
    source: input.source,
    sourceUrl: input.sourceUrl,
    siteUrl: input.siteUrl,
    hnScore: input.hnScore,
    hnComments: input.hnComments,
    hnBy: input.hnBy,
    title: input.title,
    text: input.text,
    firstFoundAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.put("site-launches", input.host, doc);
  return "created";
}

// ---- LLM 批量分类（cheap 档，每批 20 条；失败静默，未判定条目次日重试）----
const CLASSIFY_BATCH = 20;

export const CLASSIFY_PROMPT_HEAD =
  "你是产品分析员。以下是新发布的网站列表（标题+作者说明摘录）。对每一条输出：" +
  "titleZh（标题中文转译，≤30 字，产品名保留原文）；keywords（2-5 个核心关键词，小写，产品类别词如 [\"ai resume\",\"pdf converter\"]）；" +
  "motive（六选一：keyword=冲着关键词做SEO / pain=解决自己痛点 / others=满足别人需求 / hobby=兴趣爱好 / business=商业机会 / unclear=没说清）；" +
  "motiveSource（quote=作者原话：说明文字里有明确动机陈述 / guess=推测：仅凭标题）；reason（判定依据一句话，≤60 字，注明原文关键句）。" +
  '只输出 JSON 数组：[{"i":1,"titleZh":"…","keywords":["…"],"motive":"pain","motiveSource":"quote","reason":"…"}]，不要输出其他文字。';

function classifyPrompt(batch: Array<Record<string, any>>): string {
  return CLASSIFY_PROMPT_HEAD + "\n\n" + batch.map((l, i) => {
    const meta = [`Score ${l.hnScore ?? "-"}`, `${l.hnComments ?? "-"} comments`].join(" | ");
    return `${i + 1}. Title: ${l.title}\n   ${meta}${l.text ? `\n   Text: ${l.text.slice(0, 300)}` : ""}`;
  }).join("\n");
}

const MOTIVE_SET = new Set(["keyword", "pain", "others", "hobby", "business", "unclear"]);

export async function classifyLaunches(db: Store, runModel: ModelRunner, outer: AbortSignal): Promise<{ classified: number; failedBatches: number }> {
  const pending = db.list<any>("site-launches").filter((l) => !l.titleZh).slice(0, 120);
  let classified = 0, failedBatches = 0;
  for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
    const batch = pending.slice(i, i + CLASSIFY_BATCH);
    try {
      const result = await runModel(db, [{ role: "user", content: classifyPrompt(batch) }], { signal: AbortSignal.any([outer, AbortSignal.timeout(240000)]), plan: "cheap" });
      const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
      if (!Array.isArray(parsed)) throw new Error("模型输出不是 JSON 数组");
      for (const item of parsed) {
        const idx = Number(item?.i);
        if (!Number.isInteger(idx) || idx < 1 || idx > batch.length) continue;
        const launch = batch[idx - 1];
        const prev = db.get<any>("site-launches", launch.host);
        if (!prev || prev.titleZh) continue;
        const motive = String(item.motive || "");
        const motiveSource = String(item.motiveSource || "");
        const keywords = Array.isArray(item.keywords)
          ? item.keywords.map((k: unknown) => String(k || "").toLowerCase().trim()).filter(Boolean).slice(0, 5)
          : [];
        db.put("site-launches", launch.host, {
          ...prev,
          titleZh: String(item.titleZh || "").slice(0, 60) || prev.title,
          keywords,
          motive: MOTIVE_SET.has(motive) ? motive as LaunchMotive : "unclear",
          motiveSource: motiveSource === "quote" ? "quote" : "guess",
          motiveReason: String(item.reason || "").slice(0, 120),
          judgedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        classified++;
      }
    } catch (e) {
      failedBatches++;
      console.error(`[site-launches] 分类批次失败（${batch.length} 条保留待次日重试）:`, e instanceof Error ? e.message : e);
    }
  }
  return { classified, failedBatches };
}

// ---- 撞词标记 + 交叉标注 ----
// 高分词 = seen-terms 非 archived 且（observations≥3 或 relevance=strong）——
// strong 是 persona top 级需求词，竞品做了就是撞，不看观测次数（首批实测：
// 池子若只按 obs≥3 只有 13 个中文词，英文 strong 词全被挡在外面）。
// keyword termId 精确命中，或双向包含且短侧 ≥5 字符（防 "ai" 类前缀误撞）。
export function seenHighScoreTerms(db: Store): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of db.list<any>("seen-terms")) {
    if (t.status === "archived" || t.offTopic) continue;
    if ((t.observations ?? 0) < 3 && t.relevance !== "strong") continue;
    map.set(String(t.id), String(t.term));
  }
  return map;
}

export function clashTermsOf(keywords: string[], highScores: Map<string, string>): string[] {
  const hits = new Set<string>();
  for (const kw of keywords || []) {
    const kid = termId(kw);
    if (!kid) continue;
    if (highScores.has(kid)) { hits.add(highScores.get(kid)!); continue; }
    for (const [id, term] of highScores) {
      if (id.length >= 5 && kid.length >= 5 && (kid.includes(id) || id.includes(kid))) { hits.add(term); break; }
    }
  }
  return [...hits].slice(0, 5);
}

export function refreshLaunchAnnotations(db: Store): { clashed: number; crossLinked: number } {
  const highScores = seenHighScoreTerms(db);
  let clashed = 0, crossLinked = 0;
  for (const l of db.list<any>("site-launches")) {
    const clashTerms = clashTermsOf(l.keywords || [], highScores);
    const linked = !!db.get("site-discoveries", l.host);
    if (clashTerms.length) clashed++;
    if (linked) crossLinked++;
    const same = JSON.stringify(l.clashTerms || []) === JSON.stringify(clashTerms) && !!l.crossLinked === linked;
    if (!same) db.put("site-launches", l.host, { ...l, clashTerms, crossLinked: linked, updatedAt: now() });
  }
  return { clashed, crossLinked };
}

// ---- 每日 tick ----
const HN_SHOWHN_URL = "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=50";

async function readText(doFetch: typeof fetch, url: string, outer: AbortSignal): Promise<string> {
  const response = await doFetch(url, { signal: AbortSignal.any([outer, AbortSignal.timeout(20000)]), headers: { "User-Agent": "draftdesk-site-launches/1.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 60)}`);
  return response.text();
}

export function siteLaunchesTick(db: Store, runModel: ModelRunner, doFetch: typeof fetch = fetch, nowDate: Date = new Date()) {
  const day = shanghaiDayOf(nowDate); // R10.31：上海日
  const doneKey = "site-launches-done:" + day;
  const done = db.get<any>("meta", doneKey);
  // 手动刷新（POST /site-launches/refresh）：晚于当日完成键时越闸重跑——
  // upsert 按 host 去重天然幂等，重跑只补抓新增/补判定/重刷撞词标注。
  const manual = db.get<any>("meta", "site-launches-manual");
  const byManual = !!manual?.at && (!done || manual.at > done.at);
  if (done && !byManual) return;
  // R10.27-C#17：守卫统一（键与 TTL 保持原值）
  const guard = tickGuard(db, { key: "site-launches", lockTtlMs: 20 * 60000, day: "shanghai" });
  if (guard.locked) return;
  guard.acquire();
  void (async () => {
    try {
      const outer = AbortSignal.timeout(8 * 60000);
      let added = 0, hnFailed = "", phFailed = "", phSkipped = 0;
      try {
        for (const item of parseShowHnPayload(await readText(doFetch, HN_SHOWHN_URL, outer))) {
          if (upsertSiteLaunch(db, item) === "created") added++;
        }
      } catch (e) { hnFailed = String((e as Error)?.message || e).slice(0, 100); }
      const ph = db.get<any>("sources", "producthunt-feed");
      if (ph?.enabled !== false && ph?.url) {
        try {
          const { items, skipped } = parseProductHuntFeed(await readText(doFetch, ph.url, outer));
          for (const item of items) if (upsertSiteLaunch(db, item) === "created") added++;
          phSkipped = skipped;
        } catch (e) { phFailed = String((e as Error)?.message || e).slice(0, 100); }
      }
      const { classified, failedBatches } = await classifyLaunches(db, runModel, outer);
      const { clashed, crossLinked } = refreshLaunchAnnotations(db);
      const summary = { at: nowDate.toISOString(), added, classified, failedBatches, clashed, crossLinked, phSkipped, hnFailed, phFailed, byManual };
      db.put("meta", doneKey, summary);
      db.put("meta", "site-launches-last", summary);
      db.del("meta", "site-launches-manual");
      console.log(`[site-launches] 新站发现完成：新增 ${added}（PH 抽不到域名跳过 ${phSkipped}）/ 分类 ${classified}（失败批 ${failedBatches}）/ 撞词 ${clashed} / 交叉 ${crossLinked}${hnFailed ? ` / HN 失败:${hnFailed}` : ""}${phFailed ? ` / PH 失败:${phFailed}` : ""}`);
    } finally {
      guard.release();
    }
  })();
}
