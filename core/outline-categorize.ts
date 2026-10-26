// 选题题材标注（第六轮批 A §1②）：存量 outlines 按 title+keyPoints 用 cheap 档 LLM
// 批量标六类题材（newtech/news/oss/selfproduct/thinking/hot）。一次性回填任务：
// meta 键守卫，标完置位不再跑；新增大纲的 category 由提交方（外部 Agent/内置）带出。
// 分类属初筛（采集的一部分），不受 consumerMode 门控。
import type { Store } from "./store";
import { tickGuard } from "./tick-guard";
import { now } from "./store";
import { CATEGORY_LABELS, normalizeCategory } from "./platforms";

type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full"; model?: string }) => Promise<{ text: string; usage?: unknown }>;

const BATCH = 30;

const PROMPT_HEAD =
  "你是选题编辑。给下面的选题标题材，六选一：" +
  Object.entries(CATEGORY_LABELS).map(([k, v]) => `${k}=${v}`).join(" / ") + "。" +
  "判据要点：新技术=模型/能力/框架发布与可用性变化；新资讯=行业动态报道；开源工具=开源项目/工具推荐；" +
  "自研产品=我自己开发的产品更新与教程；个人思考=一手经历/观点/方法论；社会热点=大众热搜与民生话题。" +
  '只输出 JSON 数组：[{"i":1,"category":"newtech"}]，不要输出其他文字。\n\n';

export async function categorizeOutlines(db: Store, runModel: ModelRunner, outer: AbortSignal): Promise<{ classified: number; failedBatches: number; remaining: number }> {
  const pending = db.list<any>("outlines").filter((o) => !o.category);
  if (!pending.length) return { classified: 0, failedBatches: 0, remaining: 0 };
  let classified = 0, failedBatches = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const listing = batch.map((o, idx) => {
      const points = (o.keyPoints || []).slice(0, 2).join("；");
      return `${idx + 1}. [${o.platform}] ${o.title}${points ? `（要点：${points.slice(0, 120)}）` : ""}`;
    }).join("\n");
    try {
      const result = await runModel(db, [{ role: "user", content: PROMPT_HEAD + listing }], { signal: AbortSignal.any([outer, AbortSignal.timeout(240000)]), plan: "cheap" });
      const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
      if (!Array.isArray(parsed)) throw new Error("模型输出不是 JSON 数组");
      for (const item of parsed) {
        const idx = Number(item?.i);
        if (!Number.isInteger(idx) || idx < 1 || idx > batch.length) continue;
        const category = normalizeCategory(String(item?.category || ""));
        const outline = batch[idx - 1];
        if (!category || !outline) continue;
        const prev = db.get<any>("outlines", outline.id);
        if (!prev || prev.category) continue;
        db.put("outlines", outline.id, { ...prev, category, updatedAt: now() });
        classified++;
      }
    } catch (e) {
      failedBatches++;
      console.error(`[outline-category] 标注批次失败（${batch.length} 条保留重试）:`, e instanceof Error ? e.message : e);
    }
  }
  return { classified, failedBatches, remaining: pending.length - classified };
}

// 可持续标注 tick（R9-1，原「一次性回填」改常态）：每日一道闸——存在无 category 的
// 大纲即 cheap 档增量标注（新簇/新大纲次日自动补上，下游 ensureTiebuhaoClones、
// 审查台题材筛选持续有数据）；失败也置当日 done（防每分钟打爆模型），次日重试。
export function outlineCategoryTick(db: Store, runModel: ModelRunner, nowDate: Date = new Date()) {
  const day = nowDate.toISOString().slice(0, 10);
  const doneKey = "outline-category-done:" + day;
  if (db.get("meta", doneKey)) return;
  const pending = db.list<any>("outlines").filter((o) => !o.category).length;
  if (!pending) {
    db.put("meta", doneKey, { at: nowDate.toISOString(), note: "无待标注大纲" });
    return;
  }
  // R10.27-C#17：守卫统一（键与 TTL 保持原值）
  const guard = tickGuard(db, { key: "outline-category", lockTtlMs: 20 * 60000, day: "utc" });
  if (guard.locked) return;
  guard.acquire();
  void (async () => {
    try {
      const outer = AbortSignal.timeout(10 * 60000);
      const r = await categorizeOutlines(db, runModel, outer);
      db.put("meta", doneKey, { at: nowDate.toISOString(), classified: r.classified, remaining: r.remaining });
      console.log(`[outline-category] 题材标注：本次 ${r.classified}，剩余 ${r.remaining}（失败批 ${r.failedBatches}）${r.remaining === 0 ? "——当日清零" : "，下轮 tick 继续"}`);
    } catch (e) {
      db.put("meta", doneKey, { at: nowDate.toISOString(), error: String(e instanceof Error ? e.message : e).slice(0, 160) });
      console.error("[outline-category] 标注失败（次日重试）:", e instanceof Error ? e.message : e);
    } finally {
      guard.release();
    }
  })();
}
