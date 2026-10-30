// 运维手动口（R10.40 本地开发环境配套）：worker 被关闭（DRAFTDESK_EMBEDDED_WORKER=0）后，
// 「手动跑一次日批」的唯一入口。POST 触发（202 立即返回，链在后台跑），GET 查状态。
// 日批链各 tick 自带日闸/running 锁——手动触发与真实 01:00 批同语义：当天已跑的环节自动跳过，
// 不会重复采集/重复付费（总纲「每源每日只采一次」不变）。
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";
import type { Store } from "../store";

const LOCK_KEY = "maintenance-running";
const LOCK_STALE_MS = 30 * 60000;

function lockState(db: Store): { running: boolean; stale: boolean; startedAt?: string } {
  const lock = db.get<any>("meta", LOCK_KEY);
  if (!lock?.at) return { running: false, stale: false };
  const stale = Date.now() - Date.parse(lock.at) > LOCK_STALE_MS;
  return { running: !stale, stale, startedAt: lock.at };
}

export const routes: RouteDef[] = [
  {
    methods: ["GET"],
    pattern: "maintenance/run-daily",
    handler: ({ db }) => {
      const lock = lockState(db);
      return json({ ...lock, lastRun: db.get<any>("meta", "maintenance-last-run") || null });
    },
  },
  {
    methods: ["POST"],
    pattern: "maintenance/run-daily",
    handler: ({ db }) => {
      const lock = lockState(db);
      if (lock.running) throw new AppError(`日批手动触发已在运行（${lock.startedAt}），等待完成即可。`, 409, "MAINTENANCE_RUNNING");
      db.put("meta", LOCK_KEY, { at: now() });
      // 测试缝：注入桩替换真实日批链（真实链含外呼，测试环境绝不真跑）
      void (async () => {
        try {
          const mod = await import("../../worker/loop");
          const runner = (globalThis as any).__draftdeskDailyChainRunner || mod.runDailyChain;
          await runner(db);
          db.put("meta", "maintenance-last-run", { at: now(), ok: true });
        } catch (e) {
          db.put("meta", "maintenance-last-run", { at: now(), ok: false, error: String(e).slice(0, 300) });
        } finally {
          db.del("meta", LOCK_KEY);
        }
      })();
      return json({ started: true, note: "日批链后台运行中（各环节受当日闸约束，已跑环节自动跳过）；GET maintenance/run-daily 查状态。" }, 202);
    },
  },
];
