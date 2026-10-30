// R10.40 验收：本地开发环境配套——worker 关闭开关（instrumentation 守卫）+ maintenance 手动触发口
//（202 起跑/锁内 409/状态读口/完成清锁/失败记账）。日批链经 globalThis 测试缝注入桩，测试环境绝不真跑外呼。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1040-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;
const { handle } = await import("../core/http");
const { store } = await import("../core/store");

const req = (route: string, method?: string) =>
  handle(new Request("http://127.0.0.1:5173/api/v1/" + route, { method: method || "GET", headers: { host: "127.0.0.1:5173" } }), route.split("/"));

after(() => {
  delete (globalThis as any).__draftdeskDailyChainRunner;
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.40 ①：worker 关闭开关——instrumentation 在 EMBEDDED_WORKER=0 时不启动循环", async () => {
  const g = globalThis as any;
  delete g.__draftdeskWorker;
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.DRAFTDESK_EMBEDDED_WORKER = "0";
  const { register } = await import("../instrumentation");
  await register();
  assert.equal(g.__draftdeskWorker, undefined, "开关生效：worker 循环未启动");
  delete process.env.DRAFTDESK_EMBEDDED_WORKER;
  delete process.env.NEXT_RUNTIME;
});

test("R10.40 ②：maintenance 手动触发——202 起跑+锁内 409+状态读口+完成清锁", async () => {
  const db = store();
  let ran = 0;
  (globalThis as any).__draftdeskDailyChainRunner = async () => {
    ran++;
    await new Promise((r) => setTimeout(r, 120));
  };
  const start = await req("maintenance/run-daily", "POST");
  assert.equal(start.status, 202, "立即返回 202");
  const statusDuring = await req("maintenance/run-daily");
  assert.equal(statusDuring.status, 200);
  assert.equal(((await statusDuring.json()) as any).running, true, "运行中状态可见");
  const second = await req("maintenance/run-daily", "POST");
  assert.equal(second.status, 409, "锁内重复触发 409");
  assert.equal(((await second.json()) as any).code, "MAINTENANCE_RUNNING");
  await new Promise((r) => setTimeout(r, 250));
  const statusAfter = await req("maintenance/run-daily");
  const body = (await statusAfter.json()) as any;
  assert.equal(body.running, false, "完成后清锁");
  assert.equal(body.lastRun?.ok, true, "完成记账");
  assert.equal(ran, 1, "链只跑一次");
});

test("R10.40 ③：链抛错——记账失败原因且锁释放（可重试）", async () => {
  const db = store();
  (globalThis as any).__draftdeskDailyChainRunner = async () => { throw new Error("模拟日批失败"); };
  await req("maintenance/run-daily", "POST");
  await new Promise((r) => setTimeout(r, 150));
  const status = await req("maintenance/run-daily");
  const body = (await status.json()) as any;
  assert.equal(body.running, false, "失败后锁释放");
  assert.equal(body.lastRun?.ok, false, "失败记账");
  assert.match(String(body.lastRun?.error), /模拟日批失败/);
  const retry = await req("maintenance/run-daily", "POST");
  assert.equal(retry.status, 202, "失败后可重新触发");
  await new Promise((r) => setTimeout(r, 100));
});

test("R10.40 ④：锁过期自愈——30 分钟前的僵尸锁不阻塞新触发", async () => {
  const db = store();
  db.put("meta", "maintenance-running", { at: new Date(Date.now() - 31 * 60000).toISOString() });
  const r = await req("maintenance/run-daily", "POST");
  assert.equal(r.status, 202, "陈旧锁不阻塞（自愈）");
  await new Promise((r2) => setTimeout(r2, 100));
});
