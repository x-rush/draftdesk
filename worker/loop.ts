// 研究任务后台循环（信息架构 v2-挂载根治：worker 容器并入 app 进程）。
// 单进程单 SQLite 连接：消除双进程跨 Windows 挂载的 WAL 竞争与页缓存失谐
//（2026-10-01 页级损坏、10-10 三发挂载异常的根因类）。
// 启动入口：根目录 instrumentation.ts（Next 服务启动时注册，构建期与测试不触发）。
//
// R10.33 日批模式（老大 2026-10-28 17:19 拍板：彻底一天一次）：
// 心智模型=每日两任务——01:00 工作台日批（采集 + 全部日粒度任务一次跑完，外联集中夜间）
// → 02:00 外部 Agent 语义处理。白天循环只剩心跳 + 日批标记查询 + 任务认领，CPU 空闲趋零；
// 夜间窗口（01:00-08:00）内多批 tick（判定回填/词判定）仍按各自 gap 获得多轮机会
//（4h 间隔 → 05:00 第二批），白天不唤醒。手动口（UI「立即整理/立即抓取」等）随时响应。
import type { Store } from "../core/store";
import { now } from "../core/store";
import { recoverOrphanJobs, runJob } from "../core/pipeline";
import { seenTermsTick } from "../core/seen-extract";
import { judgeBackfillTick } from "../core/seen-extract";
import { seenDiggingTick } from "../core/seen-dig";
import { seenJudgeTick } from "../core/seen-judge";
import { seoMetricsTick } from "../core/seo-gate";
import { opportunityTick, watchTtlTick } from "../core/opportunity";
import { triageTick } from "../core/triage";
import { siteLaunchesTick } from "../core/site-launches";
import { rootProbeTick } from "../core/seen-dig";
import { trendsRisingTick, benchmarkSitesTick, linkProspectsTick, newWordsTick } from "../core/gephei-collect";
import { infoReflowTick } from "../core/info-reflow";
import { outlineCategoryTick } from "../core/outline-categorize";
import { outlineDraftTick, ensureTiebuhaoClones } from "../core/outline-draft";
import { requestModel } from "../core/model";
import { budgetAuditTick } from "../core/budget-audit";
import { collectAllTick } from "../core/collect-all";
import { runJanitor } from "../core/janitor";
import { shanghaiDayOf } from "../core/tick-guard";

const g = globalThis as unknown as { __draftdeskWorker?: { stopping: boolean } };

// 夜间窗口（上海时）：日批 + 多批追赶都在这个窗口内发生；窗口外白天纯静默
const NIGHT_START_HOUR = 1;
const NIGHT_END_HOUR = 8;
const DAY_BATCH_KEY = "day-batch-done:";
const IDLE_SLEEP_MS = 5000;

function shanghaiHour(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(d));
}

// 手动口待处理判定：只认「尚未被对应 tick 消费」的请求——
// triage-request/site-launches-manual/seen-dig-manual 由 tick 自删；
// seen-terms-manual 永不删除（靠提取 done 闸去重），故与当日 done 时间戳比较。
function pendingManual(db: Store, day: string): boolean {
  if (db.get("meta", "triage-request")) return true;
  if (db.get("meta", "site-launches-manual")) return true;
  if (db.get("meta", "seen-dig-manual")) return true;
  const m = db.get<any>("meta", "seen-terms-manual");
  if (m && m.date === day) {
    const done = db.get<any>("meta", "seen-terms-extract-done:" + day);
    if (!done || String(done.at || "") < String(m.at || "")) return true;
  }
  return false;
}

// 日批任务链：采集 → 全部日粒度任务一次跑完（各 tick 自带日闸，重复调用自动秒退）
async function runDailyChain(db: Store): Promise<void> {
  // 第1段：采集落盘（自带 01:00 闸 + 当日 done 闸 + running 锁 + 失败当日放弃）
  await collectAllTick(db);
  seenTermsTick(db, requestModel);
  // 判定回填（积压清空）：【采集侧豁免·R10.25-1】external 照跑，cheap 档台账公开
  judgeBackfillTick(db, requestModel);
  seenDiggingTick(db);
  // 词根探针：34 工具词根+AI 词根轮转喂联想
  rootProbeTick(db);
  // 选题题材标注：【采集侧豁免·R10.25-1】
  outlineCategoryTick(db, requestModel);
  // 资讯类簇强制覆盖贴图号：库内克隆不耗模型
  ensureTiebuhaoClones(db);
  // info 型强词回流内容线
  infoReflowTick(db);
  // 双端兜底链：builtin approved → 自动大纲；external 零动作
  outlineDraftTick(db, requestModel);
  // 词判定：【采集侧豁免·R10.25-1】
  seenJudgeTick(db);
  // 哥飞指标日更（双门控：autoMetrics 勾选 + 月池/obs 门槛）
  seoMetricsTick(db);
  // 免费新词批次注入
  newWordsTick(db);
  // 哥飞挖需求：趋势周更 / 标杆站月更 / 外链反推半月
  trendsRisingTick(db);
  benchmarkSitesTick(db);
  linkProspectsTick(db);
  // 新站发现（六类判定）：【采集侧豁免·R10.25-1】
  siteLaunchesTick(db, requestModel);
  // watch 池 TTL（初筛的一部分，不受 consumerMode 影响）
  watchTtlTick(db);
  // 语义初筛补跑（builtin 才有动作）+ 机会自动生成（builtin）
  await triageTick(db);
  opportunityTick(db);
  // 预算对账：R10.33 从每小时降为日批尾部一次（对账逻辑不变）
  budgetAuditTick(db);
  runJanitor(db);
}

// 日批决策（R10.33，时钟注入可测）：
//   "manual"     = 有未消费的手动请求 → 跑链（不标日批完成，真实 01:00 批照常执行）
//   "chain"      = 当日日批未完成 → 跑链并标完成（夜间正常起跑；白天=重启补跑不漏批）
//   "multibatch" = 日批已完成且在夜间窗口 → 只跑多批 tick（各自 gap 闸决定是否真跑）
//   "idle"       = 白天且日批已完成（或凌晨 0 点前）→ 只心跳+认领
export function dayBatchDecision(
  db: Store, nowDate: Date = new Date(),
): { action: "manual" | "chain" | "multibatch" | "idle"; day: string; hour: number } {
  const day = shanghaiDayOf(nowDate);
  const hour = shanghaiHour(nowDate);
  const batchDone = !!db.get("meta", DAY_BATCH_KEY + day);
  const manual = pendingManual(db, day);
  const night = hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
  if (manual) return { action: "manual", day, hour };
  if (!batchDone && hour >= NIGHT_START_HOUR) return { action: "chain", day, hour };
  if (batchDone && night) return { action: "multibatch", day, hour };
  return { action: "idle", day, hour };
}

export function markDayBatchDone(db: Store, day: string, hour: number): void {
  db.put("meta", DAY_BATCH_KEY + day, { at: now(), hour, pid: process.pid });
}

export function startWorkerLoop(db: Store) {
  if (g.__draftdeskWorker) return g.__draftdeskWorker;
  const state = { stopping: false };
  g.__draftdeskWorker = state;
  recoverOrphanJobs(db);
  console.log("[worker] 研究任务循环启动（单进程 · 日批模式）");
  (async () => {
    while (!state.stopping) {
      let ranBatch = false;
      try {
        db.put("meta", "worker", { heartbeat: now(), pid: process.pid });
        const { action, day, hour } = dayBatchDecision(db);

        if (action === "manual") {
          await runDailyChain(db);
          ranBatch = true;
        } else if (action === "chain") {
          await runDailyChain(db);
          markDayBatchDone(db, day, hour);
          ranBatch = true;
        } else if (action === "multibatch") {
          // 夜间多批追赶：只跑多批 tick（白天不进来）
          judgeBackfillTick(db, requestModel);
          seenJudgeTick(db);
        }

        const job = db.claim();
        if (job) {
          await runJob(db, job);
          continue; // 有任务立刻接下一轮
        }
        if (!ranBatch) await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
      } catch (e) {
        console.error("[worker] tick 异常:", e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
    db.close();
  })();
  return state;
}

export function stopWorkerLoop() {
  const state = g.__draftdeskWorker;
  if (state) state.stopping = true;
}
