// 模型调用台账（成本纪律批 7）：requestModel 每次成功调用后按日（上海时区）
// 记 calls/tokens，cheap/full 分档拆分，cheap→full 升级单列。
// 看板口径：今日 tokens 超 昨日×1.5 由 UI 标黄；表只是台账，不做限额（限额仍走 budgets）。
import type { Store } from "./store";

export type ModelPlan = "cheap" | "full";

export function shanghaiDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date(Date.now() - offsetDays * 86400000));
}

type Ledger = {
  id: string; calls: number; tokens: number;
  byPlan: { cheap: { calls: number; tokens: number }; full: { calls: number; tokens: number } };
  upgrades: number;
};

function emptyLedger(day: string): Ledger {
  return { id: day, calls: 0, tokens: 0, byPlan: { cheap: { calls: 0, tokens: 0 }, full: { calls: 0, tokens: 0 } }, upgrades: 0 };
}

export function recordModelMetrics(db: Store, plan: ModelPlan, usage: number) {
  const day = shanghaiDay();
  const prev = db.get<Ledger>("model-metrics", day) || emptyLedger(day);
  const next: Ledger = {
    ...prev,
    calls: prev.calls + 1,
    tokens: prev.tokens + usage,
    byPlan: {
      ...prev.byPlan,
      [plan]: {
        calls: (prev.byPlan[plan]?.calls || 0) + 1,
        tokens: (prev.byPlan[plan]?.tokens || 0) + usage,
      },
    },
  };
  db.put("model-metrics", day, next);
}

export function recordModelUpgrade(db: Store) {
  const day = shanghaiDay();
  const prev = db.get<Ledger>("model-metrics", day) || emptyLedger(day);
  db.put("model-metrics", day, { ...prev, upgrades: prev.upgrades + 1 });
}

// 近 N 天台账（看板路由）：新→旧。
export function recentModelMetrics(db: Store, days: number): Ledger[] {
  const out: Ledger[] = [];
  for (let i = 0; i < days; i++) {
    const day = shanghaiDay(i);
    out.push(db.get<Ledger>("model-metrics", day) || emptyLedger(day));
  }
  return out;
}
