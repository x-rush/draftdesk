// 一次性迁移：合并同 topic+target 的多代簇为一代（memberIds 并集、window 并集），
// 各自大纲全部挂到合并后的簇下，不丢任何大纲。
// 用法：docker compose exec worker npx tsx scripts/merge-duplicate-clusters.ts [--dryRun]
const { Store } = await import("../core/store");
const { urlKey } = await import("../core/hotspots");
import { writeFileSync } from "node:fs";

const dryRun = process.argv.includes("--dryRun");
const db = new Store();

interface ClusterRow { id: string; topic: string; memberIds: string[]; memberCount: number; kind: string; window: string; suggestedPlatforms: string[]; target?: string; status?: string; producedBy?: string; createdAt: string; }
interface OutlineRow { id: string; clusterId: string; decision?: string; title?: string; }

const allClusters = db.list<ClusterRow>("clusters");
const allOutlines = db.list<OutlineRow>("outlines");

// 按 topic+target 分组
function groupKey(c: ClusterRow) { return `${c.topic}||${c.target || "hotspots"}`; }
const groups = new Map<string, ClusterRow[]>();
for (const c of allClusters) {
  const key = groupKey(c);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(c);
}

const duplicates = [...groups.values()].filter((g) => g.length > 1);
console.log(`总簇数: ${allClusters.length} | 重复组: ${duplicates.length} | 单例组: ${groups.size - duplicates.length}`);

if (dryRun) {
  console.log("\n=== dryRun 影响面 ===");
  for (const group of duplicates) {
    const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const totalMembers = new Set(sorted.flatMap((c) => c.memberIds || [])).size;
    const totalOutlines = allOutlines.filter((o) => group.some((c) => c.id === o.clusterId)).length;
    console.log(`  「${sorted[0].topic}」 ${sorted.length} 代 → 合并为 1 簇（${totalMembers} 条成员，${totalOutlines} 份大纲）`);
    for (const c of sorted) console.log(`    - ${c.id} | ${c.createdAt?.slice(0, 10)} | ${(c.memberIds || []).length} members`);
  }
  console.log(`\ndryRun 结束，未写入。去掉 --dryRun 执行合并。`);
  process.exit(0);
}

// 执行合并
let mergedGroups = 0, removedClusters = 0, outlinesReassigned = 0;
db.transaction(() => {
  for (const group of duplicates) {
    const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keep = sorted[0];
    const allMembers = [...new Set(sorted.flatMap((c) => c.memberIds || []))];
    const windows = [...new Set(sorted.map((c) => c.window).filter(Boolean))];
    const mergedWindow = windows.join(" ~ ");

    // 把后续簇的大纲全部挂到保留簇下
    for (const older of sorted.slice(1)) {
      for (const o of allOutlines) {
        if (o.clusterId === older.id) {
          db.put("outlines", o.id, { ...o, clusterId: keep.id });
          outlinesReassigned++;
        }
      }
      db.del("clusters", older.id);
      removedClusters++;
    }
    // 更新保留簇的成员
    db.put("clusters", keep.id, {
      ...keep,
      memberIds: allMembers,
      memberCount: allMembers.length,
      window: mergedWindow || keep.window,
    });
    mergedGroups++;
    console.log(`✓ 合并「${keep.topic}」 ${sorted.length} 代 → 1（${allMembers.length} members，${outlinesReassigned} outlines reassigned）`);
  }
});

console.log(`\n合并完成: ${mergedGroups} 组重复簇已收敛 | 移除冗余簇: ${removedClusters} | 大纲重挂: ${outlinesReassigned}`);
writeFileSync(`data/merge-cluster-report-${Date.now()}.json`, JSON.stringify({ mergedGroups, removedClusters, outlinesReassigned }, null, 2));
db.close();
