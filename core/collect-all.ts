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


export function collectAllJobId(day: string = shanghaiDay()): string {
  return "collectall-" + day;
}

function isSameShanghaiDay(iso: string | undefined): boolean {
  if (!iso || !Number.isFinite(Date.parse(iso))) return false;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(iso)) === shanghaiDay();
  } catch { return false; }
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
  // R10.27-C#18：running 锁 + 失败退避——原实现失败后 done 键未写，worker 下一轮（1.5s）
  // 立即全量重采无退避；与其他 tick「失败即当日放弃」语义相反。现统一：失败写 done+error
  // 当日放弃（次日自然重试），running 锁 30 分钟防循环重入（loop 改并发也安全）
  const jobId = collectAllJobId(day);
  const running = db.get<any>("meta", "collect-all-running");
  if (running && Date.now() - Date.parse(running.at) < 30 * 60000) return;
  db.put("meta", "collect-all-running", { at: new Date().toISOString() });
  try {
    await runCollectAll(db, { day, doneKey, jobId, runner, reader, nowDate });
  } catch (e) {
    console.error("[collect-all] 全量采集失败（当日放弃，次日重试）:", e instanceof Error ? e.message : e);
    db.put("meta", doneKey, { at: now(), error: String(e instanceof Error ? e.message : e).slice(0, 200) });
  } finally {
    db.del("meta", "collect-all-running");
  }
}

async function runCollectAll(db: Store, ctx: { day: string; doneKey: string; jobId: string; runner: TriageRunner; reader: SourceReader; nowDate: Date }): Promise<void> {
  const { day, doneKey, jobId, runner, reader, nowDate } = ctx;
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
  // R10.28：采集侧精简闸已删（builtin 时代给内置初筛限流的历史产物；external 下外部
  // Agent 全量语义处理，闸只剩误伤——当日 watch 候选全部保留，「非当日→filtered」跨日去重语义不变）
  const record: DiscoveryRecord = { jobId, at: now(), planName: COLLECT_ALL_PLAN_NAME, candidates, sources: coverage, mode: "analysis" };
  db.put("discovery", jobId, record);
  db.put("meta", doneKey, { at: now(), sources: sources.length, raw: candidates.length, watch: candidates.filter((c) => c.status === "watch").length, durationMs: Date.now() - started });
  console.log(`[collect-all] ${day}：${sources.length} 源 ${candidates.length} 条（watch ${candidates.filter((c) => c.status === "watch").length}）落盘，用时 ${Math.round((Date.now() - started) / 1000)}s`);
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
      }
    } catch (e) {
      // R10.2②：失败留痕与 collect() 同款——triage-fail 键 + 候选「待语义初筛」标注（tick 补跑机制凭此发现）
      markTriageFailed(db, db.get("discovery", jobId) || record, e);
      console.error("[collect-all] 语义初筛失败（已标待补跑）:", e instanceof Error ? e.message : e);
    }
  }
}
