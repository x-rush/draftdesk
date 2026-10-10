// 热词捕获（信息架构 v2 增补）：每日提取闸门、手动触发与 24h 兜底。
// 职责划分（批复修订）：主路径 = 外部 Agent（小拾）的定时任务看到闸门后
// 拉标题流做 glm5.3 提取并 PUT /agent/seen-terms；worker 只置闸门。
// 兜底 = 闸门置位 24h 仍无写入时，worker 降级执行一次内置提取（保证不断流）。
// 手动 = UI「立即整理/刷新雷达」写 seen-terms-manual 请求，tick 立即执行（跳过 24h 等待）。
import type { Store } from "./store";
import { observeSeenTerm } from "./seen-terms";

const GATE_KEY = "seen-terms-gate";
const DAY_MS = 86400000;
type ModelRunner = (db: Store, messages: { role: "user"; content: string }[], opts: { signal: AbortSignal }) => Promise<{ text: string; usage?: unknown }>;

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
export function requestSeenTermsExtraction(db: Store): { triggered: boolean; alreadyDone: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  if (db.get("meta", extractDoneKey(today))) return { triggered: false, alreadyDone: true };
  db.put("meta", "seen-terms-manual", { date: today, at: new Date().toISOString() });
  return { triggered: true, alreadyDone: false };
}

// 每分钟 tick：先处理手动请求（跳过一切等待），再走闸门 24h 兜底。
export function seenTermsTick(db: Store, runModel: ModelRunner) {
  const today = new Date().toISOString().slice(0, 10);
  const manual = db.get<any>("meta", "seen-terms-manual");
  if (manual?.date === today && !db.get("meta", extractDoneKey(today)) && !db.get("meta", extractRunningKey(today))) {
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
    console.log(`[seen-terms] 提取完成（触发：${trigger}）：新观察 ${extracted} 条`);
    db.put("meta", extractDoneKey(dateKey), { at: new Date().toISOString(), trigger, extracted });
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
  const prompt = "以下是最多 400 条今天采集的资讯条目，每行方括号内是它的来源平台。请提取其中的实体词/新词（工具名、模型名、框架名、现象级玩法名等），" +
    "过滤纯娱乐八卦（影视明星、综艺、体育赛事）。与 AI/开发/软件工具领域相关的词 offTopic=false，圈外热词也保留但 offTopic=true。" +
    '只输出 JSON 数组，格式：[{"term":"词","sources":["来源平台名"],"offTopic":false}]——sources 填条目方括号内的真实来源平台名（可多条），绝不要把标题文字填进 sources。不要输出其他文字。\n\n' +
    entries.map((x, i) => (i + 1) + ". [" + (x.source || "未知来源") + "] " + x.title).join("\n");
  const result = await runModel(db, [{ role: "user", content: prompt }], { signal: AbortSignal.timeout(120000) });
  const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
  if (!Array.isArray(parsed)) return 0;
  let count = 0;
  for (const item of parsed)
    if (item && typeof item.term === "string" && item.term.trim()) {
      observeSeenTerm(db, item.term.trim().slice(0, 80), { sources: Array.isArray(item.sources) ? item.sources.map(String).slice(0, 5) : [], offTopic: item.offTopic === true });
      count++;
    }
  return count;
}
