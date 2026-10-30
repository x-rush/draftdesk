// R10.35 数据迁移：把「一选题×N 平台拆行」的存量大纲合并成「一选题一条」。
//
// 背景（老大 2026-10-30 拍板）：审查台不需要针对每个平台各写一份大纲，只需按选题写
// 大纲方向与推荐建议，再标注适合哪些平台。存量 166 行 / 65 簇（48 簇多行）是旧模型产物。
//
// 合并规则（保守，只合并 pending，绝不动已拍板记录）：
// 1. 按 clusterId 分组；组内全为 pending 才合并，含任一非 pending → 整组跳过（拍板历史保护）。
// 2. 主行 = 组内 createdAt 最新的一条（保留其 title/outline/keyPoints，内容最全）。
// 3. 主行加 platforms = 组内所有 platform 去重保序；primary 的 platform 保持 platforms[0]。
// 4. 组内其他行的差异（标题不同=不同角度）不丢弃：合并成推荐建议里的「其他角度」附注，
//    写进 recommendation（原 recommendation 保留在前）。
// 5. 删除其余行（软删：先落 outlines-merge-archive 集合，可回滚）。
// 6. perPlatformDecision 汇总到主行（同平台取最前进态，与 aggregateOutlineDecision 口径一致）。
//
// 用法：
//   node --experimental-strip-types scripts/merge-outlines-by-cluster.ts            # dryRun
//   node --experimental-strip-types scripts/merge-outlines-by-cluster.ts --apply    # 落库
import { store } from "../core/store/index.ts";

const DECISION_PRIORITY = ["published", "drafting", "approved", "rejected", "deferred", "pending"] as const;

// 主行选择：优先中文完整论证型平台（gzh 的标题是判断句/承诺句，outline 是 3-8 项递进，
// 信息最全），其次小红书笔记/贴图号，英文短评（threads/x/facebook/instagram/linkedin）排最后
// ——英文标题当「选题名」在中文审查台里读着别扭，它的内容作为其他角度并入推荐建议即可。
const TITLE_PREFERENCE = ["gzh", "xhs-note", "tiebuhao", "xhs-video", "threads", "x", "linkedin", "facebook", "instagram"];

function pickAggregate(states: string[]): string {
  for (const s of DECISION_PRIORITY) if (states.includes(s)) return s;
  return "pending";
}

function main() {
  const apply = process.argv.includes("--apply");
  const db = store();
  const outlines = db.list<any>("outlines");
  const byCluster = new Map<string, any[]>();
  for (const o of outlines) {
    const key = String(o.clusterId || "");
    if (!key) continue;
    const bucket = byCluster.get(key) || [];
    bucket.push(o);
    byCluster.set(key, bucket);
  }

  let mergeable = 0, skippedDecided = 0, skippedSingle = 0, rowsRemoved = 0;
  const plans: { clusterId: string; primaryId: string; merged: number; platforms: string[]; titles: string[] }[] = [];

  for (const [clusterId, rows] of byCluster) {
    if (rows.length < 2) { skippedSingle++; continue; }
    // 幂等保护：已合并过的簇只剩 1 行（走到上面单行分支）；若仍有 2 行但主行带 mergeNote，
    // 说明是中途重跑——跳过，避免二次合并把补进来的平台信息搅乱。
    if (rows.some((o) => o.mergeNote)) { skippedSingle++; continue; }
    const undecided = rows.filter((o) => (o.decision || "pending") === "pending");
    if (undecided.length !== rows.length) { skippedDecided++; continue; } // 含已拍板：整组不动
    const sorted = [...rows].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    // 主行按「平台内容质量优先序」选，而不是单纯取最新：中文完整论证（gzh）当选题名最合适，
    // 英文短评（threads）标题在中文审查台里读着别扭，作为其他角度并入推荐建议即可。
    const rank = (p: string) => {
      const i = TITLE_PREFERENCE.indexOf(p);
      return i < 0 ? TITLE_PREFERENCE.length : i;
    };
    const primary = [...sorted].sort((a, b) => rank(String(a.platform || "")) - rank(String(b.platform || "")))[0];
    const platforms: string[] = [];
    // 主行平台排首位（这条选题的标题/大纲来自它，platforms[0] 应与之一致）
    const primaryPlatform = String(primary.platform || "");
    if (primaryPlatform) platforms.push(primaryPlatform);
    for (const r of sorted) {
      const p = String(r.platform || "");
      if (p && !platforms.includes(p)) platforms.push(p);
    }
    // perPlatformDecision 汇总（各平台取最前进态）
    const per: Record<string, string> = { ...(primary.perPlatformDecision || {}) };
    for (const r of sorted) {
      const p = String(r.platform || "");
      if (!p) continue;
      const states = sorted.filter((x) => x.platform === p).map((x) => x.decision || "pending");
      per[p] = pickAggregate([...(Object.keys(per).includes(p) ? [per[p]] : []), ...states]);
    }
    // 其他角度（标题与本行不同的）→ 推荐建议附注，不丢信息
    const otherAngles = sorted.slice(1).map((r) => String(r.title || "").trim()).filter((t) => t && t !== String(primary.title || "").trim());
    const noteParts: string[] = [];
    if (primary.recommendation) noteParts.push(String(primary.recommendation));
    if (otherAngles.length) noteParts.push("【合并前其他角度】" + otherAngles.join("｜"));

    mergeable++;
    rowsRemoved += rows.length - 1;
    plans.push({ clusterId, primaryId: primary.id, merged: rows.length, platforms, titles: otherAngles });

    if (apply) {
      // 其余行 = 除主行外的全部（按 id 排除，不能用 sorted.slice(1)——主行不是 sorted[0]）
      const archiveRows = rows.filter((r) => r.id !== primary.id);
      for (const r of archiveRows) {
        db.put("outlines-merge-archive", r.id, { ...r, archivedAt: new Date().toISOString(), archivedReason: "R10.35 按簇合并" });
        db.del("outlines", r.id);
      }
      db.put("outlines", primary.id, {
        ...primary,
        platform: platforms[0] || primary.platform,
        platforms,
        perPlatformDecision: Object.keys(per).length ? per : undefined,
        decision: pickAggregate(Object.values(per).length ? Object.values(per) : [primary.decision || "pending"]),
        ...(noteParts.length ? { recommendation: noteParts.join("\n") } : {}),
        updatedAt: new Date().toISOString(),
        mergeNote: `R10.35 合并 ${rows.length} 行（${platforms.join("/")}）`,
      });
    }
  }

  console.log("=== R10.35 按簇合并大纲 ===");
  console.log(`模式: ${apply ? "APPLY（落库）" : "DRY-RUN（只预览）"}`);
  console.log(`总行数: ${outlines.length} | 簇数: ${byCluster.size}`);
  console.log(`可合并簇: ${mergeable}（将减少 ${rowsRemoved} 行 → 剩 ${outlines.length - rowsRemoved} 行）`);
  console.log(`跳过·单行簇: ${skippedSingle} | 跳过·含已拍板: ${skippedDecided}`);
  console.log();
  console.log("前 10 个合并计划:");
  for (const p of plans.slice(0, 10)) {
    console.log(`· ${p.clusterId.slice(0, 26)} | ${p.merged} 行 → 1 | 平台 ${p.platforms.join(",")}`);
    if (p.titles.length) console.log(`    并入的其他角度: ${p.titles.length} 条`);
  }
  if (!apply) console.log("\n复核无误后加 --apply 落库（原行软删到 outlines-merge-archive，可回滚）。");
  db.close?.();
}

main();
