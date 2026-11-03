// tick 守卫统一（R10.27-C#17）——「done 日闸 + running 锁 + finally 释放」的单一实现。
// 此前 13 个带锁 tick 手写 15 份变体：锁 TTL 5 种（10/15/20/30/45min 补丁式调参）、
// done 键 4 种形态、UTC/上海日口径混用。本模块收敛为参数化单源；各 tick 业务体不变。
import type { Store } from "./store";

export function shanghaiDayOf(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

export type TickGuardOptions = {
  /** meta 键族前缀，如 "geo-newwords"；done 锁 <prefix>-done:<day>、running 锁 <prefix>-running */
  key: string;
  /** running 锁 TTL（毫秒）——超时视为陈旧锁可重入；按 tick 最坏耗时 ×2 取值 */
  lockTtlMs: number;
  /** 日闸口径：shanghai（缺省，与 collect-all/budget-audit 一致）| utc（历史 tick 的原口径） */
  day?: "shanghai" | "utc";
  now?: Date;
};

export type TickGuard = {
  /** 日闸已满足（今日已 done），调用方应直接 return */
  done: boolean;
  /** 日闸键（供调用方在成功/失败路径写 done 值） */
  doneKey: string;
  /** 陈旧 running 锁存在（TTL 内），调用方应直接 return */
  locked: boolean;
  /** 获取 running 锁（守卫通过后调用） */
  acquire: () => void;
  /** 释放 running 锁（finally 调用） */
  release: () => void;
};

export function tickGuard(db: Store, opts: TickGuardOptions): TickGuard {
  const now = opts.now ?? new Date();
  const day = (opts.day ?? "shanghai") === "shanghai"
    ? shanghaiDayOf(now)
    : now.toISOString().slice(0, 10);
  const doneKey = `${opts.key}-done:${day}`;
  const runningKey = `${opts.key}-running`;
  const running = db.get<any>("meta", runningKey);
  const locked = !!running && Date.now() - Date.parse(running.at) < opts.lockTtlMs;
  return {
    done: !!db.get("meta", doneKey),
    doneKey,
    locked,
    acquire: () => db.put("meta", runningKey, { at: new Date().toISOString() }),
    release: () => db.del("meta", runningKey),
  };
}

// —— in-flight 登记（R10.51 flaky 容差根治）——
// void (async …)() 即发即忘的 tick 让测试只能靠固定 setTimeout 等收敛，满载时
// 偶发「计数抖动」（W7-11 双重门控实测 101.9ms 线边缘）。tick 调用时把异步体
// 登记进来（promise 创建于同步段，无注册竞态），测试 await allInflightTicks()
// 确定性收敛——零容差、零固定等待。
const g = globalThis as unknown as { __draftdeskTickInflight?: Set<Promise<unknown>> };

export function trackInflight(p: Promise<unknown>): void {
  const set = (g.__draftdeskTickInflight ||= new Set());
  set.add(p);
  p.then(() => set.delete(p), () => set.delete(p));
}

export async function allInflightTicks(): Promise<void> {
  for (let i = 0; i < 50 && g.__draftdeskTickInflight?.size; i++) {
    await Promise.allSettled([...g.__draftdeskTickInflight]);
  }
}
