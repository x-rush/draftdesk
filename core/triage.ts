// 热点语义初筛（R9-6，老大 2026-10-16 定调）：AI 对每批候选做「归类 + 注意力判级 + 双线草案」。
// 全程语义理解，无机器关键词分层——字面命中≠有注意力，判级必须 AI 语义完成。
// 当日整理当日数据：AI 不背历史组记忆，跨日重复由外部 Agent（小拾）整理时人工注明。
// 触发：批次内联（collect 采集完成即跑，属初筛不受 consumerMode 门控，档位由 config.aiPolicy.triage 控制）
// + 失败补跑/显式请求（POST /triage/generate 置 meta，triageTick 消费）。
import { z } from "zod";
import type { Store } from "./store";
import { AppError, hash, now } from "./store";
import type { DiscoveryCandidate, DiscoveryRecord } from "./discovery";
import type { Plan } from "./schema";
import { shanghaiDay } from "./model-metrics";
import type { ModelMessage } from "./model";

export type Attention = "strong" | "potential" | "none";
export const ATTENTION_LABELS: Record<Attention, string> = { strong: "强", potential: "潜力", none: "无" };
// 内容角度只落这四个内容平台（五平台里 xhs-video 后置、无内容角度位）
export const ANGLE_PLATFORMS = ["gzh", "tiebuhao", "xhs-note", "threads"] as const;

export type TriageGroup = {
  id: string;
  title: string;
  attention: Attention;
  reason: string;
  memberUrls: string[];
  representativeUrl: string;
  sources: string[];
  angles: { platform: string; angle: string }[];
  appGap?: string;
};
// candidate-groups 集合：一个采集批次一条归组记录（tg-{jobId}）。
export type TriageRecord = {
  jobId: string;
  planName: string;
  day: string;
  at: string;
  groups: TriageGroup[];
  shards: number;
  calls: number;
  tokens: number;
  merges: number;
};

// 计划级策略（R9-6②）：enabled 缺省=trends 类开、其余关；判级标准与归类粒度拼进 prompt。
export type PlanTriagePolicy = { enabled?: boolean; attentionCriteria?: string; groupGranularity?: "coarse" | "fine" };
export function triageEnabledOf(plan: Pick<Plan, "kind"> & { aiPolicy?: PlanTriagePolicy }, globalAiPolicy: { triage?: string } | null | undefined): boolean {
  if ((globalAiPolicy?.triage ?? "off") === "off") return false;
  return plan.aiPolicy?.enabled ?? plan.kind === "trends";
}
function granularityText(policy: PlanTriagePolicy | undefined): string {
  return policy?.groupGranularity === "fine"
    ? "从细：只有明确是同一事件才并组，主题相近但事件不同的保持分组"
    : "从粗：同一大事件的不同侧面、后续进展都并入同组";
}

// ---- prompt（纯函数，守护测试用）----
type ShardItem = { url: string; title: string; sourceName: string };
export function triageShardMessages(plan: Pick<Plan, "name" | "goal" | "platformAffinity"> & { aiPolicy?: PlanTriagePolicy }, shard: ShardItem[]): ModelMessage[] {
  const platforms = (plan.platformAffinity?.length ? plan.platformAffinity : [...ANGLE_PLATFORMS]).filter((p) => (ANGLE_PLATFORMS as readonly string[]).includes(p));
  const criteria = plan.aiPolicy?.attentionCriteria?.trim();
  const lines: string[] = [
    "你是内容选题工作台的语义初筛引擎。输入是同一采集批次的候选条目（i=编号，t=标题，s=来源）。依次完成：",
    "1. 归类：讲同一事件或同一主题的条目归为一组，单条也可自成一组；members 必须含组内全部编号，每个编号恰好属于一组。",
    "2. 注意力判级：每组给 attention 与一句话 reason。strong=AI/科技/创作者工具领域的强信号（重要发布、大版本、显著数据、研究策略方向上的大事件）；potential=有潜在价值、值得留观察池的次级信号；none=与 AI/科技/内容创作方向无关（纯体育赛事、时政要闻、社会民生、娱乐八卦）或无信息量的噪音。",
    `3. 双线草案：attention 非 none 的组给 angles（内容角度 0-3 条，platform 只能从 ${platforms.join("/")} 中选）；若该事件存在 web/app 配套工具缺口，给 appGap（一句话应用路线）；没有就不写该字段。`,
    `归类粒度：${granularityText(plan.aiPolicy ?? {})}。`,
    `研究策略方向（判级参照）：${plan.goal.slice(0, 160)}`,
    criteria ? `补充判级标准（优先级最高）：${criteria.slice(0, 400)}` : "",
    '只输出 JSON：{"groups":[{"members":[0,2],"title":"组主题(≤20字)","attention":"strong|potential|none","reason":"一句话理由(≤40字)","angles":[{"platform":"gzh","angle":"角度(≤30字)"}],"appGap":"路线(≤50字)"}]}。无 angles 就省略该字段；每个输入编号都必须落在某个组里。',
  ];
  return [
    { role: "system", content: lines.filter(Boolean).join("\n") },
    { role: "user", content: JSON.stringify(shard.map((c, i) => ({ i, t: c.title.slice(0, 120), s: c.sourceName.slice(0, 20) }))) },
  ];
}
export function triageMergeMessages(groups: { gid: string; title: string; attention: Attention; memberCount: number; representative: string; sources: string[] }[]): ModelMessage[] {
  return [
    {
      role: "system",
      content:
        "下面是同一采集批次各分片初步归组后的组清单（g=组id，t=组标题，a=判级，m=成员数，r=代表条目标题，s=来源）。不同分片可能把同一事件各分了一组。找出应当合并的组：keep=保留的组id，drop=并入 keep 的组id数组；合并后如需修正给 title/attention/reason 新值。判定要保守：只有高度确信是同一事件才合并。\n" +
        '只输出 JSON：{"merges":[{"keep":"g0","drop":["g3"],"title":"…","attention":"strong|potential|none","reason":"…"}]}。没有需要合并的就输出 {"merges":[]}。',
    },
    { role: "user", content: JSON.stringify(groups.map((g) => ({ g: g.gid, t: g.title, a: g.attention, m: g.memberCount, r: g.representative, s: g.sources.join("/") }))) },
  ];
}

// ---- 分片：按源聚片（同源候选同片），超长源顺延切分；片数封顶，溢出并入末片 ----
export const SHARD_SIZE = 60;
export const MAX_SHARDS = 16;
export const MIN_CANDIDATES = 8;
// 初筛池：规则筛除（filtered）的候选不进 AI——判级只对规则放行的存活池做，省 token 且口径一致；
// 池子封顶 16 片×60：病态大批次截断保出片数与 token 上界（实测 trend-radar 批 ~680 条，绰绰有余）。
export function triagePoolOf(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return candidates.filter((c) => c.status !== "filtered").slice(0, MAX_SHARDS * SHARD_SIZE);
}
// 分片按候选原序连续填充：collect 按源迭代入列，同源候选天然同片（片界除外）；
// 跨源重复集中在片间，由合并轮归并。
export function shardCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[][] {
  const shards: DiscoveryCandidate[][] = [];
  let current: DiscoveryCandidate[] = [];
  for (const c of candidates) {
    if (current.length >= SHARD_SIZE) {
      shards.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length) shards.push(current);
  return shards;
}

// ---- 模型输出解析 ----
// 抢救式：字段缺失/类型的组丢弃（覆盖兜底给其成员补单条组），不因个别畸形组废弃整片；
// 只/groups 本身缺失或全部无效才算失败（交由上层双尝试→批次失败补跑）。
const shardOutputSchema = z.object({
  groups: z
    .array(
      z.object({
        members: z.array(z.number()).max(400).optional(),
        title: z.string().max(80).optional(),
        attention: z.string().max(30).optional(),
        reason: z.string().max(300).optional(),
        angles: z.array(z.object({ platform: z.string().max(30), angle: z.string().max(150) })).max(8).optional(),
        appGap: z.string().max(300).optional(),
      }),
    )
    .max(200),
});
const mergeOutputSchema = z.object({
  merges: z
    .array(
      z.object({
        keep: z.string().max(40),
        drop: z.array(z.string().max(40)).max(40),
        title: z.string().max(80).optional(),
        attention: z.string().optional(),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(60),
});
function parseJsonLoose(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim());
}
type GroupDraft = { title: string; attention: Attention; reason: string; members: DiscoveryCandidate[]; angles: { platform: string; angle: string }[]; appGap?: string };

function normalizeAttention(v: string): Attention {
  return v === "strong" || v === "potential" ? v : "none";
}
export function parseShardOutput(text: string, shard: DiscoveryCandidate[], plan: Pick<Plan, "platformAffinity">): GroupDraft[] {
  const parsed = shardOutputSchema.parse(parseJsonLoose(text));
  const platforms = new Set<string>(plan.platformAffinity?.length ? plan.platformAffinity : ANGLE_PLATFORMS);
  const drafts: GroupDraft[] = [];
  const covered = new Set<number>();
  let dropped = 0;
  for (const g of parsed.groups) {
    const members = g.members ? [...new Set(g.members.map((n) => Math.trunc(Number(n))))].filter((i) => Number.isInteger(i) && i >= 0 && i < shard.length && !covered.has(i)) : [];
    if (!members.length || !g.title || !g.attention) {
      dropped++;
      continue;
    }
    for (const i of members) covered.add(i);
    const angles = (g.angles || [])
      .filter((a) => platforms.has(a.platform))
      .slice(0, 3)
      .map((a) => ({ platform: a.platform, angle: a.angle.trim().slice(0, 100) }))
      .filter((a) => a.angle);
    drafts.push({
      title: g.title.trim().slice(0, 40) || "未命名组",
      attention: normalizeAttention(g.attention),
      reason: (g.reason || "").trim().slice(0, 120),
      members: members.map((i) => shard[i]),
      angles,
      ...(g.appGap?.trim() ? { appGap: g.appGap.trim().slice(0, 160) } : {}),
    });
  }
  if (dropped) console.warn(`[triage] 分片抢救：丢弃 ${dropped} 个畸形组（成员由未标注兜底接住），保留 ${drafts.length} 个有效组`);
  if (!drafts.length) throw new AppError("分片输出没有任何有效组（全部畸形或为空）");
  // 覆盖兜底：AI 漏标/被丢弃的编号自成一组（无注意力，留池），保证全量覆盖
  for (const [i, c] of shard.entries()) {
    if (!covered.has(i)) drafts.push({ title: c.title.slice(0, 30), attention: "none", reason: "AI 未标注，按无注意力留池", members: [c], angles: [] });
  }
  return drafts;
}

function strongestAttention(list: Attention[]): Attention {
  if (list.includes("strong")) return "strong";
  if (list.includes("potential")) return "potential";
  return "none";
}
export function applyMerges(drafts: GroupDraft[], text: string): { groups: GroupDraft[]; merges: number } {
  const parsed = mergeOutputSchema.parse(parseJsonLoose(text));
  const alive = new Map(drafts.map((d, i) => [`g${i}`, d]));
  let merges = 0;
  for (const m of parsed.merges) {
    const keep = alive.get(m.keep);
    if (!keep) continue;
    const drops = m.drop.map((id) => alive.get(id)).filter((d): d is GroupDraft => !!d && d !== keep);
    if (!drops.length) continue;
    for (const d of drops) alive.delete(`g${drafts.indexOf(d)}`);
    keep.members = [...keep.members, ...drops.flatMap((d) => d.members)];
    if (m.title?.trim()) keep.title = m.title.trim().slice(0, 40);
    if (m.reason?.trim()) keep.reason = m.reason.trim().slice(0, 120);
    keep.attention = m.attention ? normalizeAttention(m.attention) : strongestAttention([keep.attention, ...drops.map((d) => d.attention)]);
    merges++;
  }
  return { groups: [...alive.values()], merges };
}

// ---- 主流程：分片判级 → 片间合并 → 落 TriageRecord（组 id 确定性，重跑幂等） ----
export type TriageRunner = (
  db: Store,
  messages: ModelMessage[],
  opts: { signal: AbortSignal; tier: "cheap" | "full"; maxOutputTokens: number },
) => Promise<{ text: string; usage?: number }>;
export function defaultTriageRunner(db: Store, messages: ModelMessage[], opts: { signal: AbortSignal; tier: "cheap" | "full"; maxOutputTokens: number }) {
  return import("./model").then((m) => m.requestModel(db, messages, { signal: opts.signal, json: true, plan: opts.tier, maxOutputTokens: opts.maxOutputTokens }));
}
export function groupIdOf(jobId: string, memberUrls: string[]): string {
  return "grp-" + hash(jobId + "|" + [...memberUrls].sort().join(",")).slice(0, 16);
}
function finalizeGroups(jobId: string, drafts: GroupDraft[]): TriageGroup[] {
  return drafts.map((d) => {
    const memberUrls = [...new Set(d.members.map((m) => m.url))];
    const representative = [...d.members].sort((a, b) => b.title.length - a.title.length)[0] || d.members[0];
    return {
      id: groupIdOf(jobId, memberUrls),
      title: d.title,
      attention: d.attention,
      reason: d.reason,
      memberUrls,
      representativeUrl: representative.url,
      sources: [...new Set(d.members.map((m) => m.sourceName))].slice(0, 8),
      angles: d.angles,
      ...(d.appGap ? { appGap: d.appGap } : {}),
    };
  });
}
export async function runTriage(
  db: Store,
  plan: Plan,
  jobId: string,
  candidates: DiscoveryCandidate[],
  signal: AbortSignal,
  runner: TriageRunner = defaultTriageRunner,
): Promise<TriageRecord> {
  if (candidates.length < MIN_CANDIDATES) throw new AppError(`候选不足 ${MIN_CANDIDATES} 条，不值得跑语义初筛。`);
  const tier = db.get<any>("config", "aiPolicy")?.triage === "full" ? "full" : "cheap";
  const shards = shardCandidates(candidates);
  const drafts: GroupDraft[] = [];
  let tokens = 0;
  let calls = 0;
  for (const [si, shard] of shards.entries()) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await runner(db, triageShardMessages(plan, shard), { signal, tier, maxOutputTokens: 6000 });
        tokens += res.usage ?? 0;
        calls++;
        drafts.push(...parseShardOutput(res.text, shard, plan));
        lastError = null;
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    if (lastError)
      throw new AppError(`语义初筛分片 ${si + 1}/${shards.length} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  let merges = 0;
  if (drafts.length > 1 && shards.length > 1) {
    const lastErrorHolder: { e: unknown } = { e: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const compact = drafts.map((d, i) => ({
          gid: `g${i}`,
          title: d.title,
          attention: d.attention,
          memberCount: d.members.length,
          representative: d.members[0]?.title.slice(0, 60) || "",
          sources: [...new Set(d.members.map((m) => m.sourceName))].slice(0, 3),
        }));
        const res = await runner(db, triageMergeMessages(compact), { signal, tier, maxOutputTokens: 3000 });
        tokens += res.usage ?? 0;
        calls++;
        const applied = applyMerges(drafts, res.text);
        drafts.length = 0;
        drafts.push(...applied.groups);
        merges = applied.merges;
        lastErrorHolder.e = null;
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        lastErrorHolder.e = error;
      }
    }
    // 合并轮失败不废弃整批：分组与判级已可用，只丢跨片合并
    if (lastErrorHolder.e) console.warn("[triage] 片间合并失败（保留分片结果）:", lastErrorHolder.e instanceof Error ? lastErrorHolder.e.message : lastErrorHolder.e);
  }
  return {
    jobId,
    planName: plan.name,
    day: shanghaiDay(),
    at: now(),
    groups: finalizeGroups(jobId, drafts),
    shards: shards.length,
    calls,
    tokens,
    merges,
  };
}

// ---- 名额分配（R9-6①）：按组消费判级——strong 优先占满 → potential → none 永不占 selected ----
// 纯函数：改写 candidates 的 status/reason/attention/groupId，返回入选 url（按组序）。
export function applyTriageToCandidates(candidates: DiscoveryCandidate[], groups: TriageGroup[], limit: number): string[] {
  const byUrl = new Map<string, TriageGroup>();
  for (const g of groups) for (const url of g.memberUrls) if (!byUrl.has(url)) byUrl.set(url, g);
  const tier = { strong: 0, potential: 1, none: 2 } as const;
  const ranked = groups
    .filter((g) => g.attention !== "none")
    .sort((a, b) => tier[a.attention] - tier[b.attention] || b.memberUrls.length - a.memberUrls.length);
  const winners: string[] = [];
  for (const g of ranked) for (const url of g.memberUrls) if (winners.length < limit && !winners.includes(url)) winners.push(url);
  const winnerSet = new Set(winners);
  for (const c of candidates) {
    if (c.status === "filtered") continue;
    const g = byUrl.get(c.url);
    const attention = g?.attention ?? "none";
    c.attention = attention;
    if (g) c.groupId = g.id;
    if (winnerSet.has(c.url)) {
      c.status = "selected";
      c.reason = `注意力 ${ATTENTION_LABELS[attention]}（组「${g?.title ?? "未命名"}」）：${g?.reason || "AI 语义判级"}`;
    } else {
      c.status = "watch";
      c.reason = g
        ? g.attention === "none"
          ? `注意力 无（组「${g.title}」）：${g.reason || "AI 语义判级"}`
          : `组「${g.title}」名额已满留池（${ATTENTION_LABELS[g.attention]}）：${g.reason}`
        : "注意力 无（AI 未标注）：留池待人工捞起";
    }
  }
  return winners;
}

// ---- 失败标注与补跑 ----
export function markTriageFailed(db: Store, record: DiscoveryRecord, error: unknown) {
  db.put("meta", "triage-fail:" + record.jobId, { at: now(), error: error instanceof Error ? error.message : String(error) });
  for (const c of record.candidates || []) {
    if (c.status === "filtered" || c.attention) continue;
    if (c.status === "watch" && !c.reason.includes("待语义初筛")) c.reason = `${c.reason}；待语义初筛（AI 失败，将自动补跑）`;
  }
  db.put("discovery", record.jobId, record);
}
export function requestTriage(db: Store, jobId?: string) {
  db.put("meta", "triage-request", { at: now(), ...(jobId ? { jobId } : {}) });
}
function triageRecordOf(db: Store, jobId: string): TriageRecord | undefined {
  return db.get<TriageRecord>("candidate-groups", "tg-" + jobId);
}
function pickTriageTarget(db: Store, jobId?: string): DiscoveryRecord | undefined {
  const cutoff = Date.now() - 36 * 3600000;
  const eligible = db
    .list<DiscoveryRecord>("discovery")
    .filter((r) => triagePoolOf(r.candidates || []).length >= MIN_CANDIDATES && !triageRecordOf(db, r.jobId))
    .filter((r) => (jobId ? r.jobId === jobId : (r.mode ?? "analysis") === "analysis" && Date.parse(r.at || "") >= cutoff));
  if (jobId) return eligible[0];
  const plans = new Map(db.list<any>("plans").map((p) => [p.name, p]));
  return eligible
    .filter((r) => {
      const plan = plans.get(r.planName);
      return plan && triageEnabledOf(plan, db.get<any>("config", "aiPolicy"));
    })
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
}
const AUTO_RUNS_PER_DAY = 3;
export async function triageTick(db: Store, runner: TriageRunner = defaultTriageRunner): Promise<void> {
  const request = db.get<{ jobId?: string }>("meta", "triage-request");
  let explicit = false;
  let target: DiscoveryRecord | undefined;
  if (request) {
    db.del("meta", "triage-request");
    explicit = true;
    target = pickTriageTarget(db, request.jobId);
  } else {
    const global = db.get<{ triage?: string }>("config", "aiPolicy");
    if ((global?.triage ?? "off") === "off") return;
    const day = shanghaiDay();
    const auto = db.get<any>("meta", "triage-auto:" + day);
    if ((auto?.runs ?? 0) >= AUTO_RUNS_PER_DAY) return;
    target = pickTriageTarget(db);
    if (!target) return;
    db.put("meta", "triage-auto:" + day, { at: now(), runs: (auto?.runs ?? 0) + 1 });
  }
  if (!target) return;
  const plan = db.list<Plan>("plans").find((p) => p.name === target!.planName);
  if (!plan) return;
  try {
    // tick 侧一次性 controller：补跑不随任何 HTTP 请求断连中止
    const record = await runTriage(db, plan, target.jobId, triagePoolOf(target.candidates), new AbortController().signal, runner);
    db.put("candidate-groups", "tg-" + target.jobId, record);
    applyTriageToCandidates(target.candidates, record.groups, target.limit ?? 6);
    db.put("discovery", target.jobId, target);
    db.del("meta", "triage-fail:" + target.jobId);
    console.log(`[triage] ${target.planName} 批 ${target.jobId.slice(0, 8)}：${record.groups.length} 组（强 ${record.groups.filter((g) => g.attention === "strong").length}/潜 ${record.groups.filter((g) => g.attention === "potential").length}），${record.shards} 片 ${record.calls} 调用 ${record.tokens} tokens${explicit ? "（显式请求）" : ""}`);
  } catch (error) {
    markTriageFailed(db, target, error);
    console.error("[triage] 补跑失败:", error instanceof Error ? error.message : error);
  }
}
