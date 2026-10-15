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
import { termId, observeSuggestion, bumpSeenTermsVersion } from "./seen-terms";
import { seoSourceEnabled, seoSourceOf, seoBudgetLeft, seoSpend, seoApi, SeoQuotaError, parseManualGephei } from "./seo-source";
import { TOOL_ROOTS, AI_ROOTS, rootYieldStats } from "./seen-dig";
import { now, hash } from "./store";

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
  // R8-4④：周更→日更（缓存优先，trends_rising 缓存命中合 2 分/次，月成本约 60 分；
  // 存量周 key 自然废弃无需迁移——新日 key 直接生效）
  const dayKey = nowDate.toISOString().slice(0, 10);
  if (db.get("meta", "geo-trends-done:" + dayKey)) return;
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
      if (seoBudgetLeft(db, "collect") > 0) {
        try {
          // 官方合同：trends_rising 收词根数组（≤20）——整批一次调用（collect 池计 1 次）
          const raw = await seoApi.trendsRising(db, batch, doFetch);
          seoSpend(db, "collect", 1);
          const words = parseTrendWords(raw);
          // 词→根归属按响应顺序就近回填（roots 数组顺序即产出分组）
          const perRoot = Math.max(1, Math.ceil(words.length / batch.length));
          for (let wi = 0; wi < words.length; wi++) {
            const root = batch[Math.min(batch.length - 1, Math.floor(wi / perRoot))];
            const clean = filterTrendWord(words[wi]);
            if (!clean) { skipped++; continue; }
            observeSuggestion(db, clean, root, { source: "gephei-trends" });
            injected++;
          }
        } catch (e) {
          failed++;
          if (e instanceof Error && e.name === "SeoQuotaError") console.warn("[geo-collect] 趋势周更跳过：哥飞余额不足");
        }
      }
      db.put("meta", "geo-trends-cursor", { roots: [...done, ...batch], updatedAt: new Date().toISOString() });
      db.put("meta", "geo-trends-done:" + dayKey, { at: new Date().toISOString(), roots: batch.length, injected, skipped, failed });
      // 第十四步随十一步
      const slow = rootSlowdownReview(db, nowDate);
      console.log(`[geo-collect] 趋势周更：词根 ${batch.length}（失败 ${failed}）/ 注入 ${injected} 词 / 过滤 ${skipped}；根词降频 ${slow.slowed.length}/${slow.checked}`);
    } catch (e) {
      console.error("[geo-collect] 趋势日更失败（次日重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-trends-done:" + dayKey, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
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
  // 双重门控（批4 W7-11⑤）：标杆站月更为付费接口，需「允许自动月更标杆站与外链反推」授权
  if (!seoSourceOf(db).autoCollect) return;
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
        } catch (e) {
          failed++;
          if (e instanceof Error && e.name === "SeoQuotaError") console.warn("[geo-collect] 标杆站跳过：哥飞余额不足");
        }
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
  // 双重门控（批4 W7-11⑤）：外链反推为付费接口，同上需授权勾选
  if (!seoSourceOf(db).autoCollect) return;
  if (seoBudgetLeft(db, "collect") <= 0) return;
  const running = db.get<any>("meta", "geo-links-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "geo-links-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      // 官方合同：find_link_prospects=卖链站市场快照（8万+ Guest Post 挂牌），按筛选器拉榜单——
      // 外部 Agent 结合词库分析（注册时间+流量）识别隐秘赚钱产品；市场快照无词面归属，fromTerm 记批次
      if (seoBudgetLeft(db, "collect") <= 0) return;
      let injected = 0, failed = 0;
      try {
        const raw = await seoApi.findLinkProspects(db, { minDr: 20, minTraffic: 1000, limit: 30 }, doFetch);
        seoSpend(db, "collect", 1);
        const list: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.prospects ?? [];
        for (const item of list.slice(0, 30)) {
          const host = String(item?.domain ?? item?.host ?? "").toLowerCase().replace(/^www\./, "").slice(0, 120);
          if (!host || !host.includes(".")) continue;
          const prev = db.get<any>("link-prospects", host);
          if (prev) continue;
          db.put("link-prospects", host, {
            id: host, host,
            fromTerm: "market-snapshot",
            dr: typeof item?.dr === "number" ? item.dr : typeof item?.domain_rating === "number" ? item.domain_rating : undefined,
            traffic: typeof item?.traffic === "number" ? item.traffic : typeof item?.etv === "number" ? item.etv : undefined,
            price: typeof item?.price === "number" ? item.price : undefined,
            firstSeenAt: new Date().toISOString(),
          });
          injected++;
        }
      } catch (e) {
        failed++;
        if (e instanceof Error && e.name === "SeoQuotaError") console.warn("[geo-collect] 外链反推跳过：哥飞余额不足");
      }
      db.put("meta", "geo-links-done:" + half, { at: new Date().toISOString(), injected, failed });
      console.log(`[geo-collect] 外链反推：市场快照（失败 ${failed}）/ 新来源站 ${injected}`);
    } catch (e) {
      console.error("[geo-collect] 外链反推失败（下半月重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-links-done:" + half, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "geo-links-running");
    }
  })();
}

// —— 新词发现批次（批4 W7-11③，GET keywords/batches 0 积分，免费保留自动）——
// 每日一道闸：拉最新批次 → 过滤（英文/非品牌/长度，复用 filterTrendWord）→ 注入
// seen-terms（source=gephei-newwords, status=new, seed=批次 id）；批次幂等（done 键记批次 id）。
function parseBatches(raw: unknown): { id: string; keywordCount: number }[] {
  const list: any[] = raw && typeof raw === "object" && Array.isArray((raw as any).data?.batches) ? (raw as any).data.batches : [];
  return list
    .filter((b) => typeof b?.id === "string")
    .map((b) => ({ id: String(b.id), keywordCount: typeof b.keyword_count === "number" ? b.keyword_count : 0 }));
}

function parseBatchKeywords(raw: unknown): { keyword: string; verdict?: string }[] {
  const kws: any[] = raw && typeof raw === "object" && Array.isArray((raw as any).data?.keywords) ? (raw as any).data.keywords : [];
  return kws
    .filter((k) => typeof k?.keyword === "string")
    .map((k) => ({ keyword: String(k.keyword), verdict: typeof k.verdict === "string" ? k.verdict : undefined }));
}

export function newWordsTick(db: Store, doFetch: typeof fetch = fetch, nowDate: Date = new Date()): void {
  const day = nowDate.toISOString().slice(0, 10);
  if (db.get("meta", "geo-newwords-done:" + day)) return;
  if (!seoSourceEnabled(db)) return; // token 出口唯一；免费接口也只在数据源开启时跑
  const running = db.get<any>("meta", "geo-newwords-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "geo-newwords-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      // 最新一批（哥飞新词发现管线每日多批，当日批优先；已消费批次幂等跳过）
      const batchesRes = await doFetch(`${seoSourceOf(db).baseUrl.replace(/\/+$/, "")}/keywords/batches?page=1`, {
        headers: { Authorization: `Bearer ${seoSourceOf(db).token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (!batchesRes.ok) throw new Error(`batches HTTP ${batchesRes.status}`);
      const batches = parseBatches(await batchesRes.json());
      if (!batches.length) { db.put("meta", "geo-newwords-done:" + day, { at: new Date().toISOString(), injected: 0, batch: "" }); return; }
      const latest = batches[0];
      if (db.get("meta", "geo-newwords-batch:" + latest.id)) {
        db.put("meta", "geo-newwords-done:" + day, { at: new Date().toISOString(), injected: 0, batch: latest.id, note: "最新批已消费" });
        return;
      }
      const detailRes = await doFetch(`${seoSourceOf(db).baseUrl.replace(/\/+$/, "")}/keywords/batches/${encodeURIComponent(latest.id)}`, {
        headers: { Authorization: `Bearer ${seoSourceOf(db).token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!detailRes.ok) throw new Error(`batch detail HTTP ${detailRes.status}`);
      const keywords = parseBatchKeywords(await detailRes.json());
      let injected = 0, skipped = 0;
      for (const k of keywords) {
        const clean = filterTrendWord(k.keyword);
        if (!clean) { skipped++; continue; }
        observeSuggestion(db, clean, "gephei-newwords:" + latest.id, { source: "gephei-newwords" });
        injected++;
      }
      db.put("meta", "geo-newwords-batch:" + latest.id, { at: new Date().toISOString(), injected, skipped });
      db.put("meta", "geo-newwords-done:" + day, { at: new Date().toISOString(), batch: latest.id, injected, skipped });
      console.log(`[geo-collect] 新词发现：批次 ${latest.id}（${keywords.length} 词）/ 注入 ${injected} / 过滤 ${skipped}`);
    } catch (e) {
      console.error("[geo-collect] 新词发现失败（次日重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "geo-newwords-done:" + day, { at: new Date().toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "geo-newwords-running");
    }
  })();
}

// —— 手动回传（批4 W7-11④）：哥飞站内查询结果粘贴 → 落词库指标字段 → 站群卡价值面板即时点亮 ——
// ✋ 手动数据权重最高：写 monthlySearch/kd/cpc + gepheiFetchedAt=manualAt（复用新鲜度通道）+
// sources 加 manual-gephei + manualAt；哥飞 intent 顺带落库并与内置对照（冲突标 intentConflict）。
export function applyManualGephei(
  db: Store,
  raw: string,
): { mode: "json" | "text" | "md"; applied: number; skipped: number; intentConflicts: number; cardsLit: number } {
  const { items, mode } = parseManualGephei(raw);
  const stamp = new Date().toISOString();
  let applied = 0, skipped = 0, intentConflicts = 0, cardsLit = 0;
  for (const item of items) {
    const id = termId(item.term);
    const prev = db.get<any>("seen-terms", id);
    if (prev && prev.manualAt) { skipped++; continue; } // ✋ 已有手动数据权重最高，不覆盖
    const patch = {
      ...(item.monthlySearch !== undefined ? { monthlySearch: item.monthlySearch } : {}),
      ...(item.kd !== undefined ? { kd: item.kd } : {}),
      ...(item.cpc !== undefined ? { cpc: item.cpc } : {}),
      gepheiFetchedAt: stamp,
      manualAt: stamp,
    };
    if (prev) {
      // 哥飞意图对照（②）：内置标注 vs 手动回传冲突标记留人工
      let conflict = false;
      if (item.intent && prev.intent && !String(prev.intent).toLowerCase().includes(String(item.intent).toLowerCase())) {
        conflict = true;
        intentConflicts++;
      }
      const mergedSources = [...new Set([...(prev.sources || []), "manual-gephei"])];
      db.put("seen-terms", id, {
        ...prev, ...patch,
        sources: mergedSources,
        ...(item.intent && !prev.intent ? { intent: item.intent } : {}),
        ...(conflict ? { intentConflict: { manual: item.intent, builtin: prev.intent, at: stamp } } : {}),
        updatedAt: stamp,
      });
      bumpSeenTermsVersion(db);
    } else {
      const mergedSources = ["manual-gephei"];
      db.put("seen-terms", id, {
        id, term: item.term.trim(),
        status: "new" as const, observations: 1,
        sources: mergedSources, relatedSearches: [], daysSeen: [stamp.slice(0, 10)],
        obsByDay: { [stamp.slice(0, 10)]: 1 },
        firstSeenAt: stamp, lastSeenAt: stamp, createdAt: stamp,
        ...patch,
        region: "global" as const,
        relevance: undefined, // 手动指标不预设相关性，判定层照常
        producedBy: "manual-gephei/1.0",
        updatedAt: stamp,
      });
      bumpSeenTermsVersion(db);
    }
    applied++;
    // seo-terms 已标词同步指标 → 机会卡即时点亮
    const seoId = item.term.trim().toLowerCase();
    const seo = db.get<any>("seo-terms", seoId);
    if (seo?.siteCandidate === true) {
      const nextSeo = { ...seo, ...patch, updatedAt: stamp };
      db.put("seo-terms", seoId, nextSeo);
      const score = item.monthlySearch !== undefined && item.kd !== undefined && item.cpc !== undefined
        ? Math.round((item.monthlySearch * item.cpc / Math.max(1, item.kd)) * 10) / 10
        : undefined;
      const cardId = "opp-" + hash(`site:cand:${id}`).slice(0, 20); // 与 opportunity.upsert 同口径
      const card = db.get<any>("opportunities", cardId);
      if (card) {
        db.put("opportunities", cardId, {
          ...card,
          ...(score !== undefined ? { seoMetrics: { monthlySearch: item.monthlySearch, kd: item.kd, cpc: item.cpc, valueScore: score }, valueUnverified: undefined } : {}),
          updatedAt: stamp,
        });
        cardsLit++;
      }
    }
  }
  // 最近 3 条回传记录（UI 展示）
  const rec = db.get<any>("meta", "manual-gephei-recent") || [];
  const list: any[] = Array.isArray(rec) ? rec : [];
  list.unshift({ at: stamp, mode, applied, skipped: items.length - applied, sample: items.slice(0, 3).map((i) => i.term) });
  db.put("meta", "manual-gephei-recent", list.slice(0, 3));
  return { mode, applied, skipped, intentConflicts, cardsLit };
}


