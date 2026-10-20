// R10 第1+2 段：全量采集落盘 + 采集完自动语义初筛（老大 17:42 终版流水线）。
// 「所有的数据源全部采集全部落盘 → AI 做语义分析和分类筛选，判断价值后往选题方向和
//  应用机会方向推/标记 → 外部 agent/兜底内置 AI 完成最后分析与消费（无价值归档）→ 审查」
// · collectAllTick：每日 01:00（上海）读全部 enabled 内容源一次落盘（discovery，
//   jobId 按日命名）；计划的 sourceIds 退化为分析期过滤条件（迁移关停计划定时采集）。
// · 当日双闸：非当日数据 filtered（RSS 类 fallback 最近 24h）；watch 候选超上限按
//   「当日新 > 热度 > 源序」精简。
// · 采集完内联跑 triage（默认全开，config.aiPolicy.triage）——判级/归组/双线草案复用
//   R9-6 管线；none 组进归档队列（triage-archive 集合，可查可恢复），不静默留池。
import type { Store } from "./store";
import { now } from "./store";
import type { Source } from "./schema";
import type { DiscoveryCandidate, DiscoveryRecord, SourceCoverage } from "./discovery";
import { readSourceEvidence, candidateFromItem } from "./sources";
import { runTriage, applyTriageResult, archiveNoneGroups, triagePoolOf, defaultTriageRunner, markTriageFailed, COLLECT_ALL_PLAN_NAME, defaultTriagePlan, type TriageRunner, type TriageRecord } from "./triage";
import { shanghaiDay } from "./model-metrics";

export const COLLECT_ALL_LIMIT = 300;

export function collectAllJobId(day: string = shanghaiDay()): string {
  return "collectall-" + day;
}

function isSameShanghaiDay(iso: string | undefined): boolean {
  if (!iso || !Number.isFinite(Date.parse(iso))) return false;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(iso)) === shanghaiDay();
  } catch { return false; }
}

// 热度解析：热榜 metric.value 形如 "1,234,567" / "+1.2万" / "12.3K"；解析失败按 0
function heatOf(c: DiscoveryCandidate): number {
  const raw = c.metric?.value;
  if (!raw) return 0;
  const m = String(raw).replace(/[,，\s+]/g, "").match(/^([\d.]+)(万|w|k|K)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.round(m[2] === "万" || m[2] === "w" ? n * 10000 : m[2] ? n * 1000 : n);
}

function recencyOf(c: DiscoveryCandidate): number {
  const t = Date.parse(c.publishedAt || c.observedAt || "");
  return Number.isFinite(t) ? t : 0;
}

type SourceReader = typeof readSourceEvidence;
// reader 可注入（测试用 mock 源数据；生产缺省真实读取）
export async function collectAllTick(db: Store, runner: TriageRunner = defaultTriageRunner, reader: SourceReader = readSourceEvidence, nowDate: Date = new Date()): Promise<void> {
  const day = shanghaiDay();
  const doneKey = "collect-all-done:" + day;
  if (db.get("meta", doneKey)) return;
  // 每日凌晨一次：01:00（上海）起跑；nowDate 可注入（测试避开 00:00-01:00 的静默窗）
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(nowDate));
  if (hour < 1) return;
  const jobId = collectAllJobId(day);
  if (db.get("discovery", jobId)) { db.put("meta", doneKey, { at: now(), skipped: "already-collected" }); return; }
  const sources = db.list<Source>("sources").filter((s) => s.enabled && s.type !== "web");
  const candidates: DiscoveryCandidate[] = [];
  const coverage: SourceCoverage[] = [];
  const seenUrls = new Set<string>(); // URL 级去重（跨源同 URL 只留首个来源；语义重复归组交给初筛）
  const started = Date.now();
  for (const s of sources) {
    try {
      const { items, warnings } = await reader(s, 7, AbortSignal.timeout(120000));
      let sameDayCount = 0; // P0-3：每源独立计数（原用跨源累计 candidates.length，覆盖页显示失真）
      for (const [index, item] of items.entries()) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        const ts = item.publishedAt || item.collectedAt;
        const sameDay = isSameShanghaiDay(ts) || (s.type === "rss" && Number.isFinite(Date.parse(ts || "")) && Date.now() - Date.parse(ts!) < 24 * 3600000);
        if (sameDay) sameDayCount++;
        candidates.push(candidateFromItem(item, s.id, s.name, index, sameDay ? "watch" : "filtered", sameDay ? "当日数据，进入语义初筛" : "非当日数据"));
      }
      coverage.push({ sourceId: s.id, sourceName: s.name, status: "ok", raw: items.length, matched: sameDayCount, selected: 0 });
      for (const w of warnings) console.warn("[collect-all]", w);
    } catch (e) {
      coverage.push({ sourceId: s.id, sourceName: s.name, status: "failed", raw: 0, matched: 0, selected: 0, error: e instanceof Error ? e.message : "读取失败" });
    }
  }
  // 当日精简闸：超上限按「同源归一热度 > 原始热度 > 稳定源序」保留前 N。
  // R10.6 双修正：①原始热度跨源量纲不可比（百度「百万」碾压 aihot 信号「65」）——
  // 每源内部按热度排名折算 0..1；②毫秒级采集时序会劫持「新度」（后读的源包揽全部
  // 名额，实测 300 席被最后 8 源吞掉）——当日闸已保证同日新鲜，新度不再参与排序，
  // 源序兜底天然跨源交错。
  const watch = candidates.filter((c) => c.status === "watch");
  const heatRank = new Map<string, number>();
  {
    const bySource = new Map<string, DiscoveryCandidate[]>();
    for (const c of watch) { const l = bySource.get(c.sourceId) || []; l.push(c); bySource.set(c.sourceId, l); }
    for (const list of bySource.values()) {
      list.sort((a, b) => heatOf(b) - heatOf(a));
      list.forEach((c, idx) => heatRank.set(c.url, list.length > 1 ? (list.length - idx) / list.length : 1));
    }
  }
  let trimmed = 0;
  if (watch.length > COLLECT_ALL_LIMIT) {
    const keep = new Set(
      watch
        .map((c, i) => ({ c, i }))
        .sort((a, b) => (heatRank.get(b.c.url) ?? 0) - (heatRank.get(a.c.url) ?? 0) || heatOf(b.c) - heatOf(a.c) || a.i - b.i)
        .slice(0, COLLECT_ALL_LIMIT)
        .map((x) => x.c.url),
    );
    for (const c of candidates) {
      if (c.status === "watch" && !keep.has(c.url)) { c.status = "filtered"; c.reason = `超出当日精简上限（${COLLECT_ALL_LIMIT}）`; trimmed++; }
    }
  }
  const record: DiscoveryRecord = { jobId, at: now(), planName: COLLECT_ALL_PLAN_NAME, candidates, sources: coverage, limit: COLLECT_ALL_LIMIT, mode: "analysis" };
  db.put("discovery", jobId, record);
  db.put("meta", doneKey, { at: now(), sources: sources.length, raw: candidates.length, trimmed, durationMs: Date.now() - started });
  console.log(`[collect-all] ${day}：${sources.length} 源 ${candidates.length} 条（精简 ${trimmed}）落盘，用时 ${Math.round((Date.now() - started) / 1000)}s`);
  // R10.20-A3 注释更新：consumerMode 决定整套链——external=采集落盘即止（语义处理由
  // 外部 Agent 02:00 全套完成），builtin=内置 AI 跑全套。appGap 转卡在 builtin 门内。
  // 不新增第三种机制，无自动兜底。
  const consumerMode = db.get<any>("config", "consumerMode") || "external";
  const global = db.get<any>("config", "aiPolicy");
  if (consumerMode === "builtin" && (global?.triage ?? "off") !== "off") {
    try {
      const pool = triagePoolOf(candidates);
      if (pool.length >= 8) {
        const triage = await runTriage(db, defaultTriagePlan(), jobId, pool, new AbortController().signal, runner);
        applyTriageResult(db, record, triage);
        const archived = archiveNoneGroups(db, jobId, triage);
        // P0-3：初筛后回填每源 selected（判级=入模），覆盖页入模率不再恒 0
        const judgedBySource = new Map<string, number>();
        for (const c of record.candidates) if (c.attention) judgedBySource.set(c.sourceId, (judgedBySource.get(c.sourceId) || 0) + 1);
        const live = db.get<DiscoveryRecord>("discovery", jobId);
        if (live) {
          for (const cov of live.sources) cov.selected = judgedBySource.get(cov.sourceId) || 0;
          db.put("discovery", jobId, live);
        }
        console.log(`[collect-all] 语义初筛：${triage.groups.length} 组（强 ${triage.groups.filter((g) => g.attention === "strong").length}/潜 ${triage.groups.filter((g) => g.attention === "potential").length}），归档 ${archived.archived} 组（${archived.candidates} 条）`);
        // R10.20-A3：appGap 转卡在 builtin 门内（R10.19 后 external 由 Agent 直接写机会卡）
        const { generateOpportunities } = await import("./opportunity");
        const gen = generateOpportunities(db, { source: "auto" });
        if (gen.created) console.log(`[collect-all] 机会卡自动生成：新增 ${gen.created} / 合并 ${gen.merged}`);
      }
    } catch (e) {
      // R10.2②：失败留痕与 collect() 同款——triage-fail 键 + 候选「待语义初筛」标注（tick 补跑机制凭此发现）
      markTriageFailed(db, db.get("discovery", jobId) || record, e);
      console.error("[collect-all] 语义初筛失败（已标待补跑）:", e instanceof Error ? e.message : e);
    }
  }
}
