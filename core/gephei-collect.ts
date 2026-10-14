// 哥飞挖需求采集组（第七轮批3 W7-9，采集=内置 tick，token 唯一出口，collect 池记账）：
// · 第十一步（每周日）趋势周更：trends_rising 按 44 词根族轮转 → 过滤（英文/非品牌/长度）
//   → 注入 seen-terms（source=gephei-trends, status=new, seed=词根）
// · 第十二步（每月 1 日）标杆站页面分析：site_keywords 采标杆站关键词排名页面落
//   benchmark-pages（外部 Agent 读库挑高流量页需求词注入词库候选）
// · 第十三步（每月 15 日）外链反推：find_link_prospects 按高分词查竞品外链来源站落
//   link-prospects（外部 Agent 分析注册时间+流量识别隐秘赚钱产品）
// · 第十四步（每周日随十一步）探针根词周期复验：7/30 天无新词产出的根词降频
//   （写 root-probe-slowdown 名单，nextRootBatch 轮转剔除；名单 30 天后重新评估）
// 全部日/周/月闸幂等；collect 池预算尽自动停；开关关闭=零调用。
import type { Store } from "./store";
import { termId, observeSuggestion } from "./seen-terms";
import { seoSourceEnabled, seoBudgetLeft, seoSpend, seoApi } from "./seo-source";
import { TOOL_ROOTS, AI_ROOTS, rootYieldStats } from "./seen-dig";
import { now } from "./store";

const DAY_MS = 86400000;

// ---- 标杆站清单（W7-10 新增5 的数据底座；站点发现页可增删）----
export const BENCHMARK_SEEDS = [
  { host: "gumroad.com", name: "Gumroad" },
  { host: "character.ai", name: "Character.AI" },
  { host: "tools.picsart.com", name: "Picsart Tools" },
  { host: "tinywow.com", name: "TinyWow" },
  { host: "remove.bg", name: "Remove.bg" },
];

export function ensureBenchmarkSeeds(db: Store): void {
  if (db.get("meta", "benchmark-seeds-done")) return;
  const stamp = now();
  for (const s of BENCHMARK_SEEDS) {
    if (db.get<any>("benchmark-sites", s.host)) continue;
    db.put("benchmark-sites", s.host, { id: s.host, host: s.host, name: s.name, addedAt: stamp, lastAnalyzedAt: undefined, pagesCount: 0, newTermsCount: 0, producedBy: "seed" });
  }
  db.put("meta", "benchmark-seeds-done", { at: stamp });
}

// ---- 趋势上升词过滤（英文/非品牌/长度 3-40）----
const BRANDISH = /openai|anthropic|claude|gemini|midjourney|perplexity|google|microsoft|github|amazon|netlify|facebook|apple|nvidia|notion|slack|zoom|figma|spotify|youtube|tesla|chatgpt|bytedance|baidu|alibaba|tencent/i;
const ENGLISHISH = /^[a-z0-9][a-z0-9 '+.&-]{2,39}$/i;

export function filterTrendWord(word: string): string | undefined {
  const t = String(word || "").trim();
  if (!ENGLISHISH.test(t)) return undefined;
  if (BRANDISH.test(t)) return undefined;
  return t.toLowerCase();
}

// 趋势上升解析（防御式：items/keywords/data 数组，词字段 keyword/term/query/title）
function parseTrendWords(raw: unknown): string[] {
  let list: any[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") list = (raw as any).items ?? (raw as any).keywords ?? (raw as any).data ?? [];
  const out: string[] = [];
  for (const item of list) {
    const w = typeof item === "string" ? item : item?.keyword ?? item?.term ?? item?.query ?? item?.title;
    if (typeof w === "string") out.push(w);
  }
  return out;
}

function sundayOf(day: Date): string {
  const d = new Date(day.getTime());
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
function monthOf(day: Date): string {
  return day.toISOString().slice(0, 7);
}
function halfMonthOf(day: Date): string {
  return `${day.toISOString().slice(0, 7)}-${day.getUTCDate() <= 15 ? "a" : "b"}`;
}

// ---- 第十一步（每周日）趋势周更 + 第十四步根词降频 ----
const TRENDS_ROOTS_PER_RUN = 10;
const ROOT_SLOWDOWN_TTL_DAYS = 30;

export function rootSlowdownOf(db: Store): Set<string> {
  const rec = db.get<any>("meta", "root-probe-slowdown");
  if (!rec?.roots?.length) return new Set();
  if (rec.at && Date.now() - Date.parse(rec.at) > ROOT_SLOWDOWN_TTL_DAYS * DAY_MS) return new Set();
  return new Set(rec.roots.map(String));
}

// 第十四步：7 天零产出且 30 天产出 ≤1 的根词进降频名单（哥飞找词八式之根词管理）
export function rootSlowdownReview(db: Store, nowDate: Date = new Date()): { slowed: string[]; checked: number } {
  const week = rootYieldStats(db, 7, nowDate);
  const month = rootYieldStats(db, 30, nowDate);
  const all = [...TOOL_ROOTS, ...AI_ROOTS];
  const slowed = all.filter((r) => !(week.get(r) || 0) && (month.get(r) || 0) <= 1);
  db.put("meta", "root-probe-slowdown", { roots: slowed, at: nowDate.toISOString() });
  return { slowed, checked: all.length };
}

export function trendsRisingTick(db: Store, doFetch: typeof fetch = fetch, nowDate: Date = new Date()): void {
  if (nowDate.getUTCDay() !== 0) return; // 每周日
  const week = sundayOf(nowDate);
  if (db.get("meta", "geo-trends-done:" + week)) return;
  if (!seoSourceEnabled(db)) return;
  if (seoBudgetLeft(db, "collect") <= 0) return;
  const running = db.get<any>("meta", "geo-trends-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "geo-trends-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      // 轮转：geo-trends-cursor 与 root-probe-cursor 同款语义；慢根名单同享（第十四步降频）
      const slowdown = rootSlowdownOf(db);
      const cursor = db.get<any>("meta", "geo-trends-cursor");
      const done = new Set(Array.isArray(cursor?.roots) ? cursor.roots.map(String) : []);
      const all = [...TOOL_ROOTS, ...AI_ROOTS].filter((r) => !slowdown.has(r));
      const pending = all.filter((r) => !done.has(r));
      const batch = (pending.length ? pending : all).slice(0, TRENDS_ROOTS_PER_RUN);
      let injected = 0, skipped = 0, failed = 0;
      for (const root of batch) {
        if (seoBudgetLeft(db, "collect") <= 0) break;
        try {
          const raw = await seoApi.trendsRising(db, root, doFetch);
          seoSpend(db, "collect", 1);
          for (const word of parseTrendWords(raw)) {
            const clean = filterTrendWord(word);
            if (!clean) { skipped++; continue; }
            observeSuggestion(db, clean, root, { source: "gephei-trends" });
            injected++;
          }
        } catch { failed++; }
      }
      db.put("meta", "geo-trends-cursor", { roots: [...done, ...batch], updatedAt: new Date().toISOString() });
      db.put("meta", "geo-trends-done:" + week, { at: new Date().toISOString(), roots: batch.length, injected, skipped, failed });
      // 第十四步随十一步
      const slow = rootSlowdownReview(db, nowDate);
      console.log(`[geo-collect] 趋势周更：词根 ${batch.length}（失败 ${failed}）/ 注入 ${injected} 词 / 过滤 ${skipped}；根词降频 ${slow.slowed.length}/${slow.checked}`);
    } catch (e) {
      console.error("[geo-collect] 趋势周更失败（下周重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-trends-done:" + week, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "geo-trends-running");
    }
  })();
}

// ---- 第十二步（每月 1 日）标杆站页面分析 ----
export function benchmarkSitesTick(db: Store, doFetch: typeof fetch = fetch, nowDate: Date = new Date()): void {
  const month = monthOf(nowDate);
  if (db.get("meta", "geo-benchmark-done:" + month)) return;
  if (!seoSourceEnabled(db)) return;
  if (seoBudgetLeft(db, "collect") <= 0) return;
  const running = db.get<any>("meta", "geo-benchmark-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "geo-benchmark-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      ensureBenchmarkSeeds(db);
      let analyzed = 0, pages = 0, failed = 0;
      for (const site of db.list<any>("benchmark-sites")) {
        if (seoBudgetLeft(db, "collect") <= 0) break;
        try {
          const raw = await seoApi.siteKeywords(db, site.host, doFetch);
          seoSpend(db, "collect", 1);
          const list: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.keywords ?? [];
          let count = 0;
          for (const item of list.slice(0, 50)) {
            const keyword = String(item?.keyword ?? item?.term ?? "").trim().slice(0, 80);
            const url = typeof item?.url === "string" ? item.url.slice(0, 300) : undefined;
            if (!keyword && !url) continue;
            const id = `${site.host}:${termId(keyword || url)}`.slice(0, 200);
            const prev = db.get<any>("benchmark-pages", id);
            db.put("benchmark-pages", id, {
              id, host: site.host, keyword, url,
              position: typeof item?.position === "number" ? item.position : undefined,
              traffic: typeof item?.traffic === "number" ? item.traffic : typeof item?.visits === "number" ? item.visits : undefined,
              volume: typeof item?.volume === "number" ? item.volume : undefined,
              firstSeenAt: prev?.firstSeenAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            count++;
          }
          db.put("benchmark-sites", site.host, { ...site, lastAnalyzedAt: new Date().toISOString(), pagesCount: (site.pagesCount || 0) + count, analyzedRuns: (site.analyzedRuns || 0) + 1 });
          pages += count;
          analyzed++;
        } catch { failed++; }
      }
      db.put("meta", "geo-benchmark-done:" + month, { at: new Date().toISOString(), analyzed, pages, failed });
      if (analyzed) console.log(`[geo-collect] 标杆站月更：分析 ${analyzed} 站（失败 ${failed}）/ 页面数据 ${pages} 条`);
    } catch (e) {
      console.error("[geo-collect] 标杆站月更失败（下月重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-benchmark-done:" + month, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "geo-benchmark-running");
    }
  })();
}

// ---- 第十三步（每月 15 日）外链反推 ----
export function linkProspectsTick(db: Store, doFetch: typeof fetch = fetch, nowDate: Date = new Date()): void {
  const half = halfMonthOf(nowDate);
  if (db.get("meta", "geo-links-done:" + half)) return;
  if (!seoSourceEnabled(db)) return;
  if (seoBudgetLeft(db, "collect") <= 0) return;
  const running = db.get<any>("meta", "geo-links-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "geo-links-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      // 查询词=观测最高的 strong 蓝海词（sd 已查且低竞争）top 3——竞品外链并集法的词面入口
      const seeds = db.list<any>("seen-terms")
        .filter((t) => t.status !== "archived" && t.relevance === "strong" && (t.region ?? "global") === "global" && typeof t.serpDedicated === "number" && t.serpDedicated <= 1)
        .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0))
        .slice(0, 3);
      let injected = 0, failed = 0;
      for (const t of seeds) {
        if (seoBudgetLeft(db, "collect") <= 0) break;
        try {
          const raw = await seoApi.findLinkProspects(db, String(t.term), doFetch);
          seoSpend(db, "collect", 1);
          const list: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.prospects ?? [];
          for (const item of list.slice(0, 30)) {
            const host = String(item?.domain ?? item?.host ?? "").toLowerCase().replace(/^www\./, "").slice(0, 120);
            if (!host || !host.includes(".")) continue;
            const prev = db.get<any>("link-prospects", host);
            if (prev) continue;
            db.put("link-prospects", host, {
              id: host, host,
              fromTerm: String(t.term).slice(0, 80),
              dr: typeof item?.dr === "number" ? item.dr : typeof item?.domain_rating === "number" ? item.domain_rating : undefined,
              traffic: typeof item?.traffic === "number" ? item.traffic : undefined,
              firstSeenAt: new Date().toISOString(),
            });
            injected++;
          }
        } catch { failed++; }
      }
      db.put("meta", "geo-links-done:" + half, { at: new Date().toISOString(), seeds: seeds.length, injected, failed });
      if (seeds.length) console.log(`[geo-collect] 外链反推：查询 ${seeds.length} 词（失败 ${failed}）/ 新来源站 ${injected}`);
    } catch (e) {
      console.error("[geo-collect] 外链反推失败（下半月重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-links-done:" + half, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "geo-links-running");
    }
  })();
}
