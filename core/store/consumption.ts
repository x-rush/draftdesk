// 消费标记域：不删除原始记录，只加状态层；幂等；dryRun 只统计不写入；撤销窗口 30 天。
import { now } from "./helpers";
import type { KV } from "./kv";

export function createConsumption(kv: KV) {
  return {
    consumeIdentities(target: "hotspots" | "evidence", identities: string[], reason: string, consumedBy: string, producedRef?: string, dryRun = false) {
      let toConsume = 0, alreadyConsumed = 0;
      const run = (write: boolean) => {
        const stamp = now(), unconsumeUntil = new Date(Date.parse(stamp) + 30 * 86400000).toISOString();
        for (const identity of identities) {
          const id = `${target}:${identity}`;
          if (kv.get("consumption", id)) { alreadyConsumed++; continue; }
          if (!write) { toConsume++; continue; }
          kv.put("consumption", id, { target, identity, reason, producedRef: producedRef || null, consumedBy, consumedAt: stamp, unconsumeUntil });
          toConsume++;
        }
      };
      if (dryRun) run(false);
      else kv.transaction(() => run(true));
      return { ok: true, dryRun, target, toConsume, alreadyConsumed,
        notice: "消费仅改变可见性与计数，不删除原始记录；30 天内可 unconsume。" };
    },
    unconsumeIdentities(target: "hotspots" | "evidence", identities: string[], dryRun = false) {
      let revived = 0, expired = 0, notFound = 0;
      const stamp = now();
      const run = (write: boolean) => {
        for (const identity of identities) {
          const c = kv.get<any>("consumption", `${target}:${identity}`);
          if (!c) { notFound++; continue; }
          if (c.unconsumeUntil <= stamp) { expired++; continue; }
          if (write) kv.del("consumption", `${target}:${identity}`);
          revived++;
        }
      };
      if (dryRun) run(false);
      else kv.transaction(() => run(true));
      // ok=false 时调用方应区分 notFound（已被撤销过或从未消费——决策翻转场景常见）与 expired（真超窗）
      return { ok: dryRun || revived > 0, dryRun, target, revived, expired, notFound, notice: "超过 30 天撤销窗口的条目已软化处理，不再计入未消费。" };
    },
  };
}

export type Consumption = ReturnType<typeof createConsumption>;
