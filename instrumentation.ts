// Next.js 服务启动钩子：在 nodejs 运行时启动研究任务后台循环（单进程模式）。
// 规避 Docker Desktop Windows 挂载的双进程 SQLite 竞争（见 database/README.md）。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.DRAFTDESK_EMBEDDED_WORKER === "0") return;
  const { startWorkerLoop } = await import("./worker/loop");
  const { store } = await import("./core/store");
  const { recoverOrphanJobs } = await import("./core/pipeline");
  const db = store();
  const n = recoverOrphanJobs(db);
  if (n) console.log("[startup] 孤儿任务回收:", n, "条置回 queued");
  startWorkerLoop(db);
}
