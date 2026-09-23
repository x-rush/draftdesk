import https from "node:https";
import { resolve4 } from "node:dns/promises";
import { XMLParser } from "fast-xml-parser";
import type { EvidenceInput, Plan, Source } from "./schema";
import { AppError, now, Store } from "./store";
import { queryPlan, rankEvidence } from "./research-policy";
export function publicIp(ip: string) {
  const p = ip.split(".").map(Number);
  return (
    p.length === 4 &&
    p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    ![0, 10, 127].includes(p[0]) &&
    !(p[0] === 169 && p[1] === 254) &&
    !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && (p[1] === 168 || p[1] === 0)) &&
    !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) &&
    !(p[0] === 198 && (p[1] === 18 || p[1] === 19)) &&
    p[0] < 224
  );
}
export async function safeRead(value: string, signal?: AbortSignal) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    throw new AppError("采集地址必须是无凭据、标准端口的 HTTPS。");
  const addresses = await resolve4(u.hostname);
  if (!addresses.length || addresses.some((ip) => !publicIp(ip)))
    throw new AppError("禁止采集本机或内网地址。");
  return new Promise<string>((resolve, reject) => {
    const request = https.get(
      u,
      {
        signal,
        lookup: (_host, options, cb) => {
          if (options.all)
            cb(
              null,
              addresses.map((address) => ({ address, family: 4 })),
            );
          else cb(null, addresses[0], 4);
        },
        headers: {
          "User-Agent": "DraftDesk/2.0 evidence-workbench",
          Accept:
            "application/rss+xml, application/atom+xml, application/json, text/html;q=0.8",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new AppError(`来源返回 HTTP ${res.statusCode}，未跟随跳转。`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) {
            request.destroy(new AppError("来源正文超过 2 MB。"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new AppError("来源请求超时（20 秒）。")),
      20000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}
const array = (v: any): any[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const plain = (v: any) =>
  String(v?.["#text"] ?? v ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function parseFeed(xml: string, s: Source): EvidenceInput[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new AppError("不接受包含外部实体的 Feed。");
  const doc = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  return array(doc.rss?.channel?.item ?? doc.feed?.entry)
    .slice(0, 100)
    .flatMap((item) => {
      const link =
        typeof item.link === "string"
          ? item.link
          : array(item.link).find(
              (l) => !l["@_rel"] || l["@_rel"] === "alternate",
            )?.["@_href"];
      try {
        const url = new URL(link);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return [];
        const date = plain(item.pubDate ?? item.published ?? item.updated);
        return [
          {
            title: plain(item.title).slice(0, 300) || "无标题",
            url: url.href,
            excerpt: plain(
              item["content:encoded"] ?? item.content ?? item.description ?? item.summary,
            ).slice(0, 8000),
            publishedAt: Number.isFinite(Date.parse(date))
              ? new Date(date).toISOString()
              : undefined,
            collectedAt: now(),
            sourceType: s.sourceType,
            region: s.region || "未知",
            language: "未知",
            contentLevel: "excerpt" as const,
            ...(item["ht:approx_traffic"]
              ? {
                  metric: {
                    name: "Google Trends 热榜搜索量分桶",
                    value: plain(item["ht:approx_traffic"]),
                    unit: "原始分桶文本",
                    period: date || "来源未说明",
                  },
                }
              : {}),
          },
        ];
      } catch {
        return [];
      }
    });
}
export function relevant(e: EvidenceInput, p: Plan) {
  const corpus = (e.title + " " + e.excerpt).toLowerCase();
  if (p.focusTerms?.length && !p.focusTerms.some(term => {
    const needle = term.toLowerCase();
    if (/^[a-z0-9 ]+$/i.test(needle)) return new RegExp(`\\b${needle}\\b`, "i").test(corpus);
    return corpus.includes(needle);
  })) return false;
  if (p.excludeKeywords.some((k) => corpus.includes(k.toLowerCase())))
    return false;
  if (
    e.publishedAt &&
    (Date.parse(e.publishedAt) < Date.now() - p.lookbackDays * 86400000 ||
      Date.parse(e.publishedAt) > Date.now() + 86400000)
  )
    return false;
  const host = new URL(e.url).hostname;
  if (
    p.includeDomains.length &&
    !p.includeDomains.some((d) => host === d || host.endsWith("." + d))
  )
    return false;
  if (
    e.sourceType === "trend" &&
    p.keywords.length &&
    !p.keywords.some((k) => corpus.includes(k.toLowerCase()))
  )
    return false;
  return true;
}
export function balancedEvidence(groups:EvidenceInput[][],limit:number){
 const result:EvidenceInput[]=[],seen=new Set<string>();
 for(let index=0;index<Math.max(0,...groups.map(g=>g.length));index++)for(const group of groups){const e=group[index];if(e&&!seen.has(e.url)){seen.add(e.url);result.push(e);if(result.length===limit)return result;}}
 return result;
}
export function webSourceType(value:string,fallback:Source['sourceType'],officialHosts: string[] = []):Source['sourceType']{
 try{const u=new URL(value);if(['reddit.com','zhihu.com','v2ex.com','jikeapp.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d))||(u.hostname==='github.com'&&u.pathname.includes('/issues/')))return 'community';if(u.hostname==='producthunt.com'||u.hostname.endsWith('.producthunt.com'))return 'product';}catch{}
 try { if(officialHosts.includes(new URL(value).hostname)) return 'official'; } catch {}
 // A web source setting is a query preference, not proof that every result is official.
 return fallback === 'official' ? 'other' : fallback;
}
export async function searchWeb(db: Store, plan: Plan, query: string, signal: AbortSignal, fallback: Source['sourceType'] = "other"): Promise<EvidenceInput[]> {
  const key = db.config().tavilyKey;
  if (!key) throw new AppError("未配置 Tavily Key。");
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    headers: {"content-type":"application/json", Authorization: `Bearer ${key}`},
    body: JSON.stringify({query, search_depth:"basic", max_results:6, include_domains:plan.includeDomains,
      start_date: new Date(Date.now()-plan.lookbackDays*86400000).toISOString().slice(0,10), include_published_date:true, topic:"general"}),
  });
  if (!response.ok) throw new AppError(`搜索服务 HTTP ${response.status}`);
  const result = await response.json();
  const officialHosts = db.list<Source>("sources").filter(s=>s.enabled && s.type==="rss" && s.sourceType==="official" && s.url)
    .flatMap(s=>[new URL(s.url!).hostname,...(s.officialDomains || []).map(d=>d.toLowerCase())]);
  return (result.results || []).flatMap((r: any): EvidenceInput[] => {
    try {
      const parsed = new URL(r.url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return [];
      const entry: EvidenceInput = {title:String(r.title).slice(0,300),url:r.url,excerpt:String(r.content || "").slice(0,8000),collectedAt:now(),
        sourceType:webSourceType(r.url, fallback, officialHosts), region:"未知", language:"未知",contentLevel:"excerpt",
        ...(Number.isFinite(Date.parse(r.published_date)) ? {publishedAt:new Date(r.published_date).toISOString()} : {})};
      return relevant(entry,plan) ? [entry] : [];
    } catch { return []; }
  });
}
export async function collect(
  db: Store,
  plan: Plan,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  onSearch: () => void = () => {},
) {
  const sources = plan.sourceIds
    .map((id) => db.get<Source>("sources", id))
    .filter((s): s is Source => !!s && s.enabled);
  const groups: EvidenceInput[][] = [];
  const warnings: string[] = [];
  let searches = 0;
  for (const s of sources) {
    signal.throwIfAborted();
    onProgress(`读取 ${s.name}`);
    try {
      let items: EvidenceInput[] = [];
      if (s.type === "rss" || s.type === "trends") {
        const address =
          s.type === "trends"
            ? `https://trends.google.com/trending/rss?geo=${s.region || "US"}`
            : s.url;
        if (!address) throw new AppError("缺少来源地址。");
        items = parseFeed(await safeRead(address, signal), s);
      } else if (s.type === "github") {
        const q =
          (s.query || "topic:ai") +
          ` pushed:>=${new Date(Date.now() - plan.lookbackDays * 86400000).toISOString().slice(0, 10)}`;
        const result = JSON.parse(
          await safeRead(
            "https://api.github.com/search/repositories?" +
              new URLSearchParams({
                q,
                sort: "updated",
                order: "desc",
                per_page: "10",
              }),
            signal,
          ),
        );
        items = (result.items || [])
          .slice(0, 10)
          .map((r: any) => ({
            title: String(r.full_name).slice(0, 300),
            url: r.html_url,
            excerpt: String(r.description || "未提供说明").slice(0, 5000),
            collectedAt: now(),
            sourceType: "repository",
            region: "全球",
            language: r.language || "未知",
            contentLevel: "excerpt",
            metric: {
              name: "GitHub Stars 累计值",
              value: String(r.stargazers_count),
              unit: "stars",
              period: now(),
              cadence: "instant",
            },
          }));
      } else {
        const key = db.config().tavilyKey;
        if (!key) throw new AppError("未配置 Tavily Key。");
        // Reserve up to two queries from the original budget for targeted verification.
        const initialLimit = Math.max(1, plan.maxQueries - Math.min(2, Math.floor(plan.maxQueries / 2)));
        for (const item of queryPlan(plan, Math.max(0, Math.min(initialLimit - searches, plan.maxQueries - searches)))) {
          signal.throwIfAborted();
          searches++;
          onSearch();
          onProgress(`专项搜索：${item.purpose} · ${item.query}`);
          items.push(...await searchWeb(db, plan, item.query, signal, s.sourceType));
        }
      }
      const filtered = items.filter((e) => relevant(e, plan));
      groups.push(rankEvidence(filtered, plan));
      onProgress(`${s.name}：${items.length} 条原始线索，${filtered.length} 条符合内容、时间与域名范围`);
    } catch (e) {
      if (signal.aborted) throw e;
      warnings.push(
        `${s.name}：${e instanceof AppError ? e.message : "读取失败，请检查来源或网络。"}`,
      );
    }
  }
  const reserveEvidence = plan.maxQueries > searches && sources.some(s=>s.type==="web") ? Math.min(4,Math.max(0,plan.maxEvidence-3)) : 0;
  const unique = balancedEvidence(groups,plan.maxEvidence-reserveEvidence);
  const evidence = unique.map((e) =>
    db.addEvidence(e, "builtin-collector/1.0.0"),
  );
  return { evidence, warnings, searches };
}
