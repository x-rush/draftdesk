// 机会引擎（第五轮 §1）：三大机会引擎（站群/应用/内容）的统一输入层。
// 四类信号 → opportunity 统一记录；判定逻辑写成共享纯函数，两个执行者共用：
// · external（默认，我们的现状）：外部 Agent 点 POST /opportunities/generate 触发生成；
//   consumerMode=external 时 worker 不自动跑（内置 AI 只管采集与初筛，不做机会生成）。
// · builtin：worker 每日 opportunityTick 自动跑一次（同一套规则，仅执行者不同）。
// 初筛联动（§1⑥）：watch 池 TTL（引用≥2 晋升 / 超 14 天未引用降级）+
// plan.platformAffinity 平台适配（实测/教程→笔记线、深度/分析→长文线）二次精筛 watch 池。
import type { Store } from "./store";
import { hash, now } from "./store";
import { urlKey } from "./hotspots";
import { judgeVerdict, platformOf } from "./seen-judge";
import { valueScoreOf } from "./seo-gate";
import { termId } from "./seen-terms";

export type OpportunitySignal = "complaint" | "newtech" | "news" | "trend";
export type OpportunityKind = "site" | "app";
export type OpportunityVerdict = "推荐" | "可以试试" | "不值得做" | "待验证";
// 产品形态四值（第七轮批2 W7-5）：web=Web 应用 / app=App / miniprogram=小程序 / tool=工具站。
// 内容线机会卡（平台适配）无产品形态，form 缺省。
export type OpportunityForm = "web" | "app" | "miniprogram" | "tool";
export const FORM_LABELS: Record<OpportunityForm, string> = { web: "Web 应用", app: "App 应用", miniprogram: "小程序", tool: "工具站" };
// 存量自由文本 → 枚举归一（迁移与读时兜底共用）；「内容页」类无产品形态 → undefined。
export function normalizeForm(value: unknown): OpportunityForm | undefined {
  if (value === "web" || value === "app" || value === "miniprogram" || value === "tool") return value;
  if (typeof value !== "string") return undefined;
  const s = value.toLowerCase();
  if (/小程序|miniprogram/.test(s)) return "miniprogram";
  if (/web|网页/.test(s)) return "web";
  if (/工具站|工具页/.test(s)) return "tool";
  if (/\bapp\b|应用|客户端/.test(s)) return "app";
  return undefined;
}
export const SIGNAL_LABELS: Record<OpportunitySignal, string> = {
  complaint: "用户抱怨",
  newtech: "新技术",
  news: "新资讯",
  trend: "热词趋势",
};
export const KIND_LABELS: Record<OpportunityKind, string> = { site: "站群/内容页", app: "应用" };
export const PLATFORM_LABELS: Record<string, string> = { gzh: "公众号", "xhs-note": "小红书笔记", "xhs-video": "小红书视频", tiehao: "微信贴图号" };

export type Opportunity = {
  id: string;
  dedupeKey: string;
  kind: OpportunityKind;
  signals: OpportunitySignal[];
  term?: string;
  evidenceIds: string[];
  url?: string;
  watchRefs?: number;
  platform?: string;
  title: string;
  oneLiner: string;
  form?: OpportunityForm;
  // 哥飞三指标 + 综合价值分（月搜×CPC÷KD，W7-3）；valueUnverified=无新鲜指标（降级候选）
  seoMetrics?: { monthlySearch: number; kd: number; cpc: number; valueScore: number };
  valueUnverified?: boolean;
  // 竞品档案（W7-10 新增3）：SERP 前 10 域名+平台+量级档（DR 待哥飞 token 联调补全）
  competitors?: { host: string; platform?: string; tier?: string; dr?: number }[];
  domainSuggestions?: string[];
  valuation?: string;
  verdict: OpportunityVerdict;
  verdictReason: string;
  verifyPlan: string[];
  source: "auto" | "agent";
  createdAt: string;
  updatedAt: string;
};

// 平台适配关键词（§1⑥b）：命中平台题材关键词的 watch 候选获得内容线机会二次精筛资格。
export const PLATFORM_FIT: Record<string, RegExp> = {
  gzh: /深度|分析|解读|复盘|报告|拆解/i,
  "xhs-note": /实测|教程|攻略|清单|避坑|手把手/i,
  "xhs-video": /实测|演示|上手|体验|开箱/i,
  tiehao: /一图|图解|速览|快讯/i,
};
export function platformFitOf(title: string, affinity: string[] | undefined): string | undefined {
  if (!affinity?.length) return undefined;
  return affinity.find((p) => PLATFORM_FIT[p]?.test(title));
}

// 新品/上新措辞（newtech/news 信号，批 1 收尾收紧）：只认真·产品级变化
//（发布/上线/开放/GA/降价/接口/下线/区域扩展等实体变化词）；
// MARKETING_RE 命中的纯营销话术标题（Introducing/Meet/Now available/announcing…）
// 除非同含实体变化词，否则不推演——宁可少不可滥。
const LAUNCH_RE = /发布|上线|推出|开放|新增|开启|降价|免费|正式版|general availability|price (cut|drop)|cuts? (its? )?prices?|deprecat|sunset|end.of.life|expands?|launch(es|ed)?|releas(es|ed)?|rolls? out|rate limit|new (model|api|feature)|open.?sourc/i;
const MARKETING_RE = /^(introducing|now available|meet [\W"']?\w|announcing|celebrating|welcome|say hello|the story|behind)/i;

export function passesLaunchGate(title: string, detail: string): boolean {
  return LAUNCH_RE.test(`${title} ${detail}`) && !MARKETING_RE.test(title.trim());
}
const GAP_FORMS = "额度监控 / 状态页 / 迁移工具 / 格式转换";
const VERIFY = {
  app: (what: string): string[] => [
    `复核官方文档与社区反馈，确认「${what}」缺口真实存在`,
    "一周内做最小可用页（单功能，不做账号体系）",
    "投放到相关社区/评论区收集 10 个真实反馈",
  ],
  site: (term: string): string[] => [
    `用 Trends 与搜索联想复核「${term}」的搜索意图稳定性`,
    "一周内上线内容页或工具页（静态托管，四平台择一）",
    "观察 Search Console 收录与首周点击",
  ],
};

// ---- 引用计数（watch 池 TTL 的原料）----
// 引用来源：人工/Agent 消费记录 + 产物/大纲/机会引用的证据（证据 url → 热点 key）。
export function watchRefCounts(db: Store): Map<string, number> {
  const refs = new Map<string, number>();
  const bump = (k: string) => refs.set(k, (refs.get(k) ?? 0) + 1);
  for (const c of db.list<any>("consumption"))
    if (c.target === "hotspots" && !c.unconsumeUntil) bump(String(c.identity));
  const urlOf = new Map(db.list<any>("evidence").map((e) => [e.id, urlKey(e.url)]));
  const bumpEvidence = (ids: string[] | undefined) => {
    for (const id of ids || []) { const k = urlOf.get(id); if (k) bump(k); }
  };
  for (const a of db.list<any>("artifacts")) if (!a.archived) bumpEvidence(a.evidenceIds);
  for (const o of db.list<any>("outlines")) bumpEvidence(o.evidenceRefs);
  for (const op of db.list<any>("opportunities")) bumpEvidence(op.evidenceIds);
  return refs;
}

// ---- watch 池 TTL（§1⑥a）----
// watch 超 14 天未被任何机会/选题引用 → 降级 filtered（原 reason 保留可查）；
// 被引用过 ≥2 次 → 晋升 selected 候选。只改状态层，不删记录。
export const WATCH_TTL_DAYS = 14;
export function watchPoolMaintenance(db: Store, opts: { ttlDays?: number; now?: Date } = {}): { scanned: number; promoted: number; demoted: number } {
  const ttl = opts.ttlDays ?? WATCH_TTL_DAYS;
  const cutoff = (opts.now ?? new Date()).getTime() - ttl * 86400000;
  const refs = watchRefCounts(db);
  let scanned = 0, promoted = 0, demoted = 0;
  for (const record of db.list<any>("discovery")) {
    let dirty = false;
    for (const c of record.candidates || []) {
      if (c.status !== "watch") continue;
      scanned++;
      const n = refs.get(urlKey(c.url)) ?? 0;
      if (n >= 2) {
        c.status = "selected";
        c.reason = `已被机会/选题引用 ${n} 次，晋升 selected（watch TTL）`;
        dirty = true; promoted++;
      } else if (!n && Date.parse(c.observedAt || record.at) < cutoff) {
        c.status = "filtered";
        c.reason = `${c.reason}；watch 超 ${ttl} 天未被引用，TTL 降级`;
        dirty = true; demoted++;
      }
    }
    if (dirty) db.put("discovery", record.jobId, record);
  }
  return { scanned, promoted, demoted };
}

// ---- 四信号源生成 ----
type Draft = Omit<Opportunity, "id" | "createdAt" | "updatedAt">;
type Counters = { created: number; merged: number; bySignal: Record<OpportunitySignal, number> };

// 同 dedupeKey 合并：signals 并集（同词被抱怨与趋势先后命中时一张卡两信号）；agent 生成提升 source 标注。
function upsert(db: Store, draft: Draft, counters: Counters) {
  const id = "opp-" + hash(draft.dedupeKey).slice(0, 20);
  const prev = db.get<any>("opportunities", id);
  if (prev) {
    const signals = [...new Set([...(prev.signals || []), ...draft.signals])] as OpportunitySignal[];
    const promote = draft.source === "agent" && prev.source === "auto";
    if (signals.length !== (prev.signals || []).length || promote) {
      db.put("opportunities", id, { ...prev, ...draft, signals, source: promote ? "agent" : prev.source, updatedAt: now() });
      counters.merged++;
    }
    return;
  }
  db.put("opportunities", id, { ...draft, id, createdAt: now(), updatedAt: now() });
  counters.created++;
  counters.bySignal[draft.signals[0]] = (counters.bySignal[draft.signals[0]] || 0) + 1;
}

// a. complaint：small-products 的 idea 产物 + selected 候选 + watch 池平台适配二次精筛。
function generateFromComplaints(db: Store, source: "auto" | "agent", counters: Counters) {
  const plans = db.list<any>("plans");
  const oppPlan = plans.find((p) => p.kind === "opportunity");
  const planByName = new Map(plans.map((p) => [p.name, p]));
  const refCounts = watchRefCounts(db);
  const evidenceByUrl = new Map(db.list<any>("evidence").map((e) => [urlKey(e.url), e]));
  const claimedEvidence = new Set<string>();
  for (const op of db.list<any>("opportunities")) for (const id of op.evidenceIds || []) claimedEvidence.add(id);
  const claimedUrls = new Set<string>();
  for (const op of db.list<any>("opportunities")) if (op.url) claimedUrls.add(urlKey(op.url));
  // a1. idea 产物：AI 分析过的应用机会（证据最全）
  for (const a of db.list<any>("artifacts")) {
    if (a.kind !== "idea" || a.archived) continue;
    for (const id of a.evidenceIds || []) claimedEvidence.add(id);
    upsert(db, {
      dedupeKey: `app:idea:${a.id}`, kind: "app", signals: ["complaint"], evidenceIds: a.evidenceIds || [],
      title: a.title, oneLiner: a.details?.trigger || String(a.summary || "").slice(0, 160),
      form: "web", verdict: a.quality === "ready" ? "可以试试" : "待验证",
      verdictReason: a.quality === "ready" ? "质量审核通过的应用机会" : "待验证：证据或审核未齐",
      verifyPlan: a.details?.experiment ? [a.details.experiment] : VERIFY.app(a.title),
      source,
    }, counters);
  }
  if (!oppPlan) return;
  // a2/a3. 发现候选：selected（进过分析名额）直接成卡；watch 里平台适配命中的做内容线机会。
  for (const record of db.list<any>("discovery")) {
    if (record.planName !== oppPlan.name) continue;
    const affinity = planByName.get(record.planName)?.platformAffinity;
    for (const c of record.candidates || []) {
      const k = urlKey(c.url);
      if (claimedUrls.has(k)) continue;
      if (c.status === "selected") {
        const ev = evidenceByUrl.get(k);
        if (ev && claimedEvidence.has(ev.id)) { claimedUrls.add(k); continue; }
        if (ev) { claimedEvidence.add(ev.id); claimedUrls.add(k); }
        upsert(db, {
          dedupeKey: `app:ev:${hash(k).slice(0, 24)}`, kind: "app", signals: ["complaint"],
          evidenceIds: ev ? [ev.id] : [], url: c.url, title: c.title.slice(0, 120),
          oneLiner: c.reason || "符合策略的已选证据候选", form: "web",
          verdict: "待验证", verdictReason: "候选证据待人工复核需求真伪",
          verifyPlan: VERIFY.app(c.title.slice(0, 60)), source,
        }, counters);
      } else if (c.status === "watch") {
        const fit = platformFitOf(c.title, affinity);
        if (!fit || claimedUrls.has(k)) continue;
        claimedUrls.add(k);
        upsert(db, {
          dedupeKey: `site:ev:${hash(k).slice(0, 24)}`, kind: "site", signals: ["complaint"],
          evidenceIds: [], url: c.url, title: c.title.slice(0, 120),
          oneLiner: `平台适配命中（${PLATFORM_LABELS[fit] || fit}）：题材匹配当前内容线`,
          form: undefined, // 内容线机会无产品形态（W7-5 四值为产品形态）
          verdict: "待验证", verdictReason: "watch 候选平台适配二次精筛，未进过分析名额",
          verifyPlan: VERIFY.site(c.title.slice(0, 40)), source, platform: fit,
          watchRefs: refCounts.get(k) ?? 0,
        }, counters);
      }
    }
  }
}

// b. newtech：daily-editorial 的 news 产物（产品级变化）→ 推演配套缺口。
function generateFromNewtech(db: Store, source: "auto" | "agent", counters: Counters, since: number) {
  for (const a of db.list<any>("artifacts")) {
    if (a.kind !== "news" || a.archived) continue;
    if (Date.parse(a.createdAt || "") < since) continue;
    const changed = String(a.details?.whatChanged || "");
    if (!passesLaunchGate(a.title, changed)) continue;
    upsert(db, {
      dedupeKey: `app:evlist:${(a.evidenceIds || []).slice().sort().join(",") || a.id}`,
      kind: "app", signals: ["newtech"], evidenceIds: a.evidenceIds || [],
      title: a.title, oneLiner: `「${(changed || a.title).slice(0, 80)}」上线后的配套缺口推演（${GAP_FORMS}，按适用做减法）`,
      form: "web", verdict: "待验证",
      verdictReason: "缺口为规则推演，未经需求验证",
      verifyPlan: VERIFY.app((changed || a.title).slice(0, 40)), source,
    }, counters);
  }
}

// c. news：官方 RSS 源的新品条目（官方域名证据）→ 同上推演；已被产物引用的证据不重出卡。
function generateFromNews(db: Store, source: "auto" | "agent", counters: Counters, since: number) {
  const officialHosts = new Set<string>();
  for (const s of db.list<any>("sources")) {
    if (s.sourceType !== "official" || s.enabled === false) continue;
    for (const d of s.officialDomains || []) officialHosts.add(d.toLowerCase());
    if (s.url) { try { officialHosts.add(new URL(s.url).hostname.replace(/^www\./, "")); } catch { /* 忽略坏 url */ } }
  }
  if (!officialHosts.size) return;
  const claimed = new Set<string>();
  for (const op of db.list<any>("opportunities")) for (const id of op.evidenceIds || []) claimed.add(id);
  for (const e of db.list<any>("evidence")) {
    if (claimed.has(e.id) || e.sourceType !== "official") continue;
    if (Date.parse(e.collectedAt || "") < since) continue;
    let host = ""; try { host = new URL(e.url).hostname.replace(/^www\./, ""); } catch { continue; }
    if (![...officialHosts].some((h) => host === h || host.endsWith("." + h))) continue;
    if (!passesLaunchGate(e.title, e.excerpt)) continue;
    upsert(db, {
      dedupeKey: `app:ev:${e.id}`, kind: "app", signals: ["news"], evidenceIds: [e.id],
      title: e.title.slice(0, 120), oneLiner: `官方新品：「${e.title.slice(0, 80)}」→ 配套缺口推演（${GAP_FORMS}）`,
      form: "web", verdict: "待验证",
      verdictReason: "官方发布推演缺口，未经需求验证",
      verifyPlan: VERIFY.app(e.title.slice(0, 40)), source,
    }, counters);
  }
}

// d. trend：seen-terms verdict=推荐 → site 蓝海词卡；toolSignal 强（工具意图+强相关+多观测）→ app 卡；
// alternative 词根（词根探针 seed=alternative）的 strong 词 = 替代缺口信号 → complaint app 卡（批 2b §4.8①）。
export function toolSignalOf(t: { intent?: string; relevance?: string; observations?: number }): boolean {
  return (t.intent === "comparison" || t.intent === "commercial") && t.relevance === "strong" && (t.observations ?? 0) >= 2;
}
function isAlternativeProbe(t: { term?: string; seed?: string }): boolean {
  if (t.seed === "alternative") return true;
  return /(^|[\s-])alternative(s)?($|[\s-])/i.test(t.term || "");
}
function generateFromTrend(db: Store, source: "auto" | "agent", counters: Counters) {
  for (const t of db.list<any>("seen-terms")) {
    if (t.status === "archived" || t.offTopic) continue;
    const { verdict, reason } = judgeVerdict(t);
    if (verdict === "推荐" && (t.region ?? "global") === "global") {
      upsert(db, {
        dedupeKey: `site:term:${t.id}`, kind: "site", signals: ["trend"], term: t.term,
        evidenceIds: [], title: t.term,
        oneLiner: `蓝海词：${reason}，四大静态平台零竞争站`, form: "tool",
        verdict: "推荐", verdictReason: reason, verifyPlan: VERIFY.site(t.term), source,
      }, counters);
    }
    if (toolSignalOf(t)) {
      upsert(db, {
        dedupeKey: `app:term:${t.id}`, kind: "app", signals: ["trend"], term: t.term,
        evidenceIds: [], title: t.term,
        oneLiner: `工具意图词（${t.intent === "comparison" ? "对比/替代" : "价格/商业"}）观测 ${t.observations} 次`,
        form: "tool", verdict: "可以试试", verdictReason: `relevance=strong 且 intent=${t.intent}，需求形状偏工具`,
        verifyPlan: VERIFY.app(t.term), source,
      }, counters);
    }
    if (t.relevance === "strong" && isAlternativeProbe(t)) {
      upsert(db, {
        dedupeKey: `app:altterm:${t.id}`, kind: "app", signals: ["complaint"], term: t.term,
        evidenceIds: [], title: t.term,
        oneLiner: `替代缺口词：「${t.term}」的搜索=对现有方案不满（alternative 词根探针产出）`,
        form: "web", verdict: "待验证",
        verdictReason: "alternative 搜索=替代缺口信号，待核验被替代方与缺口真伪",
        verifyPlan: VERIFY.app(t.term), source,
      }, counters);
    }
  }
}

export function generateOpportunities(db: Store, opts: { source?: "auto" | "agent"; lookbackDays?: number } = {}): { created: number; merged: number; bySignal: Record<OpportunitySignal, number> } {
  const source = opts.source ?? "agent";
  const since = Date.now() - (opts.lookbackDays ?? 30) * 86400000;
  const counters: Counters = { created: 0, merged: 0, bySignal: { complaint: 0, newtech: 0, news: 0, trend: 0 } };
  generateFromComplaints(db, source, counters);
  generateFromNewtech(db, source, counters, since);
  generateFromNews(db, source, counters, since);
  generateFromTrend(db, source, counters);
  generateFromSiteCandidates(db, source, counters);
  return { created: counters.created, merged: counters.merged, bySignal: counters.bySignal };
}

// 存量 news/newtech 卡复检（批 1 收尾②）：按收紧后的 launch gate 重跑，
// 不符合的降档「不值得做」并标注营销推演——迁移 opportunity-news-tighten-v1 调用。
export function retightenNewsOpportunities(db: Store): { checked: number; demoted: number } {
  let checked = 0, demoted = 0;
  for (const op of db.list<any>("opportunities")) {
    if (op.verdict !== "待验证" || !(op.signals || []).some((s: string) => s === "news" || s === "newtech")) continue;
    checked++;
    if (passesLaunchGate(String(op.title || ""), String(op.oneLiner || ""))) continue;
    db.put("opportunities", op.id, {
      ...op,
      verdict: "不值得做",
      verdictReason: `营销推演（规则收紧复检降档）：标题无实体变化词——${String(op.verdictReason || "").slice(0, 60)}`,
      updatedAt: now(),
    });
    demoted++;
  }
  return { checked, demoted };
}

// e. siteCandidate（应用机会页单入口 §2.5②）：站群门槛达标词（内置 sweep 自动标注或外部 Agent 标注）
// → 站群机会卡（form=tool）。哥飞三指标新鲜（W7-3）带 seoMetrics+综合价值分；
// 无新鲜指标打 valueUnverified（「价值未验证」徽章，配 token 后自动升级）。
// 竞品档案组装（读时派生，无外呼）：词的 SERP 前 10（seen-terms serpAll 优先，降级 serpHosts）
// + 静态平台识别 + 量级档位（web-traffic 缓存：哥飞 source 优先）。DR 留待哥飞联调补全。
function competitorsOf(db: Store, term: string): { host: string; platform?: string; tier?: string; dr?: number }[] {
  const seen = db.get<any>("seen-terms", termId(term));
  const rows: { host: string; url?: string }[] = seen?.serpAll?.length ? seen.serpAll : (seen?.serpHosts || []).map((h: string) => ({ host: h }));
  return rows.slice(0, 10).map((r) => ({
    host: String(r.host),
    platform: platformOf(String(r.host)),
    tier: db.get<any>("web-traffic", String(r.host).toLowerCase())?.tier,
  }));
}

function generateFromSiteCandidates(db: Store, source: "auto" | "agent", counters: Counters) {
  for (const t of db.list<any>("seo-terms")) {
    if (t.siteCandidate !== true || !t.term) continue;
    const score = valueScoreOf(t);
    const fresh = score !== undefined && typeof t.monthlySearch === "number" && typeof t.kd === "number" && typeof t.cpc === "number";
    const competitors = competitorsOf(db, String(t.term));
    upsert(db, {
      dedupeKey: `site:cand:${termId(String(t.term))}`, kind: "site", signals: ["trend"], term: String(t.term),
      evidenceIds: [], title: String(t.term),
      oneLiner: `站群候选词（siteCandidate 标注）：${[t.siteType, ...(Array.isArray(t.sources) ? t.sources : [])].filter(Boolean).join(" · ") || "站群门槛达标"}`,
      form: "tool", verdict: "待验证",
      verdictReason: String(t.siteRationale || "siteCandidate 标注（站群门槛达标）").slice(0, 110),
      verifyPlan: VERIFY.site(String(t.term)), source,
      ...(fresh ? { seoMetrics: { monthlySearch: t.monthlySearch, kd: t.kd, cpc: t.cpc, valueScore: score! }, valueUnverified: undefined } : { valueUnverified: true, seoMetrics: undefined }),
      competitors,
      ...(Array.isArray(t.domainSuggestions) && t.domainSuggestions.length ? { domainSuggestions: t.domainSuggestions.slice(0, 5) } : { domainSuggestions: undefined }),
      ...(t.valuation ? { valuation: String(t.valuation).slice(0, 120) } : { valuation: undefined }),
    }, counters);
  }
}

// ---- worker tick（每日一道闸）----
// watch TTL 是初筛的一部分（初筛保留，不受 consumerMode 影响，§4）；机会自动生成只在 builtin 跑。
export function watchTtlTick(db: Store, nowDate: Date = new Date()) {
  const day = nowDate.toISOString().slice(0, 10);
  if (db.get("meta", "watch-ttl-done:" + day)) return;
  const r = watchPoolMaintenance(db, { now: nowDate });
  db.put("meta", "watch-ttl-done:" + day, { at: now(), ...r });
  if (r.promoted || r.demoted) console.log(`[opportunity] watch 池 TTL：晋升 ${r.promoted} / 降级 ${r.demoted}（扫描 ${r.scanned}）`);
}

export function opportunityTick(db: Store, nowDate: Date = new Date()) {
  if ((db.get("config", "consumerMode") || "external") !== "builtin") return;
  const day = nowDate.toISOString().slice(0, 10);
  if (db.get("meta", "opportunity-auto-done:" + day)) return;
  const r = generateOpportunities(db, { source: "auto" });
  db.put("meta", "opportunity-auto-done:" + day, { at: now(), ...r });
  console.log(`[opportunity] builtin 自动生成：新增 ${r.created} / 合并 ${r.merged}`);
}
