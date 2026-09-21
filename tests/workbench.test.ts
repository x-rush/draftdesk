import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, hash } from "../core/store";
import {
  artifactSchema,
  intakeSchema,
  type Artifact,
  type Job,
} from "../core/schema";
import { qualityIssues } from "../core/quality";
import { runJob, scheduleTick } from "../core/pipeline";
import { structured, requestModel } from "../core/model";
import { parseFeed, publicIp, balancedEvidence } from "../core/sources";
import { checkRequest } from "../core/http";
import { defaultSources } from "../core/defaults";
import { evidence, topic, plan, envelope } from "./fixtures";
const fixture = async (fn: (db: Store, dir: string) => unknown) => {
  const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-test-")),
    db = new Store(dir);
  db.put("config", "main", {
    ...db.config(),
    apiKey: "test-key",
    baseUrl: "https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  });
  try {
    await fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};
test('候选证据按来源轮流选取，较长 RSS 不挤掉网页与用户证据',()=>{const many=Array.from({length:50},(_,i)=>({...evidence[0],url:`https://example.com/${i}`}));const chosen=balancedEvidence([many,[evidence[1]]],3);assert.equal(chosen.length,3);assert.equal(chosen[1].url,evidence[1].url);});
test("外部协议拒绝虚假状态、非法 URL 与缺失结构", () => {
  assert.throws(() => intakeSchema.parse({ ...envelope(), verified: true }));
  const bad = envelope();
  bad.evidence[0].url = "javascript:alert(1)";
  assert.throws(() => intakeSchema.parse(bad));
  assert.throws(() => artifactSchema.parse({ ...topic, summary: "一句话" }));
});
test("外部提交幂等且重试不重复写入，冲突拒绝", async () =>
  fixture((db) => {
    const r = db.intake(envelope(), "agent-one");
    assert.equal(r.status, "pending-review");
    assert.equal(db.intake(envelope(), "agent-one").duplicate, true);
    assert.equal(db.list("artifacts").length, 1);
    assert.throws(
      () =>
        db.intake(
          { ...envelope(), producer: { name: "other", version: "1" } },
          "agent-one",
        ),
      /内容不同/,
    );
    assert.equal(db.list<Artifact>("artifacts")[0].quality, "review");
  }));
test("收件引用必须来自同一批，事务失败不留半份数据", async () =>
  fixture((db) => {
    const bad = envelope();
    bad.drafts = [{ ...topic, evidenceIds: ["not-in-batch"] }];
    assert.throws(() => db.intake(bad, "agent"));
    assert.equal(db.list("evidence").length, 0);
    assert.equal(db.list("receipts").length, 0);
  }));
test("令牌存散列且可以撤销，不回显到工作区", async () =>
  fixture((db) => {
    const c = db.createConnection("Hermes");
    assert.equal(db.authenticate(c.token).id, c.id);
    assert.ok(!JSON.stringify(db.snapshot()).includes(c.token));
    const saved = db.get<any>("connections", c.id);
    assert.equal(saved.digest, hash(c.token));
    db.put("connections", c.id, { ...saved, revoked: true });
    assert.throws(() => db.authenticate(c.token));
  }));
test("同 URL 去掉追踪参数，原文或指标变化保留新证据", async () =>
  fixture((db) => {
    const { provenance, fingerprint, ...input } = evidence[0];
    const a = db.addEvidence(
      { ...input, url: "https://example.com/update?utm_source=x" },
      "a",
    );
    const b = db.addEvidence(input, "b");
    assert.equal(a.id, b.id);
    const c = db.addEvidence(
      { ...input, excerpt: input.excerpt + "新条件" },
      "b",
    );
    assert.notEqual(c.id, a.id);
  }));
test("预算事务拒绝超额且不增加调用次数", async () =>
  fixture(async (db) => {
    db.put("plans", plan.id, plan);
    const j = db.enqueue(plan.id)!;
    db.put("config", "main", { ...db.config(), dailyTokenLimit: 30000 });
    db.transaction(() => db.reserve(29000));
    await assert.rejects(
      () =>
        requestModel(db, [{ role: "user", content: "test" }], {
          jobId: j.id,
          signal: new AbortController().signal,
          fetch: (async () => {
            throw Error("不应调用");
          }) as typeof fetch,
        }),
      /预算不足/,
    );
    assert.equal(db.get<Job>("jobs", j.id)!.calls, 0);
    assert.equal(db.dayBudget().reserved, 29000);
  }));
test("任务领取互斥，过期租约标失败不重复执行", async () =>
  fixture((db, dir) => {
    db.put("plans", plan.id, plan);
    const first = db.enqueue(plan.id)!;
    const second = new Store(dir);
    try {
      assert.equal(db.claim()!.id, first.id);
      assert.equal(second.claim(), undefined);
      db.patchJob(first.id, { leaseUntil: Date.now() - 1 });
      assert.equal(second.claim(), undefined);
      assert.equal(db.get<Job>("jobs", first.id)!.state, "failed");
    } finally {
      second.close();
    }
  }));
test("北京每日策略幂等，失败不自动重复付费", async () =>
  fixture((db) => {
    db.put("plans", plan.id, {
      ...plan,
      scheduleEnabled: true,
      dailyTime: "01:00",
    });
    scheduleTick(db, new Date("2026-09-21T00:00:00Z"));
    scheduleTick(db, new Date("2026-09-21T01:00:00Z"));
    assert.equal(db.list("jobs").length, 1);
    const j = db.list<Job>("jobs")[0];
    db.patchJob(j.id, { state: "failed" });
    scheduleTick(db, new Date("2026-09-21T02:00:00Z"));
    assert.equal(db.list("jobs").length, 1);
  }));
test("引用原话、未知证据和单来源触发质量门槛", () => {
  assert.deepEqual(qualityIssues(topic, evidence), []);
  assert.ok(
    qualityIssues(
      { ...topic, claims: [{ ...topic.claims[0], quote: "不存在的原话" }] },
      evidence,
    ).some((s) => s.includes("原话")),
  );
  assert.ok(
    qualityIssues({ ...topic, evidenceIds: ["ev-one"] }, evidence).some((s) =>
      s.includes("一个来源"),
    ),
  );
});
test("热词没有指标不能通过为真实趋势", () => {
  const trend = artifactSchema.parse({
    ...topic,
    kind: "trend",
    details: {
      keyword: "会议 AI",
      region: "US",
      window: "一天",
      intent: "了解工具",
      signalEvidenceIds: ["ev-one"],
      comparison: "没有历史",
      opportunity: "研究需求",
      cautions: ["未验证"],
    },
  });
  assert.ok(qualityIssues(trend, evidence).some((s) => s.includes("指标")));
});
test("应用没有用户问题证据不能冒充已验证需求", () => {
  const idea = artifactSchema.parse({
    ...topic,
    kind: "idea",
    details: {
      job: "核对任务",
      trigger: "开会后",
      frequency: "未知",
      alternatives: ["手工"],
      differentiation: "核对而非摘要",
      mvp: ["导入", "核对"],
      nonGoals: ["大型协同"],
      willingnessToPay: "未知",
      experiment: "观察5人",
      successCriteria: "任务完成",
      stopCriteria: "没有复用",
    },
  });
  assert.ok(
    qualityIssues(idea, [evidence[0]]).some((s) => s.includes("用户问题")),
  );
});
test("完整研究管线按证据、分析、审稿顺序运行且默认私有", async () =>
  fixture(async (db) => {
    db.put("plans", plan.id, plan);
    evidence.forEach((e) => db.put("evidence", e.id, e));
    const j = db.enqueue(
      plan.id,
      evidence.map((e) => e.id),
    )!;
    db.claim();
    const calls: string[] = [];
    const fake = (async (_db: any, _job: any, skill: string) => {
      calls.push(skill);
      return calls.length === 1
        ? {
            clusters: [
              {
                label: "会议纪要",
                summary: "样例",
                evidenceIds: ["ev-one", "ev-two"],
                contradictions: [],
                missing: [],
              },
            ],
            excluded: [],
          }
        : calls.length === 2
          ? { items: [topic], rejected: [] }
          : {
              reviews: [
                {
                  index: 0,
                  verdict: "pass",
                  issues: [],
                  note: "事实与假设分开，含可执行方案。",
                },
              ],
            };
    }) as typeof structured;
    await runJob(db, j, { structured: fake });
    assert.equal(db.get<Job>("jobs", j.id)!.state, "completed");
    assert.equal(calls.length, 3);
    const a = db.list<Artifact>("artifacts")[0];
    assert.equal(a.quality, "ready");
    assert.equal(a.visibility, "private");
    assert.equal(
      Object.keys(db.get<Job>("jobs", j.id)!.skillVersions).length,
      3,
    );
  }));
test("空证据提前停止，未调用模型", async () =>
  fixture(async (db) => {
    db.put("plans", plan.id, plan);
    const j = db.enqueue(plan.id)!;
    await runJob(db, j, {
      collect: async () => ({
        evidence: [],
        warnings: ["来源失败"],
        searches: 0,
      }),
      structured: (async () => {
        throw Error("不得调用");
      }) as typeof structured,
    });
    assert.equal(db.get<Job>("jobs", j.id)!.state, "failed");
    assert.equal(db.get<Job>("jobs", j.id)!.calls, 0);
  }));
test("内容更新检测冲突，待审和应用不得公开", async () =>
  fixture((db) => {
    const a = db.saveArtifact(topic, "test", "review", []);
    assert.throws(() =>
      db.updateArtifact({ id: a.id, revision: 1, visibility: "public" }),
    );
    db.updateArtifact({ id: a.id, revision: 1, saved: true });
    assert.throws(
      () => db.updateArtifact({ id: a.id, revision: 1, saved: false }),
      /已更新/,
    );
  }));
test("RSS 拒绝外部实体并保留趋势指标原始口径", () => {
  assert.throws(() => parseFeed("<!DOCTYPE x><rss/>", defaultSources[0]));
  const result = parseFeed(
    "<rss><channel><item><title>test</title><link>https://example.com/x</link><ht:approx_traffic>20K+</ht:approx_traffic></item></channel></rss>",
    { ...defaultSources[2], region: "US" },
  );
  assert.equal(result[0].metric!.value, "20K+");
  assert.equal(result[0].region, "US");
  assert.equal(result[0].publishedAt, undefined);
});
test("网络边界拒绝内网、跨站和未知 Host", () => {
  [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.1.1",
    "224.0.0.1",
  ].forEach((ip) => assert.equal(publicIp(ip), false));
  assert.equal(publicIp("8.8.8.8"), true);
  assert.throws(() =>
    checkRequest(
      new Request("http://127.0.0.1:5173/api", {
        headers: { origin: "https://evil.example" },
      }),
    ),
  );
  assert.throws(() => checkRequest(new Request("http://evil.example/api")));
});
test("中文 SSE 分片忽略推理内容，缺少结束标志拒绝完整状态", async () =>
  fixture(async (db) => {
    const full =
      "data: " +
      JSON.stringify({
        choices: [
          { delta: { reasoning_content: "秘密推理", content: "中文回复" } },
        ],
      }) +
      "\n\ndata: [DONE]\n\n";
    const bytes = new TextEncoder().encode(full);
    let i = 0;
    let result = "";
    await requestModel(db, [{ role: "user", content: "hello" }], {
      signal: new AbortController().signal,
      onText: (t) => (result += t),
      fetch: (async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (i === bytes.length) c.close();
              else c.enqueue(bytes.slice(i, (i += 1)));
            },
          }),
        )) as typeof fetch,
    });
    assert.equal(result, "中文回复");
    await assert.rejects(
      () =>
        requestModel(db, [{ role: "user", content: "hello" }], {
          signal: new AbortController().signal,
          onText: () => {},
          fetch: (async () =>
            new Response(
              'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
            )) as typeof fetch,
        }),
      /不完整/,
    );
  }));
