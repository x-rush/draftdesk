// 容器内只读探针：拉 job steps/warnings/outcome + job-validation 修复记录。
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/probe-snap2.sqlite");
for (const id of process.argv.slice(2)) {
  const row = db.prepare("SELECT body FROM documents WHERE collection='jobs' AND id LIKE ?").get(id + "%");
  if (!row) { console.log(id.slice(0, 8), ": not found"); continue; }
  const job = JSON.parse(row.body);
  console.log("=== " + id.slice(0, 8) + " | " + job.planId + " | " + job.state + " | outcome=" + (job.outcome || "-") + " | calls=" + job.calls + " | tokens=" + job.actualTokens + "/" + job.reservedTokens);
  for (const s of job.steps || []) console.log("  [" + s.at.slice(11, 19) + "] " + s.name + " (" + s.state + "): " + String(s.detail).slice(0, 200));
  if (job.warnings?.length) console.log("  warnings:", JSON.stringify(job.warnings).slice(0, 400));
  const vals = db.prepare("SELECT body FROM documents WHERE collection='job-validation' AND id LIKE ?").all(id + "%");
  console.log("  job-validation 记录数:", vals.length);
  for (const v of vals) { const j = JSON.parse(v.body); console.log("    attempt " + j.attempt + ": " + j.issues.join(" | ").slice(0, 200)); }
}
db.close();
