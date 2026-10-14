// 研究任务后台循环（信息架构 v2-挂载根治：worker 容器并入 app 进程）。
// 单进程单 SQLite 连接：消除双进程跨 Windows 挂载的 WAL 竞争与页缓存失谐
//（2026-10-01 页级损坏、10-10 三发挂载异常的根因类）。
// 启动入口：根目录 instrumentation.ts（Next 服务启动时注册，构建期与测试不触发）。
import type { Store } from "../core/store";
import { now } from "../core/store";
import { recoverOrphanJobs, runJob, scheduleTick } from "../core/pipeline";
import { seenTermsTick } from "../core/seen-extract";
import { judgeBackfillTick } from "../core/seen-extract";
import { seenDiggingTick } from "../core/seen-dig";
import { seenJudgeTick, seoMetricsTick } from "../core/seen-judge";
import { opportunityTick, watchTtlTick } from "../core/opportunity";
import { siteLaunchesTick } from "../core/site-launches";
import { rootProbeTick } from "../core/seen-dig";
import { trendsRisingTick, benchmarkSitesTick, linkProspectsTick, newWordsTick } from "../core/gephei-collect";
import { outlineCategoryTick } from "../core/outline-categorize";
import { outlineDraftTick } from "../core/outline-draft";
import { requestModel } from "../core/model";
import { runJanitor } from "../core/janitor";

const g = globalThis as unknown as { __draftdeskWorker?: { stopping: boolean } };

export function startWorkerLoop(db: Store) {
  if (g.__draftdeskWorker) return g.__draftdeskWorker;
  const state = { stopping: false };
  g.__draftdeskWorker = state;
  recoverOrphanJobs(db);
  console.log("[worker] 研究任务循环启动（单进程模式）");
  (async () => {
    while (!state.stopping) {
      try {
        db.put("meta", "worker", { heartbeat: now(), pid: process.pid });
        scheduleTick(db);
        seenTermsTick(db, requestModel);
        // 判定吞吐扩容（第五轮 §5）：relevance 回填判定日多批（积压 7112 → 48h <2000 的反推口径）
        judgeBackfillTick(db, requestModel);
        seenDiggingTick(db);
        // 词根探针（第五轮批 2b）：34 工具词根+AI 词根轮转喂联想，≤48 词/日不冲判定重档
        rootProbeTick(db);
        // 选题题材标注（第六轮批 A）：存量 outlines 六类一次性回填（cheap 档，初筛不受 consumerMode 门控）
        outlineCategoryTick(db, requestModel);
        // 双端兜底链（第六轮批 B §2④）：builtin 模式 approved → 自动第一版大纲 → drafting；
        // external 模式此 tick 零动作（大纲由外部 Agent 写）。
        outlineDraftTick(db, requestModel);
        seenJudgeTick(db);
        // 哥飞指标日更（第七轮批3 W7-8；批4 双门控：autoMetrics 勾选才调付费接口，月池 30+obs≥5）
        seoMetricsTick(db);
        // 新词发现批次（批4 W7-11③，0 积分免费保留自动）：latest 批次注入 seen-terms
        newWordsTick(db);
        // 哥飞挖需求采集组（第七轮批3 W7-9）：趋势周更（周日）/标杆站月更（1 日）/外链反推（15 日），
        // collect 池记账；开关关闭=零调用（初筛采集，不受 consumerMode 门控）
        trendsRisingTick(db);
        benchmarkSitesTick(db);
        linkProspectsTick(db);
        // 新站发现（第五轮 §2）：Show HN + PH 结构化抓取 + cheap 档六类判定（初筛，不受 consumerMode 门控）
        siteLaunchesTick(db, requestModel);
        // 机会引擎（第五轮）：watch 池 TTL 是初筛的一部分（不受 consumerMode 影响）；
        // 机会自动生成仅 builtin 模式（external 由外部 Agent 经 /opportunities/generate 触发）。
        watchTtlTick(db);
        opportunityTick(db);
        runJanitor(db);
        const job = db.claim();
        if (job) await runJob(db, job);
        else await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.error("[worker] tick 异常:", e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 5000));
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
