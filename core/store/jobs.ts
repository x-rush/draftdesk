// 研究任务域：入队（含回执去重/定时键/单策略并发闸）、worker 认领（租约续期与中断清算）、
// 步骤追加、补丁、讨论锁。预算校验的 apiKey 经参数注入（config），避免与配置域互相依赖。
import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import { now } from "./helpers";
import type { KV } from "./kv";
import type { Job, Plan } from "../schema";

export function createJobs(kv: KV, config: () => { apiKey?: string }) {
  return {
    enqueue(planId: string, evidenceIds: string[] = [], scheduledKey?: string, receiptId?: string, retry = false, targetKeywords?: string[]) {
      return kv.transaction(() => {
        if (receiptId) {
          const receipt = kv.get<any>("receipts", receiptId);
          if (!receipt) throw new AppError("收件回执不存在", 404);
          evidenceIds = receipt.evidenceIds;
          const old = kv.list<Job>("jobs").find((j) => j.planId === planId && (j.receiptId === receiptId || (!j.receiptId && j.external && j.evidenceIds.length === evidenceIds.length && j.evidenceIds.every((id) => evidenceIds.includes(id)))));
          if (old && (!retry || !["failed", "cancelled"].includes(old.state))) return old;
        }
        const savedPlan = kv.get<Plan>("plans", planId);
        const plan = savedPlan && targetKeywords?.length && savedPlan.kind === "activities"
          ? { ...savedPlan, keywords: targetKeywords.slice(0, 8), goal: `${savedPlan.goal}\n本次用户指定目标关键词：${targetKeywords.join("、")}。只推荐与这些方向有直接关系的活动。` }
          : savedPlan;
        if (!plan) throw new AppError("研究策略不存在。", 404);
        if (
          scheduledKey &&
          kv.db
            .prepare("SELECT key FROM schedules WHERE key=?")
            .get(scheduledKey)
        )
          return null;
        if (
          kv.list<Job>("jobs").some(
            (j) => j.planId === planId && ["queued", "running"].includes(j.state),
          )
        )
          throw new AppError("此策略已有等待或运行中的任务。", 409);
        if (!config().apiKey) throw new AppError("请先配置百炼 API Key。");
        const j: Job = {
          id: randomUUID(),
          planId,
          ...(receiptId ? { receiptId } : {}),
          plan,
          state: "queued",
          stage: "等待执行",
          createdAt: now(),
          steps: [],
          evidenceIds,
          calls: 0,
          reservedTokens: 0,
          actualTokens: 0,
          warnings: [],
          external: evidenceIds.length > 0,
          skillVersions: {},
        };
        kv.put("jobs", j.id, j);
        if (scheduledKey)
          kv.db
            .prepare("INSERT INTO schedules VALUES(?,?)")
            .run(scheduledKey, j.id);
        return j;
      });
    },
    claim() {
      return kv.transaction(() => {
        const all = kv.list<Job>("jobs");
        for (const j of all)
          if (j.state === "running" && (j.leaseUntil || 0) < Date.now()) {
            kv.put("jobs", j.id, {
              ...j,
              state: j.cancelRequested ? "cancelled" : "failed",
              error: "Worker 中断或租约过期；未自动重试付费步骤。",
              finishedAt: now(),
            });
          }
        if (kv.list<Job>("jobs").some((j) => j.state === "running")) return;
        const j = all
          .filter((j) => j.state === "queued")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!j) return;
        return kv.put("jobs", j.id, {
          ...j,
          state: "running" as const,
          leaseUntil: Date.now() + 300000,
        });
      });
    },
    patchJob(id: string, patch: Partial<Job>) {
      return kv.transaction(() => {
        const j = kv.get<Job>("jobs", id);
        if (!j) throw new AppError("任务不存在", 404);
        return kv.put("jobs", id, { ...j, ...patch });
      });
    },
    step(id: string, name: string, state: string, detail: string) {
      return kv.transaction(() => {
        const j = kv.get<Job>("jobs", id)!;
        return kv.put("jobs", id, {
          ...j,
          stage: name,
          steps: [...j.steps, { name, state, detail, at: now() }],
        });
      });
    },
    lock(id: string) {
      return kv.transaction(() => {
        kv.db.prepare("DELETE FROM locks WHERE expires<?").run(Date.now());
        if (kv.db.prepare("SELECT id FROM locks WHERE id=?").get(id))
          throw new AppError("当前讨论正在处理中。", 409);
        kv.db
          .prepare("INSERT INTO locks VALUES(?,?)")
          .run(id, Date.now() + 240000);
      });
    },
    unlock(id: string) {
      kv.db.prepare("DELETE FROM locks WHERE id=?").run(id);
    },
    renewLock(id: string) {
      kv.db.prepare("UPDATE locks SET expires=? WHERE id=?").run(Date.now() + 240000, id);
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
