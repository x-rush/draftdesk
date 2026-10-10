// 全集合行数报告（数据事故后的搬迁/重建核对清单——不再七集合抽样）。
// 用法：node scripts/collections-report.mjs [数据目录或库文件路径]
// 只读打开；容器运行时请在容器内执行（宿主机直读活库是 10-01/10-10 事故根源）。
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const arg = process.argv[2];
let file = arg;
if (!file) file = path.join(process.env.DRAFTDESK_DATA_DIR || path.join(process.cwd(), "data"), "draftdesk.sqlite");
else if (!file.endsWith(".sqlite") && existsSync(path.join(file, "draftdesk.sqlite"))) file = path.join(file, "draftdesk.sqlite");
if (!existsSync(file)) {
  console.error(`库文件不存在: ${file}`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const rows = db.prepare("SELECT collection, COUNT(*) n FROM documents GROUP BY 1 ORDER BY n DESC, collection").all();
const total = rows.reduce((sum, r) => sum + r.n, 0);
const size = statSync(file).size;
console.log(`库: ${file}`);
console.log(`大小: ${(size / 1048576).toFixed(2)} MB | integrity_check: ${integrity}`);
console.log(`集合数: ${rows.length} | documents 总行数: ${total}`);
for (const r of rows) console.log(`  ${r.collection}: ${r.n}`);
db.close();
