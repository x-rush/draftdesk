// 双端兜底链（第六轮批 B §2④）：approved → 第一版大纲。
// external（现状）：内置不跑——大纲由外部 Agent 写（docs/agent-integration.md「大纲提交」节）；
// builtin：本 tick 每小时一道闸，approved 且无草稿的大纲按「平台模板×题材角度」提示词
//（composeOutlinePrompt，skills/prompts/outline-matrix.md 单一来源）cheap 档自动产出
// keyPoints/outline/draftBody 并推进 drafting。联动：aiPolicy.draft=off 或 external 时跳过。
import type { Store } from "./store";
import { now } from "./store";
import { requestModel } from "./model";
import { composeOutlinePrompt } from "./prompts-matrix";

type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full"; model?: string }) => Promise<{ text: string; usage?: unknown }>;

const MAX_PER_RUN = 8;

function parseOutlineDraft(text: string): { keyPoints?: string[]; outline?: string[]; draftBody?: string } | undefined {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { keyPoints?: unknown; outline?: unknown; draftBody?: unknown };
    const keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map((k) => String(k).slice(0, 300)).filter(Boolean).slice(0, 6) : undefined;
    const outline = Array.isArray(parsed.outline) ? parsed.outline.map((k) => String(k).slice(0, 300)).filter(Boolean).slice(0, 10) : undefined;
    const draftBody = typeof parsed.draftBody === "string" && parsed.draftBody.trim().length > 80 ? parsed.draftBody.slice(0, 100000) : undefined;
    if (!draftBody) return undefined;
    return { keyPoints, outline, draftBody };
  } catch { return undefined; }
}

// builtin 兜底 tick：consumerMode=builtin 且 aiPolicy.draft 未被显式关掉时跑；
// 每小时一道闸（approved 后最迟 1h 出稿——远快于 24h 验收线）。external 模式零动作。
export function outlineDraftTick(db: Store, runModel: ModelRunner = requestModel, nowDate: Date = new Date()) {
  // 联动由 consumerMode 驱动（老大批复：external=off / builtin=cheap）——
  // aiPolicy.draft 存量默认 off 不构成关断（否则 builtin 兜底永不生效）；档位固定 cheap。
  if ((db.get("config", "consumerMode") || "external") !== "builtin") return;
  if (!db.config().apiKey) return;
  const hourKey = "outline-draft-done:" + nowDate.toISOString().slice(0, 13);
  if (db.get("meta", hourKey)) return;
  const running = db.get<any>("meta", "outline-draft-running");
  if (running && Date.now() - Date.parse(running.at) < 20 * 60000) return;
  const targets = db.list<any>("outlines")
    .filter((o) => o.decision === "approved" && !o.draftBody)
    .sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || "")))
    .slice(0, MAX_PER_RUN);
  ensureTiebuhaoClones(db);
  if (!targets.length) {
    db.put("meta", hourKey, { at: nowDate.toISOString(), drafted: 0, note: "无待出稿的 approved 大纲" });
    return;
  }
  db.put("meta", "outline-draft-running", { at: new Date().toISOString() });
  void (async () => {
    let drafted = 0, failed = 0;
    try {
      const outer = AbortSignal.timeout(10 * 60000);
      for (const o of targets) {
        try {
          const result = await runModel(db, [{ role: "user", content: composeOutlinePrompt(o.platform, o.category, o.title, o.keyPoints || []) }], { signal: AbortSignal.any([outer, AbortSignal.timeout(180000)]), plan: "cheap" });
          const draft = parseOutlineDraft(result.text);
          if (!draft) throw new Error("模型输出无有效 draftBody");
          const prev = db.get<any>("outlines", o.id);
          if (!prev || prev.draftBody || prev.decision !== "approved") continue;
          db.put("outlines", o.id, {
            ...prev,
            keyPoints: draft.keyPoints?.length ? draft.keyPoints : prev.keyPoints,
            outline: draft.outline?.length ? draft.outline : prev.outline,
            draftBody: draft.draftBody,
            decision: "drafting",
            decidedBy: prev.decidedBy || "human",
            updatedAt: now(),
          });
          drafted++;
        } catch (e) {
          failed++;
          console.error(`[outline-draft] 「${String(o.title).slice(0, 40)}」出稿失败（保留 approved 下轮重试）:`, e instanceof Error ? e.message : e);
        }
      }
      console.log(`[outline-draft] builtin 自动大纲：出稿 ${drafted}（失败 ${failed}）/ 待出稿剩余 ${targets.length - drafted}`);
    } finally {
      db.put("meta", hourKey, { at: nowDate.toISOString(), drafted, failed });
      db.del("meta", "outline-draft-running");
    }
  })();
}

// R8-2①：资讯类（category=news/newtech）簇强制覆盖贴图号——同簇无 tiebuhao 行时
// 克隆一条 tiebuhao 版（pending、同标题同大纲），产出侧缺口补齐（模板侧已齐）。
// 每次运行幂等（查重后克隆），不消耗模型调用。
export function ensureTiebuhaoClones(db: Store): number {
  const outlines = db.list<any>("outlines");
  const newsish = outlines.filter((o) => (o.category === "news" || o.category === "newtech") && o.decision === "approved");
  let cloned = 0;
  for (const o of newsish) {
    const clusterRows = outlines.filter((x) => x.clusterId === o.clusterId);
    if (clusterRows.some((x) => x.platform === "tiebuhao")) continue;
    const stamp = new Date().toISOString();
    const clone = {
      ...o,
      id: o.id + "-tbh",
      platform: "tiebuhao",
      decision: "pending" as const,
      perPlatformDecision: undefined,
      draftBody: undefined,
      draftRef: undefined,
      publishedRef: undefined,
      decidedAt: stamp,
      decidedBy: o.decidedBy || "builtin",
      createdAt: stamp,
      updatedAt: stamp,
      cloneOf: o.id,
    };
    db.put("outlines", clone.id, clone);
    cloned++;
  }
  if (cloned) console.log(`[outline-draft] 资讯类簇补贴图号版大纲 ${cloned} 条（R8-2①）`);
  return cloned;
}

