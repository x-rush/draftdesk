// 热词捕获（信息架构 v2 增补）：每日提取闸门、手动触发与 24h 兜底。
// 职责划分（批复修订）：主路径 = 外部 Agent（小拾）的定时任务看到闸门后
// 拉标题流做 glm5.3 提取并 PUT /agent/seen-terms；worker 只置闸门。
// 兜底 = 闸门置位 24h 仍无写入时，worker 降级执行一次内置提取（保证不断流）。
// 手动 = UI「立即整理/刷新雷达」写 seen-terms-manual 请求，tick 立即执行（跳过 24h 等待）。
import type { Store } from "./store";
import { judgeSeenTerm, observeSeenTerm, termId } from "./seen-terms";
import type { PersonaRelevance } from "./seen-terms";

const GATE_KEY = "seen-terms-gate";
const DAY_MS = 86400000;
type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full" }) => Promise<{ text: string; usage?: unknown }>;

// 闸门：所有启用调度计划「最近 24 小时内存在 completed」（滚动窗口，规避 UTC 日期边界——
// 北京白天采集的任务 finishedAt 的 UTC 日期恒为「昨天」，按日历日比较会让闸门白天永不置位）
// 且无排队/运行中 → 置位 { date, at }（每日一次，幂等）。
export function seenTermsGate(db: Store): { date: string; at: string } | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const gate = db.get<any>("meta", GATE_KEY);
  if (gate?.date === today) return gate;
  const scheduled = db.list<any>("plans").filter((p) => p.scheduleEnabled);
  if (!scheduled.length) return gate;
  const jobs = db.list<any>("jobs");
  const doneRecently = (id: string) => jobs.some((j) => j.planId === id && j.state === "completed" && j.finishedAt && Date.now() - Date.parse(j.finishedAt) < DAY_MS);
  const allDone = scheduled.every((p) => doneRecently(p.id));
  const noneActive = !jobs.some((j) => ["queued", "running"].includes(j.state));
  if (!allDone || !noneActive) return gate;
  const at = new Date().toISOString();
  db.put("meta", GATE_KEY, { date: today, at });
  return { date: today, at };
}

// 手动触发（UI「立即整理/刷新雷达」）：当日内一次；已完成则 alreadyDone。
// 同时写挖掘（联想展开）手动标记——提取与挖掘各自独立幂等，互不阻塞。
export function requestSeenTermsExtraction(db: Store): { triggered: boolean; alreadyDone: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  db.put("meta", "seen-dig-manual", { date: today, at: new Date().toISOString() });
  if (db.get("meta", extractDoneKey(today))) return { triggered: false, alreadyDone: true };
  db.put("meta", "seen-terms-manual", { date: today, at: new Date().toISOString() });
  return { triggered: true, alreadyDone: false };
}

// 每分钟 tick：先处理手动请求（跳过一切等待），再走闸门 24h 兜底。
// running 键守卫与 runExtraction 同口径：仅 10 分钟内的标记视为进行中——
// 容器重建/崩溃留下的僵尸键不能永久卡死提取（2026-10-11 重建实测踩中）。
export function seenTermsTick(db: Store, runModel: ModelRunner) {
  const today = new Date().toISOString().slice(0, 10);
  const manual = db.get<any>("meta", "seen-terms-manual");
  const running = db.get<any>("meta", extractRunningKey(today));
  const runningFresh = running && Date.now() - Date.parse(running.at) < 10 * 60000;
  if (manual?.date === today && !db.get("meta", extractDoneKey(today)) && !runningFresh) {
    void runExtraction(db, runModel, today, "manual");
    return;
  }
  const gate = seenTermsGate(db);
  if (!gate) return;
  const lastWrite = db.get<any>("meta", "seen-terms-last-write");
  if (lastWrite?.at && lastWrite.at >= gate.at) return;
  if (Date.now() - Date.parse(gate.at) < DAY_MS) return;
  const fallbackKey = "seen-terms-fallback:" + gate.date;
  if (db.get("meta", fallbackKey)) return;
  db.put("meta", fallbackKey, { at: new Date().toISOString() });
  void runExtraction(db, runModel, gate.date, "fallback");
}

// 提取标记：agent PUT /agent/seen-terms 成功后由路由写入，证明主路径已产数据。
export function markSeenTermsWrite(db: Store) {
  db.put("meta", "seen-terms-last-write", { at: new Date().toISOString() });
}

function extractDoneKey(date: string) { return "seen-terms-extract-done:" + date; }
function extractRunningKey(date: string) { return "seen-terms-extract-running:" + date; }

async function runExtraction(db: Store, runModel: ModelRunner, dateKey: string, trigger: "manual" | "fallback") {
  const runningKey = extractRunningKey(dateKey);
  // 并发/僵尸保护：10 分钟内的 running 标记视为进行中；超时视为上次崩溃，允许重跑
  const running = db.get<any>("meta", runningKey);
  if (running && Date.now() - Date.parse(running.at) < 10 * 60000) return;
  db.put("meta", runningKey, { at: new Date().toISOString() });
  console.log(`[seen-terms] 提取开始（触发：${trigger}，日期：${dateKey}）`);
  try {
    const extracted = await extractTerms(db, runModel);
    // 回填判定：让联想展开词尽快拿到 relevance（过种子闸的前提）；空池零成本跳过
    const judged = await judgeUnjudgedTerms(db, runModel).catch((e) => {
      console.error("[seen-terms] 回填判定失败（不阻塞主流程）:", e instanceof Error ? e.message : e);
      return 0;
    });
    console.log(`[seen-terms] 提取完成（触发：${trigger}）：新观察 ${extracted} 条，回填判定 ${judged} 条`);
    db.put("meta", extractDoneKey(dateKey), { at: new Date().toISOString(), trigger, extracted, judged });
  } catch (e) {
    console.error(`[seen-terms] 提取失败（触发：${trigger}）:`, e instanceof Error ? e.message : e);
  } finally {
    db.del("meta", runningKey);
  }
}

async function extractTerms(db: Store, runModel: ModelRunner): Promise<number> {
  if (!db.config().apiKey) return 0;
  const cutoff = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const entries: { title: string; source: string }[] = [];
  for (const record of db.list<any>("discovery"))
    for (const c of record.candidates || [])
      if ((c.observedAt || record.at) >= cutoff && c.title) entries.push({ title: c.title, source: c.sourceName || "" });
  if (entries.length > 400) entries.length = 400;
  if (!entries.length) return 0;
  const prompt = PERSONA_RUBRIC +
    "以下是最多 400 条今天采集的资讯条目，每行方括号内是它的来源平台。请提取其中的实体词/新词（工具名、模型名、框架名、现象级玩法名等），" +
    "过滤纯娱乐八卦（影视明星、综艺、体育赛事），并按上方标准给每个词 relevance 三档。" +
    '只输出 JSON 数组，格式：[{"term":"词","sources":["来源平台名"],"relevance":"strong"}]——sources 填条目方括号内的真实来源平台名（可多条），绝不要把标题文字填进 sources；relevance 只能取 strong/weak/off。不要输出其他文字。\n\n' +
    entries.map((x, i) => (i + 1) + ". [" + (x.source || "未知来源") + "] " + x.title).join("\n");
  const result = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(240000), plan: "cheap" });
  const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
  if (!Array.isArray(parsed)) return 0;
  let count = 0;
  for (const item of parsed)
    if (item && typeof item.term === "string" && item.term.trim()) {
      const relevance = normalizeRelevance(item.relevance);
      observeSeenTerm(db, item.term.trim().slice(0, 80), {
        sources: Array.isArray(item.sources) ? item.sources.map(String).slice(0, 5) : [],
        offTopic: relevance === "off" || item.offTopic === true,
        relevance,
      });
      count++;
    }
  return count;
}

// persona 判定标尺（种子池污染清洗批 ②）：提取与回填判定共用同一段，
// 混合词按动态内容判定（汽车词=off），正反例给足防误标。
const PERSONA_RUBRIC = [
  "## 我们做什么（persona，相关性判断的唯一基准）",
  "AI 工作流 / 内容创作 / 独立开发 / 出海工具站——即 AI 全谱系：技术、工具、模型、AI 名人动态、AI 政策与版权、AI 内容赛道。",
  "",
  "## relevance 三档标准",
  "- strong：AI 全谱系 top 级需求。正例：AI 技术/工具/模型发布与突破信息（gpt-5、claude 新版、开源模型）；AI 名人动态（Sam Altman、黄仁勋、Dario Amodei、Ilya 等 OpenAI/Anthropic/xAI/英伟达关键人物）；AI 政策与版权（AI生成内容版权）；AI 短剧与内容赛道（AI短剧、skyreels）；独立开发与自动化（indie hacking、n8n、自动化工作流）。",
  "- weak：沾科技边但非我们主航道（通用互联网产品动态、非 AI 的编程八卦），保留观察。",
  "- off：明确圈外。反例：自动驾驶/自動駕駛=汽车行业词；自动点击器/自动连点器/自动精灵=灰产工具；影视明星（如 Alexandra Daddario）=娱乐八卦非 AI 名人；「elon musk 自動駕駛」这类混合词按动态内容判定——主体是汽车词就判 off。",
  "",
].join("\n");

function normalizeRelevance(value: unknown): PersonaRelevance | undefined {
  return value === "strong" || value === "weak" || value === "off" ? value : undefined;
}

// 回填判定（清洗批 ②）：词库里 relevance 尚未判定的非 archived 词（联想展开词天然缺档），
// 按观测数取前 200 一次 LLM 判定。判定只写 relevance，不虚增观测。空池直接跳过（零成本）。
const BACKFILL_LIMIT = 200;

export async function judgeUnjudgedTerms(db: Store, runModel: ModelRunner): Promise<number> {
  if (!db.config().apiKey) return 0;
  const pending = db.list<any>("seen-terms")
    .filter((t) => t.status !== "archived" && t.relevance !== "strong" && t.relevance !== "weak" && t.relevance !== "off")
    .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0))
    .slice(0, BACKFILL_LIMIT);
  if (!pending.length) return 0;
  const prompt = PERSONA_RUBRIC +
    "以下是词库中尚未判定相关性的词。请逐个按上方标准给 relevance 三档，不确定的判 weak，明确圈外的判 off。" +
    '只输出 JSON 数组，格式：[{"term":"词","relevance":"strong"}]。不要输出其他文字。\n\n' +
    pending.map((t, i) => (i + 1) + ". " + t.term).join("\n");
  const result = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(240000), plan: "cheap" });
  const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
  if (!Array.isArray(parsed)) return 0;
  // 只认 pending 集合内的词：模型回显清单外的词（含 archived）一律忽略
  const pendingIds = new Set(pending.map((t) => String(t.id)));
  let judged = 0;
  for (const item of parsed) {
    const relevance = normalizeRelevance(item?.relevance);
    if (!relevance || typeof item?.term !== "string" || !pendingIds.has(termId(item.term))) continue;
    if (judgeSeenTerm(db, item.term, relevance)) judged++;
  }
  return judged;
}
