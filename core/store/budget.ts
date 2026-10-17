// 模型预算域：按天（上海时区）预留/结算。上限来自配置域（参数注入）。
// 结算以 provider 回报的实际用量为唯一依据；调用失败/中止走 releaseReservation 全额退预留
//（R9-7① 前中断调用保留全额预留，停电曾把当日 reserved 挤死）。
import { AppError } from "../errors";
import type { KV } from "./kv";
import type { Config, Job } from "../schema";

export function createBudget(kv: KV, config: () => Config) {
  return {
    dayBudget() {
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
      }).format(new Date());
      const row = kv.db
        .prepare("SELECT reserved FROM budgets WHERE day=?")
        .get(day) as { reserved: number } | undefined;
      return {
        day,
        reserved: row?.reserved || 0,
        limit: config().dailyTokenLimit,
      };
    },
    reserve(tokens: number) {
      const b = this.dayBudget();
      if (b.reserved + tokens > b.limit)
        throw new AppError(
          "今日模型预算不足；可明日再运行，或在设置调整上限。",
          429,
        );
      kv.db
        .prepare(
          // used 必须显式给 0：schema NOT NULL 无默认。历史库的当日行由旧数据
          // 遮住了这条路径（雕刻重建/fresh clone 的每个新一天首次 reserve 必踩）。
          "INSERT INTO budgets(day,reserved,used) VALUES(?,?,0) ON CONFLICT(day) DO UPDATE SET reserved=reserved+excluded.reserved",
        )
        .run(b.day, tokens);
    },
    settleReservation(day: string, reservation: number, usage: number, jobId?: string) {
      // 成功路径：按 provider 回报的实际用量多退少补（charged ≥ usage×1.2）。
      if (!Number.isSafeInteger(usage) || usage <= 0) return;
      const charged = Math.max(usage + 500, Math.ceil(usage * 1.2));
      const delta = charged - reservation;
      kv.transaction(() => {
        kv.db.prepare("UPDATE budgets SET reserved=MAX(0,reserved+?) WHERE day=?").run(delta, day);
        if (jobId) {
          const job = kv.get<Job>("jobs", jobId);
          if (job) kv.put("jobs", jobId, {
            ...job,
            reservedTokens: Math.max(0, job.reservedTokens + delta),
            actualTokens: job.actualTokens + usage,
          });
        }
      });
    },
    // 中断释放（R9-7①）：失败/中止/超时的调用全额退预留，日内余量不被挂死挤占。
    releaseReservation(day: string, reservation: number, jobId?: string) {
      kv.transaction(() => {
        kv.db.prepare("UPDATE budgets SET reserved=MAX(0,reserved-?) WHERE day=?").run(reservation, day);
        if (jobId) {
          const job = kv.get<Job>("jobs", jobId);
          if (job) kv.put("jobs", jobId, { ...job, reservedTokens: Math.max(0, job.reservedTokens - reservation) });
        }
      });
    },
    // 泄漏回收（R9-7①）：对账认定泄漏后把当日行拉回台账口径——只能下调，不能凭空加钱。
    rescueReserved(day: string, target: number) {
      kv.db
        .prepare("UPDATE budgets SET reserved=MIN(reserved,MAX(0,?)) WHERE day=?")
        .run(target, day);
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
