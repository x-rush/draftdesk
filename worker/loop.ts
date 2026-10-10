// 研究任务后台循环（信息架构 v2-挂载根治：worker 容器并入 app 进程）。
// 单进程单 SQLite 连接：消除双进程跨 Windows 挂载的 WAL 竞争与页缓存失谐
//（2026-10-01 页级损坏、10-10 三发挂载异常的根因类）。
// 启动入口：根目录 instrumentation.ts（Next 服务启动时注册，构建期与测试不触发）。
import type { Store } from "../core/store";
import { now } from "../core/store";
import { recoverOrphanJobs, runJob, scheduleTick } from "../core/pipeline";
import { seenTermsTick } from "../core/seen-extract";
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
