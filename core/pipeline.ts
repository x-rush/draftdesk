import { Store, AppError, now } from "./store";
import { collect } from "./sources";
import { loadSkill } from "./skills";
import { structured } from "./model";
import { qualityIssues } from "./quality";
import { evidenceContext } from "./research-context";
import {
  batchSchema,
  clusterSchema,
  reviewSchema,
  type Evidence,
  type Job,
} from "./schema";
const skillFor = {
  editorial: "editorial-research",
  trends: "trend-research",
  opportunity: "opportunity-research",
  people: "people-research",
};
export async function runJob(
  db: Store,
  job: Job,
  deps: { collect?: typeof collect; structured?: typeof structured } = {},
) {
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    db.put("meta", "worker", { heartbeat: now(), pid: process.pid });
    const j = db.get<Job>("jobs", job.id);
    if (j?.cancelRequested) controller.abort();
    else db.patchJob(job.id, { leaseUntil: Date.now() + 300000 });
  }, 1000);
  const signal = controller.signal;
  const call = deps.structured || structured;
  try {
    const skillIds = [
      "evidence-curator",
      skillFor[job.plan.kind],
      "quality-editor",
    ];
    const skills = Object.fromEntries(
      skillIds.map((id) => [id, loadSkill(id)]),
    );
    db.patchJob(job.id, {
      skillVersions: Object.fromEntries(
        skillIds.map((id) => [
          id,
          skills[id].version + "@" + skills[id].digest,
        ]),
      ),
    });
    db.step(
      job.id,
      "采集证据",
      "running",
      job.external ? "使用外部已提交证据" : "按策略读取已启用来源",
    );
    let evidence: Evidence[];
    if (job.external)
      evidence = job.evidenceIds
        .map((id) => db.get<Evidence>("evidence", id))
        .filter((e): e is Evidence => !!e)
        .slice(0, job.plan.maxEvidence);
    else {
      const collected = await (deps.collect || collect)(
        db,
        job.plan,
        signal,
        (detail) => db.step(job.id, "采集证据", "running", detail),
      );
      evidence = collected.evidence;
      db.patchJob(job.id, { warnings: collected.warnings });
    }
    db.patchJob(job.id, { evidenceIds: evidence.map((e) => e.id) });
    if (!evidence.length)
      throw new AppError(
        "未找到符合策略的证据。检查来源、排除词、地域或时间窗口；未调用模型。",
      );
    signal.throwIfAborted();
    const material = evidenceContext(evidence);
    db.step(
      job.id,
      "证据整理",
      "running",
      `${evidence.length} 条线索；合并同事件，保留反证与材料缺口`,
    );
    const clusters = await call(
      db,
      job,
      skills["evidence-curator"].content,
      { plan: job.plan, profile: db.config().profile, asOf: now(), evidence: material },
      clusterSchema,
      signal,
    );
    const ids = new Set(evidence.map((e) => e.id));
    if (clusters.clusters.some((c) => c.evidenceIds.some((id) => !ids.has(id))) ||
        clusters.excluded.some((e) => !ids.has(e.evidenceId)))
      throw new AppError("证据整理引用了不存在的材料。");
    db.put("job-context", job.id, clusters);
    if (!clusters.clusters.length)
      throw new AppError(
        "本轮资料不满足研究方向；已保留筛除原因，未生成凑数选题。",
      );
    signal.throwIfAborted();
    db.step(
      job.id,
      "专项分析",
      "running",
      "使用版本化 Skill，生成具体读者收益、行动方案与引用",
    );
    const batch = await call(
      db,
      job,
      skills[skillFor[job.plan.kind]].content,
      {
        plan: job.plan,
        profile: db.config().profile,
        clusters,
        evidence: material,
        maxItems: job.plan.maxItems,
      },
      batchSchema,
      signal,
    );
    if (batch.items.length > job.plan.maxItems)
      throw new AppError("模型输出超过策略数量限制。");
    const allowed = {
      editorial: ["news", "topic"],
      trends: ["trend"],
      opportunity: ["idea"],
      people: ["person"],
    }[job.plan.kind];
    if (batch.items.some((a) => !allowed.includes(a.kind)))
      throw new AppError("模型输出类型与研究策略不符。");
    db.put("job-draft", job.id, batch);
    signal.throwIfAborted();
    db.step(
      job.id,
      "质量审核",
      "running",
      "独立审稿与确定性引用检查；不足项留在待审区",
    );
    const review = await call(
      db,
      job,
      skills["quality-editor"].content,
      { items: batch.items, evidence: material, plan: job.plan, profile: db.config().profile, clusters },
      reviewSchema,
      signal,
    );
    const indexes = review.reviews.map((r) => r.index);
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some((i) => i >= batch.items.length)
    )
      throw new AppError("审稿结果索引无效。");
    signal.throwIfAborted();
    db.transaction(() => {
      if (db.get<Job>("jobs", job.id)?.cancelRequested)
        throw new AppError("任务已取消");
      batch.items.forEach((a, index) => {
        const r = review.reviews.find((x) => x.index === index);
        const issues = [
          ...qualityIssues(a, evidence),
          ...(r?.issues || []),
          ...(!r
            ? ["缺少审稿结果"]
            : r.verdict !== "pass"
              ? ["审稿建议：" + r.verdict]
              : []),
        ];
        db.saveArtifact(
          a,
          job.id,
          issues.length ? "review" : "ready",
          issues,
          r?.note || "",
          skills[skillFor[job.plan.kind]].version,
        );
      });
    });
    db.step(
      job.id,
      "完成",
      "completed",
      `${batch.items.length} 条产物已进入工作台；全部默认私有`,
    );
    db.patchJob(job.id, { state: "completed", finishedAt: now() });
  } catch (e) {
    const cancelled =
      signal.aborted || db.get<Job>("jobs", job.id)?.cancelRequested;
    db.patchJob(job.id, {
      state: cancelled ? "cancelled" : "failed",
      finishedAt: now(),
      error: cancelled
        ? "任务已取消；已发生的模型与搜索调用可能计费。"
        : e instanceof AppError
          ? e.message
          : "研究执行失败。原始证据已保留，请检查配置或来源后手动重试。",
    });
  } finally {
    clearInterval(heartbeat);
  }
}
export function scheduleTick(db: Store, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`,
    time = `${get("hour")}:${get("minute")}`;
  for (const p of db.list<Job["plan"]>("plans"))
    if (p.scheduleEnabled && time >= p.dailyTime) {
      try {
        db.enqueue(p.id, [], `${p.id}:${day}`);
      } catch (e) {
        db.put("meta", "schedule-error", {
          at: now(),
          message: e instanceof AppError ? e.message : "定时入队失败",
        });
      }
    }
}
