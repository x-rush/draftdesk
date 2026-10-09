// 守卫：防止任何人在未隔离数据目录的情况下跑测试（见 database/README.md 2026-10-09 事故）。
// Store 的兜底数据目录是 cwd/data——即容器正在写的活库。宿主机测试进程一旦打开它，
// 就是文档在案的双写损坏场景。npm test 经 scripts/run-tests.mjs 注入临时目录；
// 若绕过运行器直跑 tsx --test，本守卫会立刻红掉而不是让活库默默挨写。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

test("测试进程的数据目录必须与活库隔离（DRAFTDESK_DATA_DIR 已注入且不在仓库内）", () => {
  const dir = process.env.DRAFTDESK_DATA_DIR;
  assert.ok(dir, "DRAFTDESK_DATA_DIR 未设置——请用 npm test（scripts/run-tests.mjs）跑测试，勿直跑 tsx --test。");
  const repoData = path.join(process.cwd(), "data");
  assert.ok(
    !path.resolve(dir).startsWith(path.resolve(repoData)),
    `DRAFTDESK_DATA_DIR 指向仓库 data/（${dir}）——这会打到活库，拒绝执行。`,
  );
});
