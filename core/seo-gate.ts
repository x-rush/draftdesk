// 站群门槛与哥飞指标日更（第七轮拆分自 seen-judge.ts）：
// · siteGate 规则（W7-4）：config.siteGate 参数内化，evalSiteGate 全门槛/降级判定，
//   siteGateAutoMark sweep 自动出标（builtin-gate-v1），siteCandidateEligibleOf 三通道候选池判定口
// · seoMetricsTick 日更（W7-8，采集=内置 tick，token 唯一出口）：批量补查三指标落词库，
//   全门槛达标自动出标+域名清单+出卡触发；autoMetrics 授权门控+metrics 月池（批4）
// 依赖方向：seo-gate → seo-source / seen-terms / store（opportunity 出卡为动态 import，避免循环）
import type { Store } from "./store";
import { termId, bumpSeenTermsVersion } from "./seen-terms";
import { GEPHEI_TTL_MS, seoSourceEnabled, seoSourceOf, seoBudgetLeft, seoSpend, fetchKeywordMetrics, seoApi } from "./seo-source";

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
// 哥飞付费补查（P0-3 修复，社区审查）：必须过 autoMetrics 授权门（与 seoMetricsTick 同款，
// 违反即打破「关闭=纯手动零扣费」合同）、只查英文词（哥飞 volume 仅英文有数据），
// 且按批调用（50 词一批扣 2 次，逐词调用会让月池 30 次在 15 个词上耗尽）；
// 补查失败/预算尽/未授权 → 保持降级口径出标（增值源故障不丢候选，卡带 valueUnverified）。
export async function siteGateAutoMark(db: Store, doFetch: typeof fetch = fetch, limit = 200): Promise<{ marked: number; scanned: number; enriched: number }> {
  const gate = siteGateOf(db);
  const paidFetch = seoSourceEnabled(db) && seoSourceOf(db).autoMetrics;
  const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
  let marked = 0, enriched = 0;
  const all = db.list<any>("seen-terms");
  // 第一遍：判门槛；降级达标且可付费补查的英文词攒批（fetchKeywordMetrics 自带预算闸与 50 词上限）
  const deferred: { t: any; word: string }[] = [];
  const ready: { t: any; word: string; metrics: Record<string, unknown> }[] = [];
  for (const t of all) {
    if (marked + deferred.length >= limit) break;
    const word = String(t.term || t.id || "").trim();
    if (!word || t.status === "archived") continue;
    if (markedIds.has(termId(word))) continue;
    const verdict = evalSiteGate(t, gate);
    if (!verdict.pass) continue;
    if (!seoMetricsFresh(t) && paidFetch && isEnglishTerm(word)) deferred.push({ t, word });
    else ready.push({ t, word, metrics: {} });
  }
  // 付费补查一批：结果回写词库并按全门槛重判；失败/预算尽整体降级出标
  if (deferred.length) {
    try {
      const fetched = await fetchKeywordMetrics(db, deferred.map((d) => d.word), doFetch);
      for (const { t, word } of deferred) {
        const m = fetched.get(word);
        if (m && (m.monthlySearch !== undefined || m.kd !== undefined || m.cpc !== undefined || m.intent !== undefined)) {
          enriched++;
          const metrics = { ...(m.monthlySearch !== undefined ? { monthlySearch: m.monthlySearch } : {}), ...(m.kd !== undefined ? { kd: m.kd } : {}), ...(m.cpc !== undefined ? { cpc: m.cpc } : {}), gepheiFetchedAt: new Date().toISOString() };
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
          if (evalSiteGate({ ...t, ...metrics }, gate).pass) ready.push({ t, word, metrics });
        } else {
          ready.push({ t, word, metrics: {} });
        }
      }
    } catch {
      for (const { t, word } of deferred) ready.push({ t, word, metrics: {} });
    }
  }
  // 第二遍：出标
  for (const { t: _t, word, metrics } of ready) {
    if (marked >= limit) break;
    void _t;
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
      siteRationale: evalSiteGate({ ..._t, ...metrics }, gate).reason,
      updatedAt: stamp,
      ...(prev?.createdAt ? {} : { createdAt: stamp }),
    });
    markedIds.add(termId(word));
    marked++;
  }
  if (marked || enriched) console.log(`[seen-judge] siteGate 自动标注 ${marked} 词${enriched ? `（哥飞补查 ${enriched} 词指标，批量化）` : ""}（builtin-gate-v1，扫描 ${all.length}）`);
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

// ---- 哥飞指标日更（第七轮批3 W7-8；批4 R8-3 重构：共享质量闸+语言分层+按次记账）----
// 质量闸（共享函数，R8-4②「今日待查清单」直接复用，一次修两用）：
// strong + global + SERP 竞争≤门槛上限 + obs≥5 + 未出标 + 指标过期（90 天），
// 英文优先排序（哥飞 volume 仅英文数据，中文词上游无数据照扣不误——R8-3③）。
export function isEnglishTerm(term: string): boolean {
  return /^[a-z0-9][a-z0-9 '+.&-]{2,39}$/i.test(String(term || "").trim()) && /[a-z]/i.test(String(term || ""));
}

export function dailyMetricsCandidates(db: Store, gate: SiteGate, markedIds: Set<string>): any[] {
  return db.list<any>("seen-terms")
    .filter((t) => t.status !== "archived" && t.relevance === "strong" && (t.region ?? "global") === "global"
      && typeof t.serpDedicated === "number" && t.serpDedicated <= gate.serpDedicatedMax
      && (t.observations ?? 0) >= 5
      && !seoMetricsFresh(t) && !markedIds.has(termId(String(t.term || t.id))))
    .sort((a, b) => {
      const ea = isEnglishTerm(String(a.term || a.id)) ? 0 : 1;
      const eb = isEnglishTerm(String(b.term || b.id)) ? 0 : 1;
      return ea - eb || (b.observations ?? 0) - (a.observations ?? 0);
    });
}

export function seoMetricsTick(db: Store, doFetch: typeof fetch = fetch, nowDate: Date = new Date()): void {
  const day = nowDate.toISOString().slice(0, 10);
  if (db.get("meta", "seo-metrics-done:" + day)) return;
  if (!seoSourceEnabled(db)) return;
  // 双重门控（批4 W7-11①；R8-4 v4 后默认关）：付费接口自动查需 settings 授权，
  // 关闭时零调用——准站群卡走「待查指标」指导深链+「今日待查」清单（手动回传）
  if (!seoSourceOf(db).autoMetrics) return;
  const gate = siteGateOf(db);
  const markedIds = new Set(db.list<any>("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
  const allCandidates = dailyMetricsCandidates(db, gate, markedIds);
  // 语言分层（R8-3①）：英文词优先（哥飞 volume 仅英文有数据）；中文词移出哥飞通道，
  // 计入 skippedLang 留待 suggest-cn 免费联想线（不自动调用）
  const candidates = allCandidates.filter((t) => isEnglishTerm(String(t.term || t.id)))
    .slice(0, 50); // 官方 volume 上限 50 词/次
  const skippedLang = allCandidates.length - candidates.length;
  if (!candidates.length) {
    db.put("meta", "seo-metrics-done:" + day, { at: nowDate.toISOString(), checked: 0, marked: 0, skippedLang, note: allCandidates.length ? "候选全部为非英文（哥飞 volume 无数据）" : "无候选" });
    return;
  }
  const running = db.get<any>("meta", "seo-metrics-running");
  if (running && Date.now() - Date.parse(running.at) < 15 * 60000) return;
  db.put("meta", "seo-metrics-running", { at: new Date().toISOString() });
  void (async () => {
    try {
      const terms = candidates.map((t) => String(t.term || t.id));
      const metrics = await fetchKeywordMetrics(db, terms, doFetch);
      let marked = 0, stamped = 0;
      for (const t of candidates) {
        const word = String(t.term || t.id).trim();
        const m = metrics.get(word);
        if (!m) continue;
        const patch = { ...(m.monthlySearch !== undefined ? { monthlySearch: m.monthlySearch } : {}), ...(m.kd !== undefined ? { kd: m.kd } : {}), ...(m.cpc !== undefined ? { cpc: m.cpc } : {}), gepheiFetchedAt: new Date().toISOString() };
        stamped++;
        const prev = db.get<any>("seen-terms", termId(word));
        if (prev) {
          const intentMap: Record<string, string> = { informational: "informational", commercial: "commercial", transactional: "commercial" };
          const mappedIntent = m.intent ? intentMap[m.intent] : undefined;
          db.put("seen-terms", termId(word), { ...prev, ...patch, ...(mappedIntent && !prev.intent ? { intent: mappedIntent } : {}), updatedAt: new Date().toISOString() });
          bumpSeenTermsVersion(db);
        }
        // 全门槛达标且未标 → 自动出标（免费降级已标的词不覆写，维持批2 拍板）
        const verdict = evalSiteGate({ ...t, ...patch }, gate);
        if (!verdict.pass || markedIds.has(termId(word))) continue;
        const seoId = word.toLowerCase();
        const prevSeo = db.get<any>("seo-terms", seoId);
        if (prevSeo?.siteCandidate === true) continue;
        const stamp = new Date().toISOString();
        // 域名清单（W7-10 新增3）：词根 + 常见后缀变体查可注册性（metrics 池 1 次/词），可注册前 5 落 doc
        let domainSuggestions: string[] | undefined;
        if (seoBudgetLeft(db, "metrics") > 0) {
          try {
            const base = termId(word).slice(0, 30).replace(/[^a-z0-9]/g, "") || "tool";
            const cand = [...new Set([`${base}.com`, `${base}.io`, `${base}.app`, `${base}.dev`, `${base}.net`, `${base}ai.com`, `get${base}.com`, `try${base}.com`])];
            const raw = await seoApi.domainAvailability(db, cand, doFetch) as any;
            seoSpend(db, "metrics", 1);
            const list: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.domains ?? [];
            const available = list.filter((x) => (x?.available ?? x?.registrable ?? false) === true).map((x) => String(x?.domain || x?.name || "")).filter(Boolean);
            domainSuggestions = (available.length ? available : cand).slice(0, 5);
          } catch { /* 域名查询失败不阻塞出标 */ }
        }
        db.put("seo-terms", seoId, {
          ...(prevSeo ?? {}), ...patch,
          ...(domainSuggestions ? { domainSuggestions } : {}),
          id: seoId, term: word,
          siteCandidate: true, siteCandidateBy: "builtin-gate-v1", siteRationale: verdict.reason,
          updatedAt: stamp, ...(prevSeo?.createdAt ? {} : { createdAt: stamp }),
        });
        markedIds.add(termId(word));
        marked++;
      }
      db.put("meta", "seo-metrics-done:" + day, { at: nowDate.toISOString(), checked: terms.length, stamped, marked, skippedLang, note: `英文 ${terms.length} 词（中文 ${skippedLang} 词无数据跳过）；额度 ${seoBudgetLeft(db, "metrics")} 次剩余` });
      if (marked > 0) {
        // 出卡触发（W7-8 链路末端）：动态 import 避免与 opportunity.ts 的模块循环
        // R10.26-2 P0：external 模式不触发出卡——机会卡由外部 Agent 经 PUT /agent/opportunities 写回
        if ((db.get<any>("config", "consumerMode") || "external") === "builtin") {
          const { generateOpportunities } = await import("./opportunity");
          const r = generateOpportunities(db, { source: "auto" });
          console.log(`[seo-metrics] 哥飞日更出标 ${marked} 词 → 触发机会生成：新增 ${r.created} 卡`);
        } else {
          console.log(`[seo-metrics] 哥飞日更出标 ${marked} 词 → external 模式不触发出卡（外部 Agent 经 PUT /agent/opportunities 写回）`);
        }
      }
      if (terms.length || marked) console.log(`[seo-metrics] 哥飞指标日更：补查 ${terms.length} 词（落库 ${stamped}，中文跳过 ${skippedLang}）/ 全门槛新出标 ${marked}`);
    } catch (e) {
      console.error("[seo-metrics] 哥飞指标日更失败（次日重试）:", e instanceof Error ? e.message : e);
      db.put("meta", "seo-metrics-done:" + day, { at: nowDate.toISOString(), error: String((e as Error)?.message || e).slice(0, 160) });
    } finally {
      db.del("meta", "seo-metrics-running");
    }
  })();
}

