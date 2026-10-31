// 机会引擎（R10.40 归口重构，老大 10-31 定调）：**全部语义判断归外部 Agent**——
// 工作台不再有任何自动出卡路径（原四信号七生成器 sweep 整体下线，存量 841 张
// auto 卡已清理）。卡片唯一写口=PUT /agent/opportunities（小拾语义评估后写入，
// 值得才写、verdictReason 带判断依据、≤15/日）；from-group 单组转卡保留为
// 人工/小拾触发的机械转换口；site:cand 纯数值门槛标注照旧（只标注不落卡）。
// watch 池 TTL 与平台适配精筛（初筛联动）保留，与出卡无关。
import type { Store } from "./store";
import { AppError } from "./errors";
import { hash, now } from "./store";
import { shanghaiDayOf } from "./tick-guard";
import { urlKey } from "./hotspots";
import { judgeVerdict, platformOf } from "./seen-judge";
import { valueScoreOf } from "./seo-gate";
import { termId } from "./seen-terms";
import { ATTENTION_LABELS, type TriageRecord } from "./triage-types"; // R10.27-C#19：从 types 载体导入（triage↔opportunity 环解耦）
import { FORM_MONETIZATION, FORM_KEYS, normalizeForm, PLATFORM_LABELS } from "./platforms";
import type { OpportunityForm } from "./platforms";

export type OpportunitySignal = "complaint" | "newtech" | "news" | "trend";
export type OpportunityKind = "site" | "app";
export type OpportunityVerdict = "推荐" | "可以试试" | "不值得做" | "待验证";
// 产品形态四值（第七轮批2 W7-5）：web=Web 应用 / app=App / miniprogram=小程序 / tool=工具站。
// 内容线机会卡（平台适配）无产品形态，form 缺省。
// 产品形态目录（六值+变现口径）唯一定义在 platforms.ts（客户端共享目录）；此处仅消费。

export const SIGNAL_LABELS: Record<OpportunitySignal, string> = {
  complaint: "用户抱怨",
  newtech: "新技术",
  news: "新资讯",
  trend: "热词趋势",
};
export const KIND_LABELS: Record<OpportunityKind, string> = { site: "站群/内容页", app: "应用" };


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
  // 变现口径（R10 六值配套；缺省按 FORM_MONETIZATION 推导）
  monetization?: string;
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
  // 双线互挂（R9-6⑥）：内容线卡 ↔ app 卡互相引用的对方卡 id（opp-*，确定性可预计算）
  relatedIds?: string[];
  source: "auto" | "agent";
  createdAt: string;
  updatedAt: string;
};

// 平台适配关键词（§1⑥b）：命中平台题材关键词的 watch 候选获得内容线机会二次精筛资格。
export const PLATFORM_FIT: Record<string, RegExp> = {
  gzh: /深度|分析|解读|复盘|报告|拆解|研究|观察|趋势|白皮书/i,
  tiebuhao: /突发|热搜|更新|发布|盘点|几件事|一次看完|快讯|速览|图解|一图|时间线/i,
  "xhs-note": /实测|教程|攻略|清单|避坑|手把手|指南|上手|合集/i,
  threads: /出海|海外|全球|GitHub|HN|HackerNews|开源|英文/i,
  // R10 第2段新增四平台（图文形态）：X=英文短评、LinkedIn=职场专业向、FB/IG=图文分享向
  x: /出海|海外|全球|launch|release|open.?source|GitHub|HN|英文|AI tool/i,
  facebook: /实用|分享|盘点|生活|技巧|how to|tips/i,
  instagram: /视觉|图片|设计|灵感|gallery|design|aesthetic/i,
  linkedin: /职场|专业|行业|career|enterprise|B2B|效率|团队/i,
};
// R9-3③：一条 watch 候选可命中多平台——返回全部命中平台（每平台一张机会卡），
// 不再 find 第一个即止；顺序跟随 affinity 传入序。
export function platformFitsOf(title: string, affinity: string[] | undefined): string[] {
  if (!affinity?.length) return [];
  return affinity.filter((p) => PLATFORM_FIT[p]?.test(title));
}
// 兼容保留：单平台命中（首个）。
export function platformFitOf(title: string, affinity: string[] | undefined): string | undefined {
  return platformFitsOf(title, affinity)[0];
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
// R10.12-3：单次出卡总量护栏（防任何生成器失控倾倒——3217 张教训）；
// 在 upsert 级拦截，任何生成器超限后新增直接跳过
export const OPPORTUNITY_DAILY_CAP = 200;
function upsert(db: Store, draft: Draft, counters: Counters) {
  // R10.12-3：总量护栏在 upsert 级拦截（生成器间检查不够——单个生成器内就能超限）
  if (counters.created >= OPPORTUNITY_DAILY_CAP) return;
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

export function upsertOpportunityDrafts(db: Store, drafts: Draft[], source: "auto" | "agent") {
  const counters: Counters = { created: 0, merged: 0, bySignal: { complaint: 0, newtech: 0, news: 0, trend: 0 } };
  for (const d of drafts) upsert(db, { ...d, source }, counters);
  return { created: counters.created, merged: counters.merged };
}

// 单组出卡草稿（R10.7 P0-2/P0-5）：generateFromGroups 与「转机会卡」写口共用。
// R10.25 口径：内容线选题走 outlines（大纲链路），不再产内容线机会卡——
// 只出 appGap 应用卡（id 由 dedupeKey 确定性预计算）。
export function groupOpportunityDrafts(g: NonNullable<TriageRecord["groups"][number]>, source: "auto" | "agent" = "agent") {
  const appId = g.appGap ? "opp-" + hash(`app:grp:${g.id}`).slice(0, 20) : undefined;
  if (!g.appGap || !appId) return [];
  const verdictReason = `注意力 ${ATTENTION_LABELS[g.attention]}（${(g.sources || []).join("/") || "AI 语义初筛"}）：${g.reason}`.slice(0, 160);
  const drafts: Draft[] = [{
    dedupeKey: `app:grp:${g.id}`, kind: "app", signals: ["news"],
    evidenceIds: [], url: g.representativeUrl, title: `${g.title.slice(0, 90)}｜应用缺口`,
    oneLiner: `应用缺口路线（AI 语义初筛）：${g.appGap.slice(0, 120)}`,
    form: "web-app", monetization: FORM_MONETIZATION["web-app"], verdict: "待验证",
    verdictReason, verifyPlan: [g.appGap.slice(0, 80), ...VERIFY.app(g.title)].slice(0, 4), source,
  }];
  return drafts;
}

// 外部 Agent 机会卡写口（R10.7 P0-5）：suggest 令牌直达 upsert（form 走严格六值归一）
export function writeAgentOpportunity(db: Store, draft: { title: string; oneLiner: string; form?: unknown; monetization?: string; signals?: unknown[]; url?: string; term?: string; verifyPlan?: string[] }) {
  // R10.11-4⑥：form 必填（Agent 不传 form 就是没想好形态——不给 kind 兜底猜测）
  const form = normalizeForm(draft.form);
  if (!form) throw new AppError(`产品形态（form）必填；允许值：${FORM_KEYS.join(", ")}`, 400);
  const signals = (Array.isArray(draft.signals) ? draft.signals : ["news"]).filter((x): x is OpportunitySignal => ["complaint", "newtech", "news", "trend"].includes(String(x)));
  const counters: Counters = { created: 0, merged: 0, bySignal: { complaint: 0, newtech: 0, news: 0, trend: 0 } };
  upsert(db, {
    dedupeKey: `agent:${hash(String(draft.title) + "|" + String(draft.url || draft.term || "")).slice(0, 24)}`,
    kind: form === "site-group" ? "site" : "app", // R10.15：form 已在路由层必填六值，此处仅按形态分 kind
    evidenceIds: [], signals: signals.length ? signals : ["news"], url: draft.url, term: draft.term, title: draft.title.slice(0, 120),
    oneLiner: draft.oneLiner.slice(0, 300), form, monetization: draft.monetization?.slice(0, 60),
    verdict: "待验证", verdictReason: "外部 Agent 写入（未经工作台规则验证）",
    verifyPlan: draft.verifyPlan?.slice(0, 4) || [], source: "agent",
  }, counters);
  return { ok: true, created: counters.created, merged: counters.merged };
}

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

export function watchTtlTick(db: Store, nowDate: Date = new Date()) {
  const day = shanghaiDayOf(nowDate); // R10.31：上海日
  if (db.get("meta", "watch-ttl-done:" + day)) return;
  const r = watchPoolMaintenance(db, { now: nowDate });
  db.put("meta", "watch-ttl-done:" + day, { at: now(), ...r });
  if (r.promoted || r.demoted) console.log(`[opportunity] watch 池 TTL：晋升 ${r.promoted} / 降级 ${r.demoted}（扫描 ${r.scanned}）`);
}
