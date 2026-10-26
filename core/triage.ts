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

// 全量采集批的初筛伪计划（唯一定义在此；collect-all.ts 经 import 复用——triage 不反向 import collect-all，无环）
export const COLLECT_ALL_PLAN_NAME = "全量采集";
export function defaultTriagePlan() {
  return {
    id: "collect-all", name: COLLECT_ALL_PLAN_NAME, kind: "trends" as const,
    goal: "追踪 AI/科技领域热点与创作者工具机会，为多平台内容选题与独立开发应用机会提供素材",
    audience: "AI 从业者与独立开发者", keywords: [], excludeKeywords: [], includeDomains: [], sourceIds: [],
    lookbackDays: 7, maxEvidence: 300, maxQueries: 0, maxItems: 8, maxModelCalls: 12, maxTokens: 2000000,
    scheduleEnabled: false, dailyTime: "01:00", publishPolicy: "manual" as const,
    platformAffinity: ["gzh", "tiebuhao", "xhs-note", "threads", "x", "facebook", "instagram", "linkedin"] as ("gzh" | "tiebuhao" | "xhs-note" | "threads" | "x" | "facebook" | "instagram" | "linkedin")[],
  };
}
import type { ModelMessage } from "./model";

export type Attention = "strong" | "potential" | "none";
export const ATTENTION_LABELS: Record<Attention, string> = { strong: "强", potential: "潜力", none: "无" };
// 内容角度只落这四个内容平台（五平台里 xhs-video 后置、无内容角度位）
// R10：内容角度平台扩 8 值（xhs-video 视频后置，不进角度草案）
export const ANGLE_PLATFORMS = ["gzh", "tiebuhao", "xhs-note", "threads", "x", "facebook", "instagram", "linkedin"] as const;

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
  // R10 第2段：初筛默认全开（不再只 trends）——计划可用 aiPolicy.enabled=false 显式退出
  return plan.aiPolicy?.enabled ?? true;
}
function granularityText(policy: PlanTriagePolicy | undefined): string {
  return policy?.groupGranularity === "fine"
    ? "从细：只有明确是同一事件才并组，主题相近但事件不同的保持分组"
    : "从粗：同一大事件的不同侧面、后续进展都并入同组";
}

// ---- prompt（纯函数，守护测试用）----
type ShardItem = { url: string; title: string; sourceName: string };
// 判级边界 few-shot（小拾审查 P1）：定义文解决不了边界案例——示例教边界比定义文有效一个量级。
// 五条覆盖：平淡标题但 strong / 蹭 AI 词但娱乐 none / 产品资讯 potential / 价格大变动 strong / 用户数 potential。
const ATTENTION_FEW_SHOT = [
  '判级示例（边界参照，同型同判）：',
  '- {"t":"HF trending 第一的开源推理框架，README 三天上千星"} → strong（标题平淡但领域强信号：开发者用脚投票）',
  '- {"t":"某明星用 AI 修复老照片上热搜"} → none（蹭 AI 词的娱乐向话题，非技术/工具/需求信号）',
  '- {"t":"大厂发布新款智能音箱，接入第三方大模型"} → potential（有 AI 要素但属单点产品资讯，观察后续生态动作）',
  '- {"t":"某模型 API 突降 80%，开发者讨论迁移方案"} → strong（价格大变动+迁移需求，工具生态直接受影响）',
  '- {"t":"某助手类 App 宣称用户破一亿"} → potential（用户规模数据，但非开发/工具向的强信号）',
].join("\n");
export function triageShardMessages(plan: Pick<Plan, "name" | "goal" | "platformAffinity"> & { aiPolicy?: PlanTriagePolicy }, shard: ShardItem[]): ModelMessage[] {
  const platforms = (plan.platformAffinity?.length ? plan.platformAffinity : [...ANGLE_PLATFORMS]).filter((p) => (ANGLE_PLATFORMS as readonly string[]).includes(p));
  const criteria = plan.aiPolicy?.attentionCriteria?.trim();
  const lines: string[] = [
    "你是内容选题工作台的语义初筛引擎。输入是同一采集批次的候选条目（i=编号，t=标题，s=来源）。依次完成：",
    "1. 归类：讲同一事件或同一主题的条目归为一组，单条也可自成一组；members 必须含组内全部编号，每个编号恰好属于一组。",
    "2. 注意力判级：每组给 attention 与一句话 reason。strong=AI/科技/创作者工具领域的强信号（重要发布、大版本、显著数据、研究策略方向上的大事件）；potential=有潜在价值、值得留观察池的次级信号；none=与 AI/科技/内容创作方向无关（纯体育赛事、时政要闻、社会民生、娱乐八卦）或无信息量的噪音。",
    `3. 双线草案：attention 非 none 的组给 angles（内容角度 0-3 条，platform 只能从 ${platforms.join("/")} 中选）；若该事件存在 web/app 配套工具缺口，给 appGap（一句话应用路线）；没有就不写该字段。`,
    `归类粒度：${granularityText(plan.aiPolicy ?? {})}。`,
    ATTENTION_FEW_SHOT,
    `研究策略方向（判级参照）：${plan.goal.slice(0, 160)}`,
    criteria ? `补充判级标准（优先级最高）：${criteria.slice(0, 400)}` : "",
    criteria ? "再次强调：判级以上述补充判级标准为准，与默认三档定义或示例冲突时，一律以补充标准为准。" : "",
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
  opts: { signal: AbortSignal; tier: "cheap" | "full"; maxOutputTokens: number; temperature: number },
) => Promise<{ text: string; usage?: number }>;
export function defaultTriageRunner(db: Store, messages: ModelMessage[], opts: { signal: AbortSignal; tier: "cheap" | "full"; maxOutputTokens: number; temperature: number }) {
  return import("./model").then((m) => m.requestModel(db, messages, { signal: opts.signal, json: true, plan: opts.tier, maxOutputTokens: opts.maxOutputTokens, temperature: opts.temperature }));
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
// 合并轮输入封顶（小拾审查 P3）：组数超上限时按成员数降序取前 N，其余组保持独立——
// 并组遗漏可接受，合并轮撞上下文报「截断 JSON」不可接受；gid 携带 drafts 原索引，applyMerges 无需感知。
export const MERGE_INPUT_CAP = 200;
export function mergeInputOf(drafts: GroupDraft[]) {
  const picked = new Set(
    drafts.map((d, i) => i).sort((a, b) => drafts[b].members.length - drafts[a].members.length).slice(0, MERGE_INPUT_CAP),
  );
  return drafts.map((d, i) => ({ d, i })).filter(({ i }) => picked.has(i)).map(({ d, i }) => ({
    gid: `g${i}`,
    title: d.title,
    attention: d.attention,
    memberCount: d.members.length,
    representative: d.members[0]?.title.slice(0, 60) || "",
    sources: [...new Set(d.members.map((m) => m.sourceName))].slice(0, 3),
  }));
}
// 片级可隔离失败（R9-7③ 实弹）：上游内容审查（候选标题被回显撞输出审查 → 400）与
// 片级超时/中止（同一片的病态内容在不同退化模式下 400 或挂死）——两者都是"这片数据有问题"，
// 应对相同：自动对半切分隔离坏候选（递归至最细粒度），最细仍失败的子片弃掉降级（成员走未标注兜底）。
// 预算不足/取消不在此列——那是批次级状态，必须向上抛。
function isShardIsolatable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /data_inspection_failed|inappropriate|百炼请求失败（HTTP 400）|aborted due to timeout|aborted|ECONNRESET/i.test(message)
    && !/预算不足/.test(message);
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
  // 采样收紧（小拾审查 P2）：分类+结构化输出用低温，压判级抖动的采样分量
  const temperature = 0.2;
  const shards = shardCandidates(candidates);
  const drafts: GroupDraft[] = [];
  let tokens = 0;
  let calls = 0;
  const runShard = async (shard: DiscoveryCandidate[], depth: number): Promise<GroupDraft[]> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await runner(db, triageShardMessages(plan, shard), { signal, tier, maxOutputTokens: 6000, temperature });
        tokens += res.usage ?? 0;
        calls++;
        return parseShardOutput(res.text, shard, plan);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    // 内容审查永不废批：能切则切（隔离坏标题），不能切则弃片降级（成员走未标注兜底）
    if (isShardIsolatable(lastError)) {
      if (shard.length >= 16 && depth < 2) {
        const mid = Math.ceil(shard.length / 2);
        console.warn(`[triage] ${shard.length} 条分片被上游内容审查拦截，对半切分隔离（深度 ${depth + 1}）`);
        const left = await runShard(shard.slice(0, mid), depth + 1);
        const right = await runShard(shard.slice(mid), depth + 1);
        return [...left, ...right];
      }
      console.warn(`[triage] 细分片 ${shard.length} 条仍被内容审查拦截，弃片降级（成员走未标注兜底）：${lastError instanceof Error ? lastError.message.slice(0, 120) : lastError}`);
      return [];
    }
    throw new AppError(`语义初筛分片失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  };
  for (const [si, shard] of shards.entries()) {
    try {
      drafts.push(...await runShard(shard, 0));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError(`语义初筛分片 ${si + 1}/${shards.length} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let merges = 0;
  if (drafts.length > 1 && shards.length > 1) {
    const lastErrorHolder: { e: unknown } = { e: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await runner(db, triageMergeMessages(mergeInputOf(drafts)), { signal, tier, maxOutputTokens: 3000, temperature });
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
export function applyTriageToCandidates(candidates: DiscoveryCandidate[], groups: TriageGroup[], limit: number, opts: { preserveUnclaimed?: boolean } = {}): string[] {
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
    // R10.26-4①：preserveUnclaimed（external 写口增量合并）——本次未被任何组认领且
    // 已有非 none 判级的候选保留原状（人工捞回/前批判级不被缩减重放清掉）；
    // 被组认领的仍按组值覆盖（显式变更语义）
    if (opts.preserveUnclaimed && !g && c.attention && c.attention !== "none") continue;
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
      const plan = plans.get(r.planName) ?? (r.planName === COLLECT_ALL_PLAN_NAME ? defaultTriagePlan() : undefined);
      return plan && triageEnabledOf(plan, db.get<any>("config", "aiPolicy"));
    })
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
}
// ---- 初筛结果统一写回（R9-7③）：内联与补跑共用同一函数，灭双路径分叉 ----
// 组落库 / 候选写回（判级+组归属+reason）/ 清失败标记三件事同生共死——
// 分叉的历史教训：内联路径漏落库（143237c 修复）导致组卡引擎读不到、补跑机制整批重跑。
export function applyTriageResult(db: Store, record: DiscoveryRecord, triage: TriageRecord) {
  db.put("candidate-groups", "tg-" + record.jobId, triage);
  applyTriageToCandidates(record.candidates, triage.groups, record.limit ?? 6);
  db.put("discovery", record.jobId, record);
  db.del("meta", "triage-fail:" + record.jobId);
}

// none 组归档（第2段价值分流）：判无注意力的组写归档队列（可查可恢复），
// 成员候选置 filtered（reason 注明归档）——「没有价值的需要归档」是老大的明示动作。
export function archiveNoneGroups(db: Store, jobId: string, triage: TriageRecord): { archived: number; candidates: number } {
  const noneGroups = triage.groups.filter((g) => g.attention === "none");
  if (!noneGroups.length) return { archived: 0, candidates: 0 };
  db.put("triage-archive", "ta-" + jobId, {
    jobId,
    day: triage.day,
    at: now(),
    groups: noneGroups.map((g) => ({ id: g.id, title: g.title, reason: g.reason, memberUrls: g.memberUrls, sources: g.sources })),
  });
  const archivedUrls = new Set(noneGroups.flatMap((g) => g.memberUrls));
  const record = db.get<DiscoveryRecord>("discovery", jobId);
  let touched = 0;
  if (record) {
    for (const c of record.candidates || []) {
      if (c.status === "filtered") continue;
      if (archivedUrls.has(c.url) && c.attention === "none") {
        c.status = "filtered";
        c.reason = `已归档（AI 判无注意力：组「${c.reason.includes("组「") ? c.reason.split("组「")[1]?.split("」")[0] ?? "" : ""}」）；可经 POST /triage/restore 恢复`;
        touched++;
      }
    }
    db.put("discovery", jobId, record);
  }
  return { archived: noneGroups.length, candidates: touched };
}

// 恢复归档（审查台/外部 Agent 用）：按批次（可限组）把归档成员放回 watch 池
export function restoreArchived(db: Store, jobId: string, groupId?: string): { restored: number } {
  const archive = db.get<any>("triage-archive", "ta-" + jobId);
  const record = db.get<DiscoveryRecord>("discovery", jobId);
  if (!archive || !record) return { restored: 0 };
  const groups = groupId ? archive.groups.filter((g: any) => g.id === groupId) : archive.groups;
  const urls = new Set<string>(groups.flatMap((g: any) => g.memberUrls || []));
  let restored = 0;
  for (const c of record.candidates || []) {
    if (urls.has(c.url) && c.status === "filtered" && c.reason?.includes("已归档")) {
      c.status = "watch";
      c.reason = "归档恢复（人工捞起）";
      restored++;
    }
  }
  db.put("discovery", jobId, record);
  // R10.2③：按组恢复不删整批归档——移除已恢复组，组空才删记录（其余组保持可恢复）
  if (restored) {
    const remaining = (archive.groups || []).filter((g: any) => !groups.includes(g));
    if (remaining.length) db.put("triage-archive", "ta-" + jobId, { ...archive, groups: remaining });
    else db.del("triage-archive", "ta-" + jobId);
  }
  return { restored };
}

const AUTO_RUNS_PER_DAY = 3;
export async function triageTick(db: Store, runner: TriageRunner = defaultTriageRunner): Promise<void> {
  // R10.19-1：external 模式下补跑 tick 也不跑（外部 Agent 负责全套语义处理）
  if ((db.get("config", "consumerMode") || "external") !== "builtin") return;
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
    // R10.2②：全量采集批补跑配额独立（不与计划批抢 3 次/日上限）且优先级最高——
    // 每日主产出批次缺初筛的代价大于任何一个计划批。
    const targets = db
      .list<DiscoveryRecord>("discovery")
      .filter((r) => triagePoolOf(r.candidates || []).length >= MIN_CANDIDATES && !triageRecordOf(db, r.jobId) && (r.mode ?? "analysis") === "analysis" && Date.parse(r.at || "") >= Date.now() - 36 * 3600000)
      .sort((a, b) => (b.jobId.startsWith("collectall-") ? 1 : 0) - (a.jobId.startsWith("collectall-") ? 1 : 0) || String(b.at || "").localeCompare(String(a.at || "")));
    const collectAllFirst = targets.find((r) => r.jobId.startsWith("collectall-"));
    const autoKey = collectAllFirst ? "triage-auto-collectall:" + day : "triage-auto:" + day;
    const auto = db.get<any>("meta", autoKey);
    if ((auto?.runs ?? 0) >= AUTO_RUNS_PER_DAY) return;
    target = collectAllFirst || targets[0];
    if (!target) return;
    db.put("meta", autoKey, { at: now(), runs: (auto?.runs ?? 0) + 1 });
  }
  if (!target) return;
  const plan = db.list<Plan>("plans").find((p) => p.name === target!.planName) ?? (target!.planName === COLLECT_ALL_PLAN_NAME ? (defaultTriagePlan() as unknown as Plan) : undefined);
  if (!plan) return;
  try {
    // tick 侧一次性 controller：补跑不随任何 HTTP 请求断连中止
    const record = await runTriage(db, plan, target.jobId, triagePoolOf(target.candidates), new AbortController().signal, runner);
    applyTriageResult(db, target, record);
    // R10.2 追加：补跑路径与内联路径同款归档（判 none 组进 triage-archive，不静默留池）
    const archived = archiveNoneGroups(db, target.jobId, record);
    // R10.7 P0-5：补跑路径同样自动转卡（不受 consumerMode 门控）
    const { generateOpportunities } = await import("./opportunity");
    generateOpportunities(db, { source: "auto" });
    console.log(`[triage] ${target.planName} 批 ${target.jobId.slice(0, 8)}：${record.groups.length} 组（强 ${record.groups.filter((g) => g.attention === "strong").length}/潜 ${record.groups.filter((g) => g.attention === "potential").length}）${archived.archived ? `，归档 ${archived.archived} 组（${archived.candidates} 条）` : ""}，${record.shards} 片 ${record.calls} 调用 ${record.tokens} tokens${explicit ? "（显式请求）" : ""}`);
  } catch (error) {
    markTriageFailed(db, target, error);
    console.error("[triage] 补跑失败:", error instanceof Error ? error.message : error);
  }
}
