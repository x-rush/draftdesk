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
type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full"; model?: string }) => Promise<{ text: string; usage?: unknown }>;

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
  // 提取与判定各自隔离（2026-10-11 实测）：标题流提取会被安全敏感新闻挂死，
  // 但判定（词表输入，内容安全）必须照常落地——两段互不连坐；判定在提取之后，
  // 让本轮新词当轮就拿到 relevance（过种子闸的前提）。
  let extracted = 0;
  try {
    extracted = await extractTerms(db, runModel);
  } catch (e) {
    console.error(`[seen-terms] 标题流提取失败（判定不受影响）:`, e instanceof Error ? e.message : e);
  }
  const judged = await judgeUnjudgedTerms(db, runModel).catch((e) => {
    console.error("[seen-terms] 回填判定失败:", e instanceof Error ? e.message : e);
    return 0;
  });
  // 判定首批记账（第五轮 §5）：与 judgeBackfillTick 共享批次计数，提取批 = 当日第 1 批
  const bfPrev = db.get<any>("meta", judgeBackfillDoneKey(dateKey));
  db.put("meta", judgeBackfillDoneKey(dateKey), {
    at: new Date().toISOString(), batches: (bfPrev?.batches ?? 0) + 1, judged,
    ...(bfPrev?.busyDay ? { busyDay: true } : {}), ...(bfPrev?.heavyDay ? { heavyDay: true } : {}),
  });
  console.log(`[seen-terms] 提取完成（触发：${trigger}）：新观察 ${extracted} 条，回填判定 ${judged} 条`);
  db.put("meta", extractDoneKey(dateKey), { at: new Date().toISOString(), trigger, extracted, judged });
  db.del("meta", runningKey);
}

const EXTRACT_CHUNK = 60;
const EXTRACT_CHUNK_TIMEOUT_MS = 180000;
// 毒块降级重试模型（第三轮 4）：omni 的安全路由会被安全敏感标题挂死，
// glm 系安全路由不同——超时块自动降级重试一次。端点实测 glm-5.3 可用。
const EXTRACT_FALLBACK_MODEL = process.env.DRAFTDESK_FALLBACK_MODEL || "glm-5.3";

// 毒标题台账（第三轮 4）：记录触发挂死的分块标题样本（截断 100 字/条），
// 累积后分析共性、沉淀安全路由绕过清单。
function recordToxicSample(db: Store, chunkIndex: number, titles: string[], retryModel: string | undefined) {
  const id = `${new Date().toISOString().slice(0, 10)}:chunk${chunkIndex}`;
  db.put("toxic-samples", id, {
    id,
    at: new Date().toISOString(),
    kind: "extract-chunk-timeout",
    titles: titles.map((t) => t.slice(0, 100)),
    retryModel: retryModel ?? null,
    updatedAt: new Date().toISOString(),
  });
}

async function extractTerms(db: Store, runModel: ModelRunner): Promise<number> {
  if (!db.config().apiKey) return 0;
  const cutoff = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const entries: { title: string; source: string; observedAt: string }[] = [];
  for (const record of db.list<any>("discovery"))
    for (const c of record.candidates || [])
      if ((c.observedAt || record.at) >= cutoff && c.title) entries.push({ title: c.title, source: c.sourceName || "", observedAt: c.observedAt || record.at });
  // 提词轻量化（2026-10-11 实测）：按观测时间取最新 180 条——热词提取要的是当日信号。
  // 再按 60 条分块：安全敏感标题（智能体逃逸/凶案类）会把 omni 模型安全路由挂死，
  // 分块后毒块只烧自己的 180s，其余块照常落地（实测整包 240s 全灭）。
  const latest = entries.sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 180);
  if (!latest.length) return 0;
  let count = 0;
  for (let i = 0; i < latest.length; i += EXTRACT_CHUNK) {
    const chunk = latest.slice(i, i + EXTRACT_CHUNK);
    const prompt = PERSONA_RUBRIC +
      `以下是最近采集的资讯条目（第 ${i / EXTRACT_CHUNK + 1} 批），每行方括号内是它的来源平台。请提取其中的实体词/新词（工具名、模型名、框架名、现象级玩法名等），` +
      "过滤纯娱乐八卦（影视明星、综艺、体育赛事），并按上方标准给每个词 relevance 三档。" +
      '只输出 JSON 数组，格式：[{"term":"词","sources":["来源平台名"],"relevance":"strong"}]——sources 填条目方括号内的真实来源平台名（可多条），绝不要把标题文字填进 sources；relevance 只能取 strong/weak/off。不要输出其他文字。\n\n' +
      chunk.map((x, j) => (j + 1) + ". [" + (x.source || "未知来源") + "] " + x.title).join("\n");
    try {
      const result = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(EXTRACT_CHUNK_TIMEOUT_MS), plan: "cheap" });
      count += applyExtractedTerms(db, result.text);
    } catch (e) {
      const reason = String((e as Error)?.message || e);
      // 毒块降级重试（第三轮 4）：超时=大概率踩中 omni 安全路由挂死，换 glm 重试一次
      if (/timeout|aborted/i.test(reason)) {
        const chunkIndex = i / EXTRACT_CHUNK + 1;
        recordToxicSample(db, chunkIndex, chunk.map((x) => x.title), EXTRACT_FALLBACK_MODEL);
        try {
          const fallback = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(EXTRACT_CHUNK_TIMEOUT_MS), plan: "cheap", model: EXTRACT_FALLBACK_MODEL });
          count += applyExtractedTerms(db, fallback.text);
          console.log(`[seen-terms] 分块 ${chunkIndex}/${Math.ceil(latest.length / EXTRACT_CHUNK)} omni 超时，${EXTRACT_FALLBACK_MODEL} 重试成功`);
          continue;
        } catch (fallbackError) {
          console.error(`[seen-terms] 分块 ${chunkIndex} ${EXTRACT_FALLBACK_MODEL} 重试仍失败:`, fallbackError instanceof Error ? fallbackError.message : fallbackError);
        }
      }
      console.error(`[seen-terms] 提取分块 ${i / EXTRACT_CHUNK + 1}/${Math.ceil(latest.length / EXTRACT_CHUNK)} 失败（跳过，其余块不受影响）:`, reason.slice(0, 120));
    }
  }
  return count;
}

function applyExtractedTerms(db: Store, text: string): number {
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
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

// 回填判定（清洗批 ②，第五轮 §5 吞吐扩容）：词库里 relevance 尚未判定的非 archived 词
//（联想展开词天然缺档），按观测数取前 200 一次 LLM 判定。判定只写 relevance，不虚增观测。
// 空池直接跳过（零成本）。7112 存量积压 ÷ 200/日 = 36 天——扩容为日多批 tick（judgeBackfillTick）：
// 积压 >2000 → 16 批/日（间隔 ≥90 分钟，3200 词/日，48h 验收 <2000 的反推口径）；
// 500<积压≤2000 → 3 批/日（早/午/晚，间隔 ≥4h）；≤500 → 1 批/日。
// 完成键记「批次号 + 游标」而非当日一次；首日第一批仍随提取跑（新词当轮拿到 relevance）。
const BACKFILL_LIMIT = 200;
const BACKFILL_MID_BATCHES = 3;
const BACKFILL_HEAVY_BATCHES = 16;
const BACKFILL_MID_GAP_MS = 4 * 60 * 60000;
const BACKFILL_HEAVY_GAP_MS = 90 * 60000;

function judgeBackfillDoneKey(date: string) { return "judge-backfill-done:" + date; }

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

// 待判池计数（批数闸原料）：与 judgeUnjudgedTerms 同一过滤口径
export function unjudgedPendingCount(db: Store): number {
  return db.list<any>("seen-terms")
    .filter((t) => t.status !== "archived" && t.relevance !== "strong" && t.relevance !== "weak" && t.relevance !== "off")
    .length;
}

// 日多批判定 tick（第五轮 §5）：提取日闸之外独立跑；fire-and-forget，串行防并发（running 键）。
// consumerMode 不门控——relevance 判定是初筛（采集的一部分），external 模式照跑（§4）。
export function judgeBackfillTick(db: Store, runModel: ModelRunner, nowDate: Date = new Date()): void {
  const day = nowDate.toISOString().slice(0, 10);
  const doneKey = judgeBackfillDoneKey(day);
  const done = db.get<any>("meta", doneKey);
  const pending = unjudgedPendingCount(db);
  if (!pending) return;
  const busy = pending > 500 || done?.busyDay === true;
  const heavy = pending > 2000 || done?.heavyDay === true;
  const maxBatches = heavy ? BACKFILL_HEAVY_BATCHES : busy ? BACKFILL_MID_BATCHES : 1;
  const gapMs = heavy ? BACKFILL_HEAVY_GAP_MS : BACKFILL_MID_GAP_MS;
  if (done) {
    if ((done.batches ?? 1) >= maxBatches) return;
    if (done.at && nowDate.getTime() - Date.parse(done.at) < gapMs) return;
  }
  const running = db.get<any>("meta", "judge-backfill-running");
  if (running && Date.now() - Date.parse(running.at) < 15 * 60000) return;
  db.put("meta", "judge-backfill-running", { at: new Date().toISOString() });
  const batchNo = (done?.batches ?? 0) + 1;
  void (async () => {
    console.log(`[judge-backfill] 判定第 ${batchNo}/${maxBatches} 批开始（待判 ${pending}）`);
    try {
      const judged = await judgeUnjudgedTerms(db, runModel);
      const after = unjudgedPendingCount(db);
      db.put("meta", doneKey, { at: nowDate.toISOString(), batches: batchNo, busyDay: busy, heavyDay: heavy, judged, pendingAfter: after, cursor: after });
      console.log(`[judge-backfill] 第 ${batchNo} 批完成：判定 ${judged}，剩余待判 ${after}`);
    } catch (e) {
      console.error(`[judge-backfill] 第 ${batchNo} 批失败（批次照计，90 分钟后下一批重试，防挂死模型被打爆）:`, e instanceof Error ? e.message : e);
      db.put("meta", doneKey, { at: nowDate.toISOString(), batches: batchNo, busyDay: busy, heavyDay: heavy, judged: 0, error: String((e as Error)?.message || e).slice(0, 200) });
    } finally {
      db.del("meta", "judge-backfill-running");
    }
  })();
}
