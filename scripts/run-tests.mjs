// 测试运行器：强制为整个测试进程树注入临时 DRAFTDESK_DATA_DIR。
//
// 事故背景（2026-10-09，见 database/README.md）：Store 的默认数据目录是
// cwd/data，宿主机直接跑 tsx --test 时，凡未自带隔离的测试都会把活库
// （容器正在写的 data/draftdesk.sqlite）以宿主机身份打开——双写者穿越
// Docker 文件共享层引发页缓存失谐，曾导致 app 无法建 -wal、页读短路。
// 从这里注入 env 后，Store 的 cwd/data 兜底永远不会再命中活库；
// 测试自带的 DRAFTDESK_DATA_DIR / new Store(dir) 覆盖仍然优先生效。
import { globSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.DRAFTDESK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "draftdesk-tests-"));

const pattern = process.argv[2] || "tests/*.test.ts";
const files = globSync(pattern);
if (!files.length) {
  console.error(`no test files matched: ${pattern}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
