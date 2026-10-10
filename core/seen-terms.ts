// 热词捕获（信息架构 v2 增补）：seen-terms 数据层与晋级逻辑。
// 状态机：new（首见）→ rising（observations≥2）→ sustained（daysSeen 连续 3 天）→ archived（人工）。
// 双写合并（批复 D）：API PUT 走 mergeSeenTerm（sources 并集 / observations 取 max / status 只升不降）；
// 内置提取走 observeSeenTerm（observations+1 / daysSeen 记日期 / 晋级）。
// 结构化最小接口：Store 与 KV 都满足（避免把调用方绑死在 KV 类上）
type TermStore = { get<T>(collection: string, id: string): T | undefined; put<T>(collection: string, id: string, value: T): T };

export type SeenTermStatus = "new" | "rising" | "sustained" | "archived";
const RANK: Record<SeenTermStatus, number> = { new: 0, rising: 1, sustained: 2, archived: 3 };

export function termId(term: string): string {
  return term.trim().toLowerCase();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// status 只升不降（archived 除外——archived 只能人工设置，机器永不降级/升级它）
function upgradeStatus(current: SeenTermStatus | undefined, next: SeenTermStatus): SeenTermStatus {
  if (current === "archived") return "archived";
  return RANK[next] > RANK[current ?? "new"] ? next : (current ?? "new");
}

export function getSeenTerm(kv: TermStore, term: string): any | undefined {
  return kv.get("seen-terms", termId(term));
}

// 外部 Agent upsert（批复 D 合并语义）
export function mergeSeenTerm(kv: TermStore, input: {
  term: string; sources?: string[]; relatedSearches?: string[]; offTopic?: boolean;
  status?: SeenTermStatus; frequency?: number; observations?: number; lastSeenAt?: string;
}, by: string) {
  const id = termId(input.term);
  const prev = kv.get<any>("seen-terms", id);
  const status = input.status && input.status !== "archived" ? upgradeStatus(prev?.status, input.status) : prev?.status ?? "new";
  const doc = {
    id,
    term: prev?.term ?? input.term.trim(),
    firstSeenAt: prev?.firstSeenAt ?? input.lastSeenAt ?? now0(),
    lastSeenAt: [input.lastSeenAt, prev?.lastSeenAt].filter(Boolean).sort().at(-1),
    sources: [...new Set([...(prev?.sources || []), ...(input.sources || [])])],
    relatedSearches: [...new Set([...(prev?.relatedSearches || []), ...(input.relatedSearches || [])])],
    observations: Math.max(prev?.observations ?? 0, input.observations ?? 0, input.frequency ?? 0),
    status,
    offTopic: input.offTopic ?? prev?.offTopic,
    daysSeen: prev?.daysSeen ?? [],
    producedBy: by,
    updatedAt: now0(),
    ...(prev?.createdAt ? {} : { createdAt: now0() }),
  };
  kv.put("seen-terms", id, doc);
  return doc;
}

// 内置提取/晋级（每日一次）：observations+1、daysSeen 记日期、按阈值晋级
export function observeSeenTerm(kv: TermStore, term: string, opts: { sources?: string[]; offTopic?: boolean; day?: string } = {}) {
  const id = termId(term);
  const prev = kv.get<any>("seen-terms", id);
  const day = opts.day ?? today();
  const observations = (prev?.observations ?? 0) + 1;
  const daysSeen: string[] = [...new Set([...(prev?.daysSeen || []), day])].sort();
  let status: SeenTermStatus = prev?.status ?? "new";
  if (status !== "archived") {
    if (status === "new" && observations >= 2) status = "rising";
    if (status === "rising" && has3Consecutive(daysSeen)) status = "sustained";
  }
  const doc = {
    id,
    term: prev?.term ?? term.trim(),
    firstSeenAt: prev?.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    sources: [...new Set([...(prev?.sources || []), ...(opts.sources || [])])],
    relatedSearches: prev?.relatedSearches || [],
    observations,
    status,
    daysSeen,
    offTopic: opts.offTopic ?? prev?.offTopic,
    producedBy: prev?.producedBy ?? "builtin-extract/1.0.0",
    updatedAt: now0(),
    ...(prev?.createdAt ? {} : { createdAt: now0() }),
  };
  kv.put("seen-terms", id, doc);
  return doc;
}

export function has3Consecutive(days: string[]): boolean {
  const set = new Set(days);
  const sorted = [...set].sort();
  for (let i = 2; i < sorted.length; i++) {
    const a = new Date(sorted[i - 2] + "T00:00:00Z").getTime();
    const b = new Date(sorted[i - 1] + "T00:00:00Z").getTime();
    const c = new Date(sorted[i] + "T00:00:00Z").getTime();
    if (c - b === 86400000 && b - a === 86400000) return true;
  }
  return false;
}

function now0() { return new Date().toISOString(); }

// 主路径写入标记：外部 Agent PUT 成功后调用，供 worker 兜底闸门判断「今日已有数据」。
export function markSeenTermsWrite(kv: TermStore) {
  kv.put("meta", "seen-terms-last-write", { at: new Date().toISOString() });
}
