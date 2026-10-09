// 模型预算域：按天（上海时区）预留/结算。上限来自配置域（参数注入）。
// 结算以 provider 回报的实际用量为唯一依据；未知用量与中断调用保留全额预留。
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
          "INSERT INTO budgets(day,reserved) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET reserved=reserved+excluded.reserved",
        )
        .run(b.day, tokens);
    },
    settleReservation(day: string, reservation: number, usage: number, jobId?: string) {
      // A provider-reported usage total is the only basis for returning unused
      // headroom. Unknown usage and interrupted calls keep the full reservation.
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
  };
}

export type Budget = ReturnType<typeof createBudget>;
