// 临时探针：三区逐查询耗时 + EXPLAIN QUERY PLAN。
import { Store } from "../core/store";
const db = new Store(process.argv[2] || undefined);
const now = Date.now();
db.transaction(() => {
  for (let i = 0; i < 30000; i++) {
    const bucket = i % 10;
    const status = bucket < 8 ? "new" : bucket < 9 ? "rising" : "sustained";
    const ageDays = i % 30;
    const obs = status === "new" ? (i % 3) : 3 + (i % 10);
    db.put("seen-terms", `w${i}`, { id: `w${i}`, term: `词${i}`, status, intent: ["informational","commercial","question","comparison"][i%4], observations: obs, sources: [], relatedSearches: [], seed: `s${i%100}`, firstSeenAt: new Date(now - ageDays*86400000).toISOString(), lastSeenAt: new Date().toISOString(), daysSeen: status==="sustained"?["a","b","c"].slice(0,1+(i%3)):[], offTopic: i%50===0, producedBy: "x", createdAt: "", updatedAt: "" });
  }
});
const since = new Date(now - 7*86400000).toISOString();
const qs = [
  ["fresh", `SELECT body, COUNT(*) OVER () c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='new' ORDER BY json_extract(body,'$.firstSeenAt') DESC LIMIT 20`, []],
  ["hot", `SELECT body, COUNT(*) OVER () c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')!='archived' AND json_extract(body,'$.offTopic') IS NOT 1 AND json_extract(body,'$.observations')>=3 AND json_extract(body,'$.firstSeenAt')>=? ORDER BY json_extract(body,'$.observations') DESC LIMIT 20`, [since]],
  ["sustained", `SELECT body, COUNT(*) OVER () c FROM documents WHERE collection='seen-terms' AND json_extract(body,'$.status')='sustained' ORDER BY json_array_length(json_extract(body,'$.daysSeen')) DESC LIMIT 20`, []],
];
for (const [name, sql, params] of qs) {
  for (const plan of db.kv.sqlRows("EXPLAIN QUERY PLAN " + sql, ...params))
    console.log(name, "plan:", Object.values(plan).join(" ").slice(0, 130));
  const t0 = performance.now();
  db.kv.sqlRows(sql, ...params);
  console.log(name, "耗时", (performance.now() - t0).toFixed(1), "ms");
}
console.log("--- ANALYZE 后 ---");
db.kv.db.exec("ANALYZE");
for (const [name, sql, params] of qs) {
  for (const plan of db.kv.sqlRows("EXPLAIN QUERY PLAN " + sql, ...params))
    console.log(name, "plan:", Object.values(plan).join(" ").slice(0, 130));
  const t0 = performance.now();
  db.kv.sqlRows(sql, ...params);
  console.log(name, "耗时", (performance.now() - t0).toFixed(1), "ms");
}
