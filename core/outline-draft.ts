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
  const hourKey = "outline-draft-done:" + new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(nowDate).replace(/\//g, "-"); // R10.31：上海小时
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

// R8-2①：资讯类（category=news/newtech）选题强制覆盖贴图号。
// R10.35 语义变更（老大 2026-10-30 拍板：一选题一条大纲）：不再克隆出一条 tiebuhao 独立大纲，
// 而是把 "tiebuhao" 补进该选题的 platforms（适合平台）——同一条选题多挂一个投放口，
// 大纲内容不重复。R10.35 裁决收口：取消「存量无 platforms 走克隆」双路径（活库已 100% 带
// platforms，写口保证新行必有；双路径属旧兼容，按前向产出原则砍掉），统一只补平台。
// 存量克隆行（platform=tiebuhao）本身算已覆盖，不回填不删除。
// 每次运行幂等（查重后补平台），不消耗模型调用。
export function ensureTiebuhaoClones(db: Store): number {
  // R10.38：一次扫描建簇索引消 O(n²)（原每个资讯行对全表 filter 找同簇行）
  const outlines = db.list<any>("outlines");
  const byCluster = new Map<string, any[]>();
  for (const o of outlines) {
    const bucket = byCluster.get(o.clusterId) || [];
    bucket.push(o);
    byCluster.set(o.clusterId, bucket);
  }
  const newsish = outlines.filter((o) => (o.category === "news" || o.category === "newtech") && !o.cloneOf);
  let patched = 0;
  for (const o of newsish) {
    const clusterRows = byCluster.get(o.clusterId) || [];
    // 已覆盖判定：同簇任一行 platform=tiebuhao（存量克隆行），或 platforms 已含 tiebuhao
    if (clusterRows.some((x) => x.platform === "tiebuhao" || (x.platforms || []).includes("tiebuhao"))) continue;
    const prev = db.get<any>("outlines", o.id);
    if (!prev) continue;
    const base = prev.platforms?.length ? prev.platforms : [prev.platform].filter(Boolean);
    if (!base.length) continue; // 无任何平台信息的老行无从补，跳过
    db.put("outlines", o.id, { ...prev, platforms: [...base, "tiebuhao"], updatedAt: new Date().toISOString() });
    patched++;
  }
  if (patched) console.log(`[outline-draft] 资讯类选题补挂贴图号投放口 ${patched} 条（R10.35）`);
  return patched;
}

