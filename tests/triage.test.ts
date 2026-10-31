// 语义初筛守护（R9-6）：分片打包、模型输出归一（覆盖兜底/枚举净化/平台过滤）、
// 片间合并、名额按组分配（strong→potential→none 永不占 selected）、tick 补跑与失败标注、
// 机会引擎组卡（双线卡+互挂 relatedIds+幂等）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, hash } from "../core/store";
import {
  shardCandidates, parseShardOutput, applyMerges, applyTriageToCandidates, runTriage,
  triageTick, requestTriage, triageEnabledOf, groupIdOf, triagePoolOf, MIN_CANDIDATES,
  triageShardMessages, mergeInputOf, MERGE_INPUT_CAP,
  type Attention, type TriageGroup, type TriageRecord, type TriageRunner,
} from "../core/triage";
import { groupOpportunityDrafts } from "../core/opportunity";
import { planSchema } from "../core/schema";
import type { DiscoveryCandidate, DiscoveryRecord } from "../core/discovery";

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

const PLAN = {
  id: "trend-radar", name: "热词与内容机会", kind: "trends" as const, goal: "追踪 AI 领域热点与 web/app 工具机会",
  audience: "AI 从业者", keywords: [], excludeKeywords: [], includeDomains: [], sourceIds: ["s1"],
  lookbackDays: 7, maxEvidence: 10, maxQueries: 4, maxItems: 4, maxModelCalls: 8, maxTokens: 400000,
  scheduleEnabled: false, dailyTime: "01:15", publishPolicy: "manual" as const,
  platformAffinity: ["gzh", "tiebuhao", "xhs-note", "threads"] as ("gzh" | "tiebuhao" | "xhs-note" | "threads")[],
};

function cand(i: number, sourceId = "s1", status: DiscoveryCandidate["status"] = "watch"): DiscoveryCandidate {
  return { url: `https://example.com/${sourceId}/${i}`, title: `候选标题${i}`, sourceId, sourceName: sourceId.toUpperCase(), status, reason: "符合策略", observedAt: new Date().toISOString(), rank: i + 1 };
}
function group(id: string, attention: Attention, memberUrls: string[], extra: Partial<TriageGroup> = {}): TriageGroup {
  return {
    id, title: "组" + id, attention, reason: "判级理由", memberUrls,
    representativeUrl: memberUrls[0], sources: ["S1"], angles: [], ...extra,
  };
}
function runnerOf(responses: { shard?: string[]; merge?: string[]; fail?: boolean }): { runner: TriageRunner; calls: () => number; temps: number[] } {
  let calls = 0;
  const temps: number[] = [];
  return {
    calls: () => calls,
    temps,
    runner: async (_db, messages, opts) => {
      calls++;
      temps.push(opts.temperature);
      if (responses.fail) throw new Error("模型连接失败");
      opts.signal.throwIfAborted();
      const system = messages[0].content;
      if (system.includes("分片初步归组")) {
        const next = responses.merge?.shift();
        if (next === undefined) throw new Error("意外的合并调用");
        return { text: next, usage: 100 };
      }
      const next = responses.shard?.shift();
      if (next === undefined) throw new Error("意外的分片调用");
      return { text: next, usage: 200 };
    },
  };
}

// ---- 提示词工程（小拾审查 P1/P2/P4 落地守护）----
test("分片 prompt：判级 few-shot 示例在位；criteria 双位置强调；无 criteria 不出现强调行", () => {
  const shard = [cand(0)];
  const base = triageShardMessages(PLAN, shard)[0].content;
  assert.ok(base.includes("判级示例"), "few-shot 示例块在位");
  assert.ok(base.includes("蹭 AI 词的娱乐向"), "none 边界示例（看起来像 AI 但判 none）");
  assert.ok(base.includes("标题平淡但领域强信号"), "strong 边界示例（标题平淡但 strong）");
  assert.ok(!base.includes("补充判级标准"), "无 criteria 时无补充标准块");
  const withCriteria = triageShardMessages({ ...PLAN, aiPolicy: { attentionCriteria: "出海工具优先" } }, shard)[0].content;
  assert.equal(withCriteria.split("出海工具优先").length - 1 >= 1, true, "criteria 本体注入");
  assert.ok(withCriteria.includes("与默认三档定义或示例冲突时，一律以补充标准为准"), "P4：输出契约行前重复强调");
  assert.ok(withCriteria.indexOf("补充判级标准（优先级最高）") < withCriteria.indexOf("再次强调：判级以上述补充判级标准为准"), "强调行在标准块之后");
});

// ---- 分片打包 ----
test("分片：连续填充（同源天然同片）、每片 ≤60、池护栏 2000（R10.30-A）", () => {
  const big = Array.from({ length: 70 }, (_, i) => cand(i, "a"));
  const big2 = Array.from({ length: 70 }, (_, i) => cand(i, "b"));
  const small = Array.from({ length: 30 }, (_, i) => cand(i, "c"));
  const shards = shardCandidates([...big, ...big2, ...small]);
  assert.deepEqual(shards.map((s) => s.length), [60, 60, 50], "170 条 → 3 片");
  assert.ok(shards[0].every((c) => c.sourceId === "a"), "第一片整片源 a");
  assert.equal(shards[1][0].sourceId, "a", "a 的尾部在第二片开头");
  // R10.30-A：池护栏 2000（初筛成本护栏，非数据截断）——1560 条全量进池；2001+ 截 2000
  const flood: DiscoveryCandidate[] = [];
  for (let s = 0; s < 26; s++) for (let i = 0; i < 60; i++) flood.push(cand(i, `src${s}`));
  assert.equal(flood.length, 1560);
  assert.equal(triagePoolOf(flood).length, 1560, "1560 条全量进池（<2000 护栏）");
  assert.equal(shardCandidates(triagePoolOf(flood)).length, 26, "1560 条→26 片（每片 ≤60 连续填充）");
});

// ---- 模型输出归一 ----
test("解析：非法判级净化为 none、越界编号丢弃、漏标编号兜底成组、平台不在 affinity 过滤", () => {
  const shard = [cand(0), cand(1), cand(2), cand(3)];
  const plan = { ...PLAN, platformAffinity: ["gzh", "tiebuhao"] as ("gzh" | "tiebuhao")[] };
  const drafts = parseShardOutput(JSON.stringify({
    groups: [
      { members: [0, 1], title: "同一事件", attention: "strong", reason: "大发布", angles: [{ platform: "gzh", angle: "深度解读" }, { platform: "threads", angle: "不在 affinity" }] },
      { members: [2, 99], title: "越界成员", attention: "潜力", reason: "非法枚举值" },
    ],
  }), shard, plan);
  assert.equal(drafts.length, 3, "组1 + 组2 + 漏标的 3 号兜底");
  assert.equal(drafts[0].attention, "strong");
  assert.deepEqual(drafts[0].angles.map((a) => a.platform), ["gzh"], "threads 不在 affinity 被滤");
  assert.equal(drafts[1].attention, "none", "非法判级净化为 none");
  assert.deepEqual(drafts[1].members.map((m) => m.url), [shard[2].url], "越界编号丢弃");
  assert.equal(drafts[2].attention, "none", "漏标编号兜底为无注意力");
});

test("解析抢救：畸形组丢弃（缺 members/title/attention）由兜底接住；全部无效抛错", () => {
  const shard = [cand(0), cand(1), cand(2), cand(3)];
  const plan = { ...PLAN };
  // 畸形组（members/title/attention 缺失）混在合法组里：合法组照收，畸形组丢弃
  const drafts = parseShardOutput(JSON.stringify({
    groups: [
      { members: [0], title: "合法组", attention: "strong", reason: "ok" },
      { members: [1] },
      { title: "没有成员", attention: "potential" },
      { members: [2], title: "没有判级" },
      { id: 3, summary: "完全另一种键名" },
    ],
  }), shard, plan);
  assert.equal(drafts.filter((d) => d.title === "合法组").length, 1, "合法组保留");
  assert.equal(drafts.some((d) => d.title === "没有成员" || d.title === "没有判级"), false, "畸形组被丢弃");
  assert.ok(drafts.every((d) => d.members.every((m) => m.url !== shard[3].url) || d.title.includes(shard[3].title.slice(0, 6))), "被丢弃组的成员走未标注兜底");
  // 全部无效 → 抛错（触发上层第二次尝试）
  assert.throws(() => parseShardOutput(JSON.stringify({ groups: [{ members: [0] }, { title: "x", attention: "strong" }] }), shard, plan), /没有.*有效组|无效/);
});

// ---- 片间合并 ----
test("合并：跨片同事件并组、成员并集、判级取强、非法引用跳过", () => {
  const a = { title: "事件A", attention: "potential" as Attention, reason: "次级", members: [cand(0), cand(1)], angles: [], };
  const b = { title: "事件A（另一源）", attention: "strong" as Attention, reason: "强信号", members: [cand(2)], angles: [], };
  const c = { title: "事件B", attention: "none" as Attention, reason: "无关", members: [cand(3)], angles: [], };
  const { groups, merges } = applyMerges([a, b, c], JSON.stringify({
    merges: [
      { keep: "g1", drop: ["g0"], attention: "strong", title: "事件A" },
      { keep: "gX", drop: ["g2"] }, // keep 不存在 → 跳过
    ],
  }));
  assert.equal(merges, 1);
  assert.equal(groups.length, 2);
  const merged = groups.find((g) => g.title === "事件A")!;
  assert.deepEqual(merged.members.map((m) => m.url).sort(), ["https://example.com/s1/0", "https://example.com/s1/1", "https://example.com/s1/2"]);
  assert.equal(merged.attention, "strong", "显式覆盖判级");
  assert.ok(groups.some((g) => g.title === "事件B"), "未合并组保留");
});

// ---- 名额分配 ----
test("分配：strong 优先占满 → potential → none 永不占 selected；已占名额的无注意力候选降级留池", () => {
  const candidates = [
    { ...cand(0), status: "selected" as const, reason: "已进入本轮 AI 分析" }, // 先到先得的旧 selected，属 none 组
    cand(1), cand(2), cand(3), cand(4), cand(5, "s2"),
  ];
  candidates[5].status = "filtered"; // 规则筛除的不动
  const groups = [
    group("g-pot", "potential", [candidates[3].url, candidates[4].url]),
    group("g-strong", "strong", [candidates[1].url, candidates[2].url]),
    group("g-none", "none", [candidates[0].url]),
  ];
  const winners = applyTriageToCandidates(candidates, groups, 3);
  assert.deepEqual(winners.slice().sort(), [candidates[1].url, candidates[2].url, candidates[3].url].sort(), "strong 2 席 + potential 1 席");
  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  for (const u of [candidates[1].url, candidates[2].url]) {
    assert.equal(byUrl.get(u)!.status, "selected");
    assert.match(byUrl.get(u)!.reason, /组「组g-strong」/);
    assert.equal(byUrl.get(u)!.groupId, "g-strong");
    assert.equal(byUrl.get(u)!.attention, "strong");
  }
  assert.equal(byUrl.get(candidates[3].url)!.status, "selected", "potential 补位");
  assert.equal(byUrl.get(candidates[4].url)!.reason.includes("名额已满"), true, "组满留池");
  assert.equal(byUrl.get(candidates[0].url)!.status, "watch", "无注意力候选被降级出 selected");
  assert.match(byUrl.get(candidates[0].url)!.reason, /注意力 无/);
  assert.equal(byUrl.get(candidates[5].url)!.status, "filtered", "筛除候选不被改写");
  assert.equal(candidates.every((c) => c.attention === undefined || c.attention), true);
});

// ---- 合并轮输入封顶（小拾审查 P3）----
test("mergeInputOf：组数超 200 按成员数降序取前 200，gid 保留 drafts 原索引且 applyMerges 可解析", () => {
  const drafts = Array.from({ length: 250 }, (_, i) => ({
    title: "组" + i,
    attention: "potential" as Attention,
    reason: "",
    members: [cand(i), ...(i % 50 === 0 ? [cand(1000 + i), cand(2000 + i), cand(3000 + i)] : [])],
    angles: [],
  }));
  const compact = mergeInputOf(drafts);
  assert.equal(compact.length, MERGE_INPUT_CAP, "封顶 200");
  const picked = new Set(compact.map((c) => Number(c.gid.slice(1))));
  // 成员数 5 的组（i%50==0，共 5 个）必须全部入选；成员数 1 的尾部组被挤出
  for (let i = 0; i < 250; i += 50) assert.ok(picked.has(i), `大组 g${i} 入选`);
  assert.ok([246, 247, 248, 249].every((i) => !picked.has(i)), "单成员尾部组被挤出");
  // gid 与原索引对齐 → applyMerges 按原索引仍可归并
  const { groups, merges } = applyMerges(drafts, JSON.stringify({ merges: [{ keep: "g0", drop: ["g50"], title: "大组合并" }] }));
  assert.equal(merges, 1);
  const merged = groups.find((g) => g.title === "大组合并")!;
  assert.equal(merged.members.length, 4 + 4, "两组成员并集（各 1+3）");
});

// ---- runTriage 端到端（mock runner）----
test("runTriage：两片判级 + 片间合并 + 组 id 确定性；候选不足拒绝", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-triage-run-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const candidates = [...Array.from({ length: 70 }, (_, i) => cand(i, "a")), ...Array.from({ length: 10 }, (_, i) => cand(i, "b"))];
    // 分片1覆盖全部 60 个编号（甲组 + 其余单大组），不留兜底单条 → 片2 的组恰为 drafts g2
    const shard1 = JSON.stringify({
      groups: [
        { members: [0, 1], title: "同事件甲", attention: "strong", reason: "发布", angles: [{ platform: "gzh", angle: "深度" }], appGap: "对比工具" },
        { members: Array.from({ length: 58 }, (_, k) => k + 2), title: "其余线索", attention: "none", reason: "无注意力" },
      ],
    });
    const shard2 = JSON.stringify({ groups: [{ members: [0], title: "同事件甲（B源）", attention: "strong", reason: "发布" }] });
    const merge = JSON.stringify({ merges: [{ keep: "g0", drop: ["g2"], title: "同事件甲" }] });
    const { runner, calls, temps } = runnerOf({ shard: [shard1, shard2], merge: [merge] });
    const record = await runTriage(db!, PLAN, "job-x", candidates, new AbortController().signal, runner);
    assert.ok(temps.length && temps.every((t) => t === 0.2), "P2：分类任务低温采样 temperature=0.2");
    assert.equal(calls(), 3, "2 分片 + 1 合并");
    assert.equal(record.shards, 2);
    assert.equal(record.calls, 3);
    assert.equal(record.tokens, 500, "2×200（分片）+1×100（合并）");
    assert.equal(record.merges, 1);
    const main = record.groups.find((g) => g.title === "同事件甲")!;
    assert.ok(main, "合并后的主组存在");
    assert.deepEqual(main.memberUrls.slice().sort(), [candidates[0].url, candidates[1].url, candidates[60].url].sort(), "跨片成员并集（第二片首条 a/60）");
    assert.equal(main.attention, "strong");
    assert.deepEqual(main.angles, [{ platform: "gzh", angle: "深度" }]);
    assert.equal(main.appGap, "对比工具");
    assert.equal(main.id, groupIdOf("job-x", main.memberUrls), "组 id 确定性");
    // 重跑同输入 → 同组 id（幂等）
    const { runner: runner2 } = runnerOf({ shard: [shard1, shard2], merge: [merge] });
    const again = await runTriage(db!, PLAN, "job-x", candidates, new AbortController().signal, runner2);
    assert.deepEqual(again.groups.map((g) => g.id).sort(), record.groups.map((g) => g.id).sort(), "组 id 幂等");
    // 候选不足
    await assert.rejects(() => runTriage(db!, PLAN, "job-y", candidates.slice(0, 3), new AbortController().signal, runnerOf({}).runner), /不足/);
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- triageTick：显式请求、失败标注、补跑、off 闸 ----
function setupTickDb(dir: string) {
  const db = new Store(dir);
  db.put("config", "consumerMode", "builtin"); // R10.19：tick 测试需 builtin 模式
  db.put("plans", PLAN.id, PLAN);
  const candidates = Array.from({ length: 12 }, (_, i) => cand(i, "s1"));
  const record: DiscoveryRecord = { jobId: "job-t1", at: new Date().toISOString(), planName: PLAN.name, candidates, sources: [{ sourceId: "s1", sourceName: "S1", status: "ok", raw: 12, matched: 12, selected: 0 }],  mode: "analysis" };
  db.put("discovery", record.jobId, record);
  db.put("config", "aiPolicy", { triage: "cheap", outline: "off", draft: "off", aiWriter: "external" });
  return { db, record };
}
const SHARD_OK = JSON.stringify({ groups: [{ members: [0, 1, 2], title: "强事件", attention: "strong", reason: "大发布", angles: [{ platform: "tiebuhao", angle: "一图速览" }], appGap: "监控面板" }, ...Array.from({ length: 3 }, (_, k) => ({ members: [3 + k], title: "单条" + k, attention: "potential", reason: "次级" }))] });

// ---- 内容审查切分隔离（R9-7③ 实弹根因：data_inspection_failed 整片 400）----
test("runTriage：审查拦截片自动对半切分隔离，最细粒度仍拦则弃片降级（成员走未标注兜底）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-triage-blocked-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    // 64 条 → 2 片（60+4）；第一片被审查拦（两次尝试都 400），递归 60→30+30→15 放行；第二片直接放行
    const candidates = [...Array.from({ length: 60 }, (_, i) => cand(i, "a")), ...Array.from({ length: 4 }, (_, i) => cand(i, "b"))];
    const blocked = "百炼请求失败（HTTP 400）；data_inspection_failed";
    let calls = 0;
    const runner: TriageRunner = async (_db, messages, opts) => {
      calls++;
      opts.signal.throwIfAborted();
      const items = JSON.parse(messages[1].content as string);
      // 第一片（完整 60 与左半 30）拦截；15 条及以下放行；第二片（b 源 4 条）放行
      if (items.length >= 30 && items[0].t === "候选标题0") throw new Error(blocked);
      return { text: JSON.stringify({ groups: [{ members: items.map((x: any) => x.i), title: "组" + items.length, attention: "potential", reason: "ok" }] }), usage: 10 };
    };
    const record = await runTriage(db!, PLAN, "job-b", candidates, new AbortController().signal, runner);
    assert.ok(calls >= 8, `切分发生了多次调用（实际 ${calls}）`);
    assert.equal(record.shards, 2);
    assert.equal(record.groups.length, 4, "切分后的四段子批各自成组");
    // 最细粒度（<16 条）仍拦：整批候选全部走未标注兜底单条
    let calls2 = 0;
    const alwaysBlocked: TriageRunner = async (_db, _m, opts) => {
      calls2++;
      opts.signal.throwIfAborted();
      throw new Error(blocked);
    };
    const record2 = await runTriage(db!, PLAN, "job-b2", candidates, new AbortController().signal, alwaysBlocked);
    assert.equal(record2.groups.length, 0, "全片被拦全弃片：无组产出");
    assert.ok(calls2 >= 14, `细粒度穷尽后弃片（实际调用 ${calls2}）`);
    // 弃片候选在名额分配层兜底：未分组 → attention none → 留池，永不占 selected
    const winners = applyTriageToCandidates(candidates, record2.groups, 6);
    assert.equal(winners.length, 0, "弃片批零入选");
    assert.ok(candidates.every((c) => c.attention === "none" && c.status === "watch"), "弃片候选全部留池待人工捞起");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("tick：显式请求消费（jobId 定向）；成功后组落库+名额重分配；失败标注待语义初筛且可补跑", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-triage-tick-"));
  let db: Store | undefined;
  try {
    ({ db } = setupTickDb(dir));
    // 失败：runner 抛错 → 候选标注 待语义初筛 + meta fail
    requestTriage(db!, "job-t1");
    const bad = runnerOf({ fail: true });
    await triageTick(db!, bad.runner);
    const failed = db!.get<DiscoveryRecord>("discovery", "job-t1")!;
    assert.equal(db!.get<any>("meta", "triage-request"), undefined, "请求消费后清除");
    assert.ok(db!.get<any>("meta", "triage-fail:job-t1"), "失败标记");
    assert.ok(failed.candidates.some((c) => c.reason.includes("待语义初筛")), "候选标注待语义初筛");
    assert.equal(db!.get<any>("candidate-groups", "tg-job-t1"), undefined);
    // 补跑成功：auto 路径（无显式请求，aiPolicy.triage=cheap）
    const good = runnerOf({ shard: [SHARD_OK, SHARD_OK] }); // 多余的第二份不会被消费
    await triageTick(db!, good.runner);
    const triageRecord = db!.get<TriageRecord>("candidate-groups", "tg-job-t1");
    assert.ok(triageRecord, "归组记录落库");
    assert.ok(!db!.get<any>("meta", "triage-fail:job-t1"), "成功后清失败标记");
    const updated = db!.get<DiscoveryRecord>("discovery", "job-t1")!;
    assert.equal(updated.candidates.filter((c) => c.status === "selected").length, 6, "limit=6 名额重分配");
    const strong = updated.candidates.filter((c) => c.groupId && c.attention === "strong");
    assert.ok(strong.length >= 3, "强注意力组入选");
    assert.ok(strong.every((c) => c.reason.includes("强事件")), "reason 带组名");
    assert.ok(updated.candidates.every((c) => !c.reason.includes("待语义初筛")), "补跑成功覆盖失败标注");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

test("tick：aiPolicy.triage=off 不自动补跑；auto 日上限 3 次", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-triage-off-"));
  let db: Store | undefined;
  try {
    ({ db } = setupTickDb(dir));
    db!.put("config", "aiPolicy", { triage: "off", outline: "off", draft: "off", aiWriter: "external" });
    await triageTick(db!, runnerOf({ shard: [SHARD_OK] }).runner);
    assert.equal(db!.get<any>("candidate-groups", "tg-job-t1"), undefined, "off 不补跑");
    // 显式请求仍可跑（off 只关自动）
    requestTriage(db!, "job-t1");
    await triageTick(db!, runnerOf({ shard: [SHARD_OK] }).runner);
    assert.ok(db!.get<any>("candidate-groups", "tg-job-t1"), "显式请求绕过 off");
    // auto 日上限
    db!.put("config", "aiPolicy", { triage: "cheap", outline: "off", draft: "off", aiWriter: "external" });
    db!.del("candidate-groups", "tg-job-t1");
    db!.put("meta", "triage-auto:" + new Date().toISOString().slice(0, 10), { runs: 3 });
    await triageTick(db!, runnerOf({ shard: [SHARD_OK] }).runner);
    assert.equal(db!.get<any>("candidate-groups", "tg-job-t1"), undefined, "日上限内不再自动跑");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- 机会引擎组卡（R9-6⑤⑥）----
test("generateFromGroups：R10.26 口径只出 appGap 应用卡（无内容线/无互挂）、幂等、none 与老批次不出", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-triage-opp-"));
  let db: Store | undefined;
  try {
    db = new Store(dir);
    const groups: TriageGroup[] = [
      group("grp-aaa", "strong", ["https://a/1", "https://b/1"], {
        title: "大模型发布", reason: "重要发布", representativeUrl: "https://a/1", sources: ["百度", "微博"],
        angles: [{ platform: "gzh", angle: "深度解读" }, { platform: "tiebuhao", angle: "一图看懂" }], appGap: "做一个模型对比工具",
      }),
      group("grp-bbb", "none", ["https://c/1"], { title: "体育赛事", reason: "体育无关", representativeUrl: "https://c/1", sources: ["抖音"] }),
    ];
    const record: TriageRecord = { jobId: "j1", planName: "热词与内容机会", day: "2026-10-16", at: new Date().toISOString(), groups, shards: 2, calls: 3, tokens: 600, merges: 0 };
    db.put("candidate-groups", "tg-j1", record);
    const old: TriageRecord = { ...record, jobId: "j0", at: new Date(Date.now() - 5 * 86400000).toISOString(), groups: [group("grp-old", "strong", ["https://old/1"], { angles: [{ platform: "gzh", angle: "老角度" }] })] };
    db.put("candidate-groups", "tg-j0", old);
    // R10.40：补跑路径自动转卡已下线——组草案仅经 groupOpportunityDrafts 机械转换
    assert.equal(db!.list<any>("opportunities").length, 0, "补跑零自动转卡");
    const rec = db!.get<any>("candidate-groups", "tg-j1");
    const grpA = rec.groups.find((g: any) => g.id === "grp-aaa")!;
    const drafts = groupOpportunityDrafts(grpA);
    assert.equal(drafts.length, 1, "appGap 组出 1 条应用草案（内容线走大纲链路）");
    assert.equal(drafts[0].dedupeKey, "app:grp:grp-aaa");
    assert.equal(drafts[0].form, "web-app", "R10 六值");
    assert.ok(drafts[0].verifyPlan[0].includes("对比工具"), "appGap 进验证计划首条");
    assert.equal(drafts[0].url, "https://a/1", "代表条目 url");
  } finally {
    db?.close();
    cleanup(dir);
  }
});

// ---- 开关与 schema ----
test("triageEnabledOf：R10 默认全开（全 kind）、计划可显式退出；全局 off 一票否决", () => {
  const global = { triage: "cheap" };
  assert.equal(triageEnabledOf({ kind: "trends" }, global), true);
  assert.equal(triageEnabledOf({ kind: "editorial" }, global), true, "R10：非 trends 默认也开");
  assert.equal(triageEnabledOf({ kind: "editorial", aiPolicy: { enabled: true } }, global), true);
  assert.equal(triageEnabledOf({ kind: "trends", aiPolicy: { enabled: false } }, global), false);
  assert.equal(triageEnabledOf({ kind: "trends" }, { triage: "off" }), false);
  assert.equal(triageEnabledOf({ kind: "trends" }, null), false, "未配置全局=off");
});

test("planSchema 接受 aiPolicy 块（R9-6②），拒绝非法粒度", () => {
  const parsed = planSchema.parse({ ...PLAN, aiPolicy: { enabled: true, attentionCriteria: "出海工具优先", groupGranularity: "fine" } });
  assert.equal(parsed.aiPolicy?.groupGranularity, "fine");
  assert.throws(() => planSchema.parse({ ...PLAN, aiPolicy: { groupGranularity: "medium" } }));
});

test("triagePoolOf：filtered 不进初筛池（省 token 且口径与名额一致）", () => {
  const pool = triagePoolOf([cand(0), { ...cand(1), status: "filtered" }, cand(2)]);
  assert.equal(pool.length, 2);
  assert.equal(pool.length >= MIN_CANDIDATES, false);
});
