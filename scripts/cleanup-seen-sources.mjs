// seen-terms sources 归一化清理（信息架构 v2 增补，热词捕获收尾）
// 用法：node scripts/cleanup-seen-sources.mjs --dryRun | --apply
// 旧提示词时代 sources 被模型填成标题残片（长/含空格）；本脚本反查所属
// discovery 批次，把脏值替换为真实平台来源 id（baidu-hot 等）。
// 必须在容器停止状态下于宿主机运行（数据库铁律）。
import { DatabaseSync } from "node:sqlite";

const apply = process.argv.includes("--apply");
const dbPath = decodeURIComponent(new URL("../data/draftdesk.sqlite", import.meta.url).pathname).replace(/^\/(\w:)/, "$1");
const db = new DatabaseSync(dbPath);

const sourceIds = new Set(db.prepare("SELECT id, body FROM documents WHERE collection='sources'").all().map(r => JSON.parse(r.body).id));
const candidates = []; // {title, sourceId, sourceName}
for (const rec of db.prepare("SELECT id, body FROM documents WHERE collection='discovery'").all()) {
  const d = JSON.parse(rec.body);
  for (const c of d.candidates || []) candidates.push({ title: c.title || "", sourceId: c.sourceId, sourceName: c.sourceName || "" });
}
const seen = db.prepare("SELECT id, body FROM documents WHERE collection='seen-terms'").all()
  .map(r => JSON.parse(r.body))
  .map(t => ({ ...t, sources: t.sources || [] }));

// 验收口径：值 ∈ 平台名单（sources 集合的 id 集合）才算干净——短中文残片同样剔除
const isDirty = (v) => !sourceIds.has(v);
const nameToId = new Map();
for (const c of candidates) if (c.sourceName) nameToId.set(c.sourceName, c.sourceId);

let touched = 0, termsChanged = 0;
const report = [];
for (const t of seen) {
  const clean = new Set(), dirty = new Set();
  for (const v of t.sources) (isDirty(v) ? dirty : clean).add(v);
  // 反查：标题包含该词的候选 → 真实平台 id
  const needle = t.term.toLowerCase();
  for (const c of candidates) {
    if (!c.title.toLowerCase().includes(needle)) continue;
    if (sourceIds.has(c.sourceId)) clean.add(c.sourceId);
    if (nameToId.has(c.sourceName)) clean.add(nameToId.get(c.sourceName));
  }
  const next = [...clean].sort();
  const before = [...t.sources].sort();
  if (JSON.stringify(next) === JSON.stringify(before)) continue;
  termsChanged++;
  dirty.forEach(v => { if (!next.includes(v)) touched++; });
  report.push({ term: t.term, before, after: next, dropped: [...dirty].filter(v => !next.includes(v)) });
  if (apply) db.prepare("UPDATE documents SET body=? WHERE collection='seen-terms' AND id=?").run(JSON.stringify({ ...t, sources: next }), t.id);
}

console.log(`seen-terms 共 ${seen.length} 条；需修 ${termsChanged} 条；清除脏值 ${touched} 个${apply ? "" : "（dryRun，未写入）"}`);
for (const r of report.slice(0, 40)) console.log(" ", r.term, "|", JSON.stringify(r.before), "→", JSON.stringify(r.after), r.dropped.length ? "剔除:" + JSON.stringify(r.dropped) : "");
if (report.length > 40) console.log(`… 其余 ${report.length - 40} 条略`);
if (!apply && termsChanged) console.log("\n确认无误后加 --apply 执行。");
db.close();
