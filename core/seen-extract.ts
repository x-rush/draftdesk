// 热词捕获（信息架构 v2 增补）：每日提取闸门与 24h 兜底。
// 职责划分（批复修订）：主路径 = 外部 Agent（小拾）的定时任务看到闸门后
// 拉标题流做 glm5.3 提取并 PUT /agent/seen-terms；worker 只置闸门。
// 兜底 = 闸门置位 24h 仍无写入时，worker 降级执行一次内置提取（保证不断流）。
import type { Store } from "./store";
import type { ModelMessage } from "./model";
import { observeSeenTerm } from "./seen-terms";

const GATE_KEY = "seen-terms-gate";
const DAY_MS = 86400000;
type ModelRunner = (db: Store, messages: ModelMessage[], opts: { signal: AbortSignal }) => Promise<{ text: string; usage?: unknown }>;

// 闸门：当日所有启用调度计划的任务都已完成（存在 finishedAt 为今日的 completed 任务）
// 且无排队/运行中 → 置位 { date, at }（每日一次，幂等）。
export function seenTermsGate(db: Store): { date: string; at: string } | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const gate = db.get<any>("meta", GATE_KEY);
  if (gate?.date === today) return gate;
  const scheduled = db.list<any>("plans").filter((p) => p.scheduleEnabled);
  if (!scheduled.length) return gate;
  const jobs = db.list<any>("jobs");
  const doneToday = (id: string) => jobs.some((j) => j.planId === id && j.state === "completed" && (j.finishedAt || "").slice(0, 10) === today);
  const allDone = scheduled.every((p) => doneToday(p.id));
  const noneActive = !jobs.some((j) => ["queued", "running"].includes(j.state));
  if (!allDone || !noneActive) return gate;
  const at = new Date().toISOString();
  db.put("meta", GATE_KEY, { date: today, at });
  return { date: today, at };
}

// 每分钟 tick 调用：闸门置位 24h 仍无主路径写入 → 兜底提取一次（每日一次幂等）。
// 失败静默：兜底尽力而为，不断流责任在主路径；次日闸门自然重开。
export function seenTermsTick(db: Store, runModel: ModelRunner) {
  const gate = seenTermsGate(db);
  if (!gate) return;
  const lastWrite = db.get<any>("meta", "seen-terms-last-write");
  if (lastWrite?.at && lastWrite.at >= gate.at) return;
  if (Date.now() - Date.parse(gate.at) < DAY_MS) return;
  const fallbackKey = "seen-terms-fallback:" + gate.date;
  if (db.get("meta", fallbackKey)) return;
  db.put("meta", fallbackKey, { at: new Date().toISOString() });
  void runFallbackExtraction(db, runModel);
}

// 提取标记：agent PUT /agent/seen-terms 成功后由路由写入，证明主路径已产数据。
export function markSeenTermsWrite(db: Store) {
  db.put("meta", "seen-terms-last-write", { at: new Date().toISOString() });
}

async function runFallbackExtraction(db: Store, runModel: ModelRunner) {
  try {
    if (!db.config().apiKey) return;
    const cutoff = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const titles: string[] = [];
    for (const record of db.list<any>("discovery"))
      for (const c of record.candidates || [])
        if ((c.observedAt || record.at) >= cutoff && c.title) titles.push(c.title);
    if (titles.length > 400) titles.length = 400;
    if (!titles.length) return;
    const prompt = "以下是最多 400 条今天采集的资讯标题。请提取其中的实体词/新词（工具名、模型名、框架名、现象级玩法名等），" +
      "过滤纯娱乐八卦（影视明星、综艺、体育赛事）。与 AI/开发/软件工具领域相关的词 offTopic=false，圈外热词也保留但 offTopic=true。" +
      '只输出 JSON 数组，格式：[{"term":"词","sources":["来源1"],"offTopic":false}]，不要输出其他文字。\n\n' +
      titles.map((t, i) => (i + 1) + ". " + t).join("\n");
    const result = await runModel(db, [{ role: "user" as const, content: prompt }], { signal: AbortSignal.timeout(120000) });
    const parsed = JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
    if (!Array.isArray(parsed)) return;
    for (const item of parsed)
      if (item && typeof item.term === "string" && item.term.trim())
        observeSeenTerm(db, item.term.trim().slice(0, 80), { sources: Array.isArray(item.sources) ? item.sources.map(String).slice(0, 5) : [], offTopic: item.offTopic === true });
  } catch {
    // 兜底失败静默：主路径与明日闸门仍可用
  }
}
