import { Store, AppError, now } from "./store";
import { collect, searchWeb } from "./sources";
import { supplementQueries } from "./research-policy";
import { type ResearchEvent, type MetricSnapshot, metricComparison } from "./history";
import { loadSkill } from "./skills";
import { structured, requestModel } from "./model";
import { qualityIssues } from "./quality";
import { safeResearchError } from "./errors";
import { evidenceContext } from "./research-context";
import { collectionGaps, evidenceReadiness } from "./readiness";
import {
  batchSchema,
  researchBatchSchema,
  clusterSchema,
  researchClusterSchema,
  reviewSchema,
  type Evidence,
  type Job,
} from "./schema";
const skillFor = {
  activities: "activity-research",
  editorial: "editorial-research",
  trends: "trend-research",
  opportunity: "opportunity-research",
  people: "people-research",
};
export async function runJob(
  db: Store,
  job: Job,
  deps: { collect?: typeof collect; structured?: typeof structured; search?: typeof searchWeb } = {},
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
  let searches = 0;
  const countSearch = () => { searches++; db.patchJob(job.id, {searchCount: searches}); };
  const noFindings = (reason: string) => {
    db.step(job.id, "无推荐", "completed", reason);
    db.patchJob(job.id, {state:"completed", outcome:"no-findings", finishedAt:now()});
  };
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
    if(job.plan.kind === "activities" && !job.external) throw new AppError("活动研究只分析官方导入材料。请在创作活动页面导入规则后执行，不使用网络搜索。");
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
        countSearch,
        job.id,
      );
      evidence = collected.evidence;
      searches = Math.max(searches, collected.searches);
      db.patchJob(job.id, { warnings: collected.warnings });
    }
    db.patchJob(job.id, { evidenceIds: evidence.map((e) => e.id) });
    if (!evidence.length) {
      const warnings = db.get<Job>("jobs",job.id)?.warnings || [];
      if (warnings.length) throw new AppError("来源读取异常且没有有效证据，请检查来源诊断；未调用模型。");
      noFindings("未找到符合策略的证据；本轮没有推荐，未调用模型。"); return;
    }
    if (job.plan.kind === "trends" && job.plan.requireMetrics && !evidence.some(e=>e.metric)) {
      noFindings("本策略只研究原始指标，本轮未采集到符合关键词的指标。保留网页线索但不生成趋势结论，未调用模型；来源异常请查看来源问题。"); return;
    }
    const events = db.list<ResearchEvent>("events");
    const scope = (p: Job["plan"]) => JSON.stringify([p.id,p.kind,p.goal,p.audience,p.keywords,p.focusTerms,p.requireMetrics,p.excludeKeywords,p.includeDomains,p.sourceIds,p.lookbackDays]);
    const previousJobs = db.list<Job>("jobs").filter(j => j.id !== job.id && scope(j.plan) === scope(job.plan) && j.state === "completed");
    const covered = new Set(previousJobs.flatMap(j => j.evidenceIds));
    evidence = evidence.filter(e => !covered.has(e.id) && !events.some(event => event.evidenceIds.includes(e.id)
      && event.evidenceIds.some(id => covered.has(id)) && event.revisions.find(r => r.evidenceId === e.id)?.change === "duplicate"));
    if (!evidence.length) { noFindings("已有同类研究覆盖这些事件，本轮没有新增材料；未重复生成。"); return; }
    signal.throwIfAborted();
    let material = evidenceContext(evidence,job.plan.kind==="activities"?6000:12000);
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
      researchClusterSchema(evidence.map(e=>e.id)),
      signal,
    );
    const ids = new Set(evidence.map((e) => e.id));
    if (clusters.clusters.some((c) => c.evidenceIds.some((id) => !ids.has(id))) ||
        clusters.excluded.some((e) => !ids.has(e.evidenceId)))
      throw new AppError("证据整理引用了不存在的材料。");
    db.put("job-context", job.id, clusters);
    if (!clusters.clusters.length) { noFindings("资料不满足研究方向，筛除原因已保留；没有凑数推荐。"); return; }
    const canSearch = !job.external && job.plan.sourceIds.some(id => { const s = db.get<any>("sources",id); return s?.enabled && s.type === "web"; });
    const requiredGaps = collectionGaps(job.plan, evidence);
    const followups = supplementQueries([
      ...requiredGaps.map(gap=>({label: clusters.clusters[0].label, missing:[gap]})),
      ...clusters.clusters,
    ], job.plan.kind, 2);
    const verification: {question: string; evidenceIds: string[]; status: string}[] = [];
    for (const query of followups) {
      if (!canSearch || !db.config().tavilyKey || evidence.length >= job.plan.maxEvidence || searches >= job.plan.maxQueries) {
        verification.push({question:query.purpose,evidenceIds:[],status:"未补证：来源、密钥或证据预算不足"}); continue;
      }
      signal.throwIfAborted();
      countSearch();
      db.step(job.id,"定向补证","running",`${query.purpose}；搜索 ${searches}/${job.plan.maxQueries}`);
      try {
        const found = await (deps.search || searchWeb)(db,job.plan,query.query,signal);
        const added = found.slice(0,job.plan.maxEvidence-evidence.length).map(e => db.addEvidence(e,"targeted-verification/1.0"));
        evidence = [...new Map([...evidence,...added].map(e => [e.id,e])).values()];
        verification.push({question:query.purpose,evidenceIds:added.map(e=>e.id),status:added.length ? "检索到候选，尚需逐条核验，不代表已证实" : "未知：没有找到补充材料"});
      } catch (error) {
        if (signal.aborted) throw error;
        verification.push({question:query.purpose,evidenceIds:[],status:"未知：补证搜索失败"});
      }
    }
    db.put("job-verification",job.id,verification);
    db.patchJob(job.id,{evidenceIds:evidence.map(e=>e.id),searchCount:searches});
    material = evidenceContext(evidence,job.plan.kind==="activities"?6000:12000);
    const snapshots = db.list<MetricSnapshot>("metrics");
    const history = {events: events.filter(event => event.evidenceIds.some(id => evidence.some(e=>e.id===id))),
      metrics: snapshots.filter(m=>evidence.some(e=>e.id===m.evidenceId)).map(m=>({...m,comparison:metricComparison(snapshots,m)}))};
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
        asOf: now(),
        clusters,
        verification,
        history,
        materialGaps: collectionGaps(job.plan, evidence),
        evidence: material,
        maxItems: job.plan.maxItems,
      },
      researchBatchSchema(job.plan.kind, job.plan.maxItems, evidence.map((e) => e.id)),
      signal,
    );
    if (batch.items.length > job.plan.maxItems)
      throw new AppError("模型输出超过策略数量限制。");
    const allowed = {
      activities: ["activity"],
      editorial: ["news", "topic"],
      trends: ["trend"],
      opportunity: ["idea"],
      people: ["person"],
    }[job.plan.kind];
    if (batch.items.some((a) => !allowed.includes(a.kind)))
      throw new AppError("模型输出类型与研究策略不符。");
    for (const a of batch.items) {
      const unresolved = verification.filter(v=>!v.evidenceIds.length).map(v=>`未核实：${v.question}（${v.status}）`);
      a.unknowns = [...new Set([...unresolved,...a.unknowns])].slice(0,20);
    }
    db.put("job-draft", job.id, batch);
    if (!batch.items.length) { noFindings("专项分析没有得到值得推荐的产物；排除原因已保留。"); return; }
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
      { items: batch.items, evidence: material, plan: job.plan, profile: db.config().profile, clusters, verification, history,
        evidenceChecks: batch.items.map(item=>({title:item.title,checks:evidenceReadiness(item,evidence)})) },
      reviewSchema,
      signal,
      (db, messages, options) => requestModel(db, messages, { ...options, maxOutputTokens: 5000 }),
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
          ...(a.kind === "trend" && !history.metrics.some(m=>a.evidenceIds.includes(m.evidenceId) && m.comparison.percent !== null)
            ? ["历史指标不足或口径不可比；这是热词线索，不是已验证的增长趋势。"] : []),
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
    db.patchJob(job.id, { state: "completed", outcome:"produced", finishedAt: now() });
  } catch (e) {
    const cancelled =
      signal.aborted || db.get<Job>("jobs", job.id)?.cancelRequested;
    db.patchJob(job.id, {
      state: cancelled ? "cancelled" : "failed",
      finishedAt: now(),
      error: cancelled
        ? "任务已取消；已发生的模型与搜索调用可能计费。"
        : safeResearchError(e),
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
    if (p.kind !== "activities" && p.scheduleEnabled && time >= p.dailyTime) {
      if(p.scheduleActivatedAt){
        const enabled=fmt.formatToParts(new Date(p.scheduleActivatedAt));
        const part=(key:string)=>enabled.find(x=>x.type===key)!.value;
        const enabledDay=`${part("year")}-${part("month")}-${part("day")}`;
        if(enabledDay>day || enabledDay===day && `${part("hour")}:${part("minute")}`>p.dailyTime)continue;
      }
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
