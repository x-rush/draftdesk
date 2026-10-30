// 热词捕获（信息架构 v2 增补）：每日提取闸门、手动触发与 24h 兜底。
// 职责划分（批复修订）：主路径 = 外部 Agent（小拾）的定时任务看到闸门后
// 拉标题流做 glm5.3 提取并 PUT /agent/seen-terms；worker 只置闸门。
// 兜底 = 闸门置位 24h 仍无写入时，worker 降级执行一次内置提取（保证不断流）。
// 手动 = UI「立即整理/刷新雷达」写 seen-terms-manual 请求，tick 立即执行（跳过 24h 等待）。
import type { Store } from "./store";
import { shanghaiDayOf } from "./tick-guard";
import { judgeSeenTerm, observeSeenTerm, termId } from "./seen-terms";
import type { PersonaRelevance, DemandIntent } from "./seen-terms";
import { normalizeDemandIntent } from "./seen-terms";

const GATE_KEY = "seen-terms-gate";
const DAY_MS = 86400000;
type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal; plan?: "cheap" | "full"; model?: string }) => Promise<{ text: string; usage?: unknown }>;

// 闸门：所有启用调度计划「最近 24 小时内存在 completed」（滚动窗口，规避 UTC 日期边界——
// 北京白天采集的任务 finishedAt 的 UTC 日期恒为「昨天」，按日历日比较会让闸门白天永不置位）
// 且无排队/运行中 → 置位 { date, at }（每日一次，幂等）。
export function seenTermsGate(db: Store): { date: string; at: string } | undefined {
  // R10.11-5：计划调度已废弃（R10.9 P2-1 scheduleTick 删除）——闸门改由
  // 当日 collect-all 批触发（01:00 全量采集落盘即开闸），语义对齐 R10 四段流水线
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const gate = db.get<any>("meta", GATE_KEY);
  if (gate?.date === today) return gate;
  const collectAllDone = db.get<any>("meta", "collect-all-done:" + today);
  if (!collectAllDone) return gate;
  const at = new Date().toISOString();
  db.put("meta", GATE_KEY, { date: today, at });
  return { date: today, at };
}

// 手动触发（UI「立即整理/刷新雷达」）：当日内一次；已完成则 alreadyDone。
// 同时写挖掘（联想展开）手动标记——提取与挖掘各自独立幂等，互不阻塞。
export function requestSeenTermsExtraction(db: Store): { triggered: boolean; alreadyDone: boolean } {
  const today = shanghaiDayOf(); // R10.31：上海日
  db.put("meta", "seen-dig-manual", { date: today, at: new Date().toISOString() });
  if (db.get("meta", extractDoneKey(today))) return { triggered: false, alreadyDone: true };
  db.put("meta", "seen-terms-manual", { date: today, at: new Date().toISOString() });
  return { triggered: true, alreadyDone: false };
}

// 每分钟 tick：先处理手动请求（跳过一切等待），再走闸门 24h 兜底。
// running 键守卫与 runExtraction 同口径：仅 10 分钟内的标记视为进行中——
// 容器重建/崩溃留下的僵尸键不能永久卡死提取（2026-10-11 重建实测踩中）。
export function seenTermsTick(db: Store, runModel: ModelRunner) {
  const today = shanghaiDayOf(); // R10.31：上海日
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
  const id = `${shanghaiDayOf()}:chunk${chunkIndex}`; // R10.31：上海日
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
      const prompt = buildRelevanceRubric(db) +
      `以下是最近采集的资讯条目（第 ${i / EXTRACT_CHUNK + 1} 批），每行方括号内是它的来源平台。请提取其中的实体词/新词（工具名、模型名、框架名、现象级玩法名等），` +
      "过滤纯娱乐八卦（影视明星、综艺、体育赛事），并按上方标准给每个词 relevance 三档；relevance 为 strong 的词再按上方 demandIntent 意图三分类给 intent，并用不超过 40 字说明判据（命中哪条标准/来自哪条标题的关键信号）。" +
      '只输出 JSON 数组，格式：[{"term":"词","sources":["来源平台名"],"relevance":"strong","demandIntent":"tool","rationale":"命中 strong 的工具发布正例"}]——sources 填条目方括号内的真实来源平台名（可多条），绝不要把标题文字填进 sources；relevance 只能取 strong/weak/off；demandIntent 只能取 tool/info/nav（strong 必填，其余档位省略）；rationale 为判据短句（可选，倾向都给）。不要输出其他文字。\n\n' +
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
      const term = item.term.trim().slice(0, 80);
      // redLine 硬规则（§2.6②）：命中红线词强制 off，不依赖 LLM 判对
      const redlined = redLineMatch(db, term);
      const relevance = redlined ? "off" : normalizeRelevance(item.relevance);
      // demandIntent（第七轮 W7-1）：只在 strong 落库（tool 型词直通站群候选池）
      const demandIntent = relevance === "strong" ? normalizeDemandIntent(item.demandIntent) : undefined;
      const rationale = normalizeRationale(item?.rationale);
      observeSeenTerm(db, term, {
        sources: Array.isArray(item.sources) ? item.sources.map(String).slice(0, 5) : [],
        offTopic: relevance === "off" || item.offTopic === true || !!redlined,
        relevance,
        ...(demandIntent ? { demandIntent } : {}),
        ...(rationale ? { rationale } : {}),
      });
      count++;
    }
  return count;
}

// persona 判定标尺（种子池污染清洗批 ②）：提取与回填判定共用同一段，
// 混合词按动态内容判定（汽车词=off），正反例给足防误标。
const PERSONA_RUBRIC = [
  "深度判断方法论参照 skills/seo-methodology/SKILL.md（哥飞 SEO 方法论判定引擎，工作台内置）。",
  "## 我们做什么（persona，相关性判断的唯一基准）",
  "AI 工作流 / 内容创作 / 独立开发 / 出海工具站——即 AI 全谱系：技术、工具、模型、AI 名人动态、AI 政策与版权、AI 内容赛道。",
  "",
  "## relevance 三档标准",
  "- strong：AI 全谱系 top 级需求。正例：AI 技术/工具/模型发布与突破信息（gpt-5、claude 新版、开源模型）；AI 名人动态（Sam Altman、黄仁勋、Dario Amodei、Ilya 等 OpenAI/Anthropic/xAI/英伟达关键人物）；AI 政策与版权（AI生成内容版权）；AI 短剧与内容赛道（AI短剧、skyreels）；独立开发与自动化（indie hacking、n8n、自动化工作流）。",
  "- weak：沾科技边但非我们主航道（通用互联网产品动态、非 AI 的编程八卦），保留观察。",
  "- off：明确圈外。反例：自动驾驶/自動駕駛=汽车行业词；自动点击器/自动连点器/自动精灵=灰产工具；影视明星（如 Alexandra Daddario）=娱乐八卦非 AI 名人；「elon musk 自動駕駛」这类混合词按动态内容判定——主体是汽车词就判 off。",
  "",
].join("\n");

// ---- 判定标尺统一读 persona.termPolicy（第六轮批 A §2.6，老大 10:28）----
// config.persona.termPolicy（strongHint/weakHint/offHint/redLine）与《选题标准与画像》同源，
// 是 termPolicy 三档标准的用户自定义版本：**给了就以 termPolicy 替换内置「三档标准」节**
//（persona 头与输出格式保留），缺失/为空回退默认 RUBRIC（社区玩家无感）。
// redLine 另作判定后的硬规则二次过滤（redLineMatch → 强制 off），不依赖 LLM 判对。
export function buildRelevanceRubric(db: Store): string {
  return appendIntentPolicy(db, buildRelevanceRubricInner(db));
}

function buildRelevanceRubricInner(db: Store): string {
  const persona = db.get<any>("config", "persona");
  const tp = persona?.termPolicy;
  if (!tp || typeof tp !== "object") return PERSONA_RUBRIC;
  const hints = [tp.strongHint && `- strong：${tp.strongHint}`, tp.weakHint && `- weak：${tp.weakHint}`, tp.offHint && `- off：${tp.offHint}`].filter(Boolean);
  if (!hints.length) return PERSONA_RUBRIC;
  // 按行替换「## relevance 三档标准」节（到下一 ## 或结尾）——RUBRIC 尾部只有单换行，
  // 正则前瞻 (?=\n\n) 不命中（实弹单测抓到）。
  const lines = PERSONA_RUBRIC.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## relevance 三档标准"));
  if (start < 0) return PERSONA_RUBRIC;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) { end = i; break; }
  const replacement = [
    "## relevance 三档标准（persona.termPolicy 自定义，覆盖内置默认）",
    ...hints,
    ...(tp.redLine ? [`- redLine（命中硬规则强制 off，不经模型）：${tp.redLine}`] : []),
  ];
  lines.splice(start, end - start, ...replacement);
  return lines.join("\n");
}

// ---- demandIntent 意图三分类标尺（第七轮 W7-1，与 termPolicy 同一处拼接）----
// persona.intentPolicy（tool/info/nav 三节 hint）给了就整节替换内置默认，
// 缺失回退内置定义；外部 Agent 复核读同一 persona.intentPolicy（规则同源）。
// 判 strong 时顺带产出 demandIntent 落词库，tool 型词直通站群候选池。
const INTENT_POLICY_DEFAULT: Record<string, string> = {
  tool: "有工具/产品需求语义——用户想用工具完成任务。词根族：generator/converter/calculator/checker/tracker/maker/builder/formatter/scanner/finder/monitor 等。",
  info: "资讯/教程/学习需求——用户想了解或学习。特征词：how to/what is/tutorial/guide/best/教程/怎么/如何/是什么。",
  nav: "导航/品牌需求——用户想去某个具体网站或找某品牌。特征：品牌名/官网/login/download/官网词。",
};

export function intentPolicySection(db: Store): string {
  const ip = db.get<any>("config", "persona")?.intentPolicy;
  const custom = ip && typeof ip === "object"
    ? [ip.tool && `- tool：${ip.tool}`, ip.info && `- info：${ip.info}`, ip.nav && `- nav：${ip.nav}`].filter(Boolean)
    : [];
  const defs = custom.length ? custom : Object.entries(INTENT_POLICY_DEFAULT).map(([k, v]) => `- ${k}：${v}`);
  return [
    "## demandIntent 意图三分类（relevance=strong 的词必填 demandIntent）",
    ...defs,
    "输出规则：relevance=strong 的词 demandIntent 必填（tool/info/nav 三选一）；weak/off 一律省略该字段。",
  ].join("\n");
}

function appendIntentPolicy(db: Store, rubric: string): string {
  return `${rubric}\n${intentPolicySection(db)}`;
}

// redLine 关键词抽取：按括号/斜杠/顿号切分，滤掉动作短语段（「直接 off/不进判定流水」等），
// 剩余片段即硬规则关键词（当前 redLine → ["出镜直播","私域拉群","电商囤货","灰产"]）。
const REDLINE_STOP = /^(?:四禁忌相关词|相关词|直接 off|直接|off|不进判定流水|不进|判定流水|redLine|判定)$/i;
export function extractRedLineKeywords(redLine: string): string[] {
  return String(redLine || "")
    .split(/[（）()、，,；;\n]/)
    .join("/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length >= 2 && seg.length <= 12 && !REDLINE_STOP.test(seg) && !/直接|不进|流水/.test(seg));
}

export function redLineMatch(db: Store, term: string): string | undefined {
  const tp = db.get<any>("config", "persona")?.termPolicy;
  if (!tp?.redLine) return undefined;
  const kw = extractRedLineKeywords(String(tp.redLine)).find((k) => term.toLowerCase().includes(k.toLowerCase()));
  return kw ? String(tp.redLine).slice(0, 80) : undefined;
}

function normalizeRelevance(value: unknown): PersonaRelevance | undefined {
  return value === "strong" || value === "weak" || value === "off" ? value : undefined;
}

// 判定判据短句（W7-1 可解释性）：截断 160 字防灌水
export function normalizeRationale(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim().slice(0, 160);
  return t || undefined;
}

// 回填判定（清洗批 ②，第五轮 §5 吞吐扩容）：词库里 relevance 尚未判定的非 archived 词
//（联想展开词天然缺档），按观测数取前 200 一次 LLM 判定。判定只写 relevance，不虚增观测。
// 空池直接跳过（零成本）。7112 存量积压 ÷ 200/日 = 36 天——扩容为日多批 tick（judgeBackfillTick）：
// 积压 >2000 → 16 批/日（间隔 ≥90 分钟，3200 词/日，48h 验收 <2000 的反推口径）；
// 500<积压≤2000 → 3 批/日（早/午/晚，间隔 ≥4h）；≤500 → 1 批/日。
// 完成键记「批次号 + 游标」而非当日一次；首日第一批仍随提取跑（新词当轮拿到 relevance）。
const BACKFILL_LIMIT = 200;
// 子批拆分（R9-7②）：单批 200 词的输出合同在 qwen 上连续三日撞 240s 超时（judged 0）——
// 拆 50 词/子批串行调用，单子批输出短一个量级；超时/中止/预算类失败终止本批剩余子批
//（模型整体慢时连打徒耗），解析类失败继续下一子批；失败归因进 done 键与日志，不再静默全废。
const BACKFILL_SUBBATCH = 50;
const BACKFILL_MID_BATCHES = 3;
const BACKFILL_HEAVY_BATCHES = 16;
const BACKFILL_MID_GAP_MS = 4 * 60 * 60000;
const BACKFILL_HEAVY_GAP_MS = 90 * 60000;

function judgeBackfillDoneKey(date: string) { return "judge-backfill-done:" + date; }

export async function judgeUnjudgedTerms(db: Store, runModel: ModelRunner): Promise<number> {
  if (!db.config().apiKey) return 0;
  // R10.38 下推：未判=relevance 不在三档（NULL 计未判）——生成列索引取候选再 JS 精滤
  const pending = db.kv.selectWhere<any>("seen-terms", `("relevance" IS NULL OR "relevance" NOT IN ('strong','weak','off'))`)
    .map((r) => r.body)
    .filter((t) => t.status !== "archived")
    .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0))
    .slice(0, BACKFILL_LIMIT);
  if (!pending.length) return 0;
  const rubric = buildRelevanceRubric(db) +
    "以下是词库中尚未判定相关性的词。请逐个按上方标准给 relevance 三档，不确定的判 weak，明确圈外的判 off；relevance 为 strong 的词再按上方 demandIntent 意图三分类给 intent，并用不超过 40 字说明判据（命中哪条标准）。" +
    '只输出 JSON 数组，格式：[{"term":"词","relevance":"strong","demandIntent":"tool","rationale":"命中 strong 的模型发布正例"}]。不要输出其他文字。';
  const subbatches: (typeof pending)[] = [];
  for (let i = 0; i < pending.length; i += BACKFILL_SUBBATCH) subbatches.push(pending.slice(i, i + BACKFILL_SUBBATCH));
  let judged = 0;
  const failures: string[] = [];
  for (const [index, sub] of subbatches.entries()) {
    const prompt = rubric + "\n\n" + sub.map((t, i) => (i + 1) + ". " + t.term).join("\n");
    try {
      const result = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(240000), plan: "cheap" });
      const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
      if (!Array.isArray(parsed)) throw new Error("输出不是 JSON 数组");
      // 只认子批集合内的词：模型回显清单外的词（含 archived）一律忽略
      const pendingIds = new Set(sub.map((t) => String(t.id)));
      for (const item of parsed) {
        if (!item || typeof item?.term !== "string") continue;
        if (!pendingIds.has(termId(item.term))) continue;
        // redLine 硬规则（§2.6②）：命中红线词强制 off（LLM 判 strong/weak 也压掉）
        const redlined = redLineMatch(db, item.term);
        const relevance = redlined ? "off" as PersonaRelevance : normalizeRelevance(item?.relevance);
        if (!relevance) continue;
        // demandIntent（第七轮 W7-1）：只在 strong 落库（tool 型词直通站群候选池）
        const demandIntent = relevance === "strong" ? normalizeDemandIntent(item?.demandIntent) : undefined;
        const rationale = normalizeRationale(item?.rationale);
        if (judgeSeenTerm(db, item.term, relevance, { demandIntent, rationale })) judged++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`子批${index + 1}/${subbatches.length}: ${message.slice(0, 120)}`);
      // 超时/中止/预算不足 = 模型或额度整体性异常，本批剩余子批不再连打（下批闸 90min/4h 后重试）
      if (/timeout|aborted|中止|预算不足|百炼请求失败/i.test(message)) break;
    }
  }
  if (failures.length && judged === 0)
    throw new Error(`${failures.length}/${subbatches.length} 子批失败：${failures.join("；")}`);
  if (failures.length)
    console.warn(`[judge-backfill] 部分子批失败（已判 ${judged}）：${failures.join("；").slice(0, 300)}`);
  return judged;
}

// 待判池计数（批数闸原料）：与 judgeUnjudgedTerms 同一过滤口径
export function unjudgedPendingCount(db: Store): number {
  return db.kv.selectWhere<any>("seen-terms", `("relevance" IS NULL OR "relevance" NOT IN ('strong','weak','off'))`)
    .map((r) => r.body)
    .filter((t) => t.status !== "archived").length;
}

// 日多批判定 tick（第五轮 §5）：提取日闸之外独立跑；fire-and-forget，串行防并发（running 键）。
// consumerMode 不门控——relevance 判定是初筛（采集的一部分），external 模式照跑（§4）。
export function judgeBackfillTick(db: Store, runModel: ModelRunner, nowDate: Date = new Date()): void {
  const day = shanghaiDayOf(nowDate); // R10.31：上海日
  const doneKey = judgeBackfillDoneKey(day);
  const done = db.get<any>(("meta"), doneKey);
  // 性能修复（2026-10-28 生产 CPU 事件，与 seenJudgeTick 同款闸序倒置）：
  // done 满批/间隔/running 守卫提前到 unjudgedPendingCount 全表扫之前——
  // 原顺序每 1.5s 无条件全表拉 seen-terms（≈60ms）才判 done 满批秒退。
  // busy/heavy 用 done 日级标志（与 pending 长度判定同源不冲突）。
  if (done) {
    const busyEarly = done.busyDay === true;
    const heavyEarly = done.heavyDay === true;
    const maxEarly = heavyEarly ? BACKFILL_HEAVY_BATCHES : busyEarly ? BACKFILL_MID_BATCHES : 1;
    const gapEarly = heavyEarly ? BACKFILL_HEAVY_GAP_MS : BACKFILL_MID_GAP_MS;
    if ((done.batches ?? 1) >= maxEarly) return;
    if (done.at && nowDate.getTime() - Date.parse(done.at) < gapEarly) return;
  }
  const runningEarly = db.get<any>("meta", "judge-backfill-running");
  if (runningEarly && Date.now() - Date.parse(runningEarly.at) < 15 * 60000) return;
  const pending = unjudgedPendingCount(db);
  if (!pending) return;
  const busy = pending > 500 || done?.busyDay === true;
  const heavy = pending > 2000 || done?.heavyDay === true;
  const maxBatches = heavy ? BACKFILL_HEAVY_BATCHES : busy ? BACKFILL_MID_BATCHES : 1;
  const gapMs = heavy ? BACKFILL_HEAVY_GAP_MS : BACKFILL_MID_GAP_MS;
  const running = runningEarly;
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
