// 预算自检（R9-7①）：每小时对账当日 budgets.reserved 与台账实耗，
// 泄漏（中断调用保留的全额预留——停电/进程被杀时结算永远不会发生）超阈值即回收并告警。
// 对账口径：Σcharged 的近似 = 台账 tokens×1.25 + 500×calls（settle 的 charged=max(u+500,1.2u) 的保守包络）。
import type { Store } from "./store";
import { now } from "./store";
import { shanghaiDay } from "./model-metrics";

// 泄漏超过单次调用预留上限（requestModel 硬拒 >200k）仍存在 → 必然是历史泄漏，回收；
// 超过告警线但未达回收线 → 只打日志（可能是在途调用的瞬态预留）。
export const RESCUE_THRESHOLD = 200_000;
export const ALERT_THRESHOLD = 50_000;

export function budgetAuditTick(db: Store, nowDate: Date = new Date()) {
  const hour = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).format(nowDate);
  const gateKey = "budget-audit:" + hour;
  if (db.get("meta", gateKey)) return;
  db.put("meta", gateKey, { at: now() });
  const usage = db.get<any>("model-metrics", shanghaiDay());
  const tokens = usage?.tokens ?? 0;
  const calls = usage?.calls ?? 0;
  const expected = Math.ceil(tokens * 1.25) + calls * 500;
  const budget = db.dayBudget();
  const leak = budget.reserved - expected;
  if (leak > RESCUE_THRESHOLD) {
    db.rescueReserved(budget.day, expected);
    console.warn(`[budget-audit] 回收泄漏预留 ${leak}：reserved ${budget.reserved} → ${expected}（台账实耗 ${tokens}/${calls} 次口径）。疑似中断调用/进程被杀遗留。`);
  } else if (leak > ALERT_THRESHOLD) {
    console.warn(`[budget-audit] 预算偏差 ${leak}（reserved ${budget.reserved} vs 台账口径 ${expected}）：未达回收阈值 ${RESCUE_THRESHOLD}，仅告警不动作（可能为在途调用瞬态预留）。`);
  }
}
