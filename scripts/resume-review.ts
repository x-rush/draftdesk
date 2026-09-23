import { Store, AppError, now } from "../core/store";
import { researchBatchSchema, reviewSchema, type Job, type Evidence, type Artifact } from "../core/schema";
import { structured, requestModel } from "../core/model";
import { qualityIssues } from "../core/quality";
import { evidenceContext } from "../core/research-context";
import { loadSkill } from "../core/skills";
import { safeResearchError } from "../core/errors";

// Explicit recovery of a saved, now-valid output. No new search or generation.
// Uses the original task and daily budgets; refuses duplicates and unknown IDs.
const db = new Store();
const jobId = process.argv[2];
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  const job = db.get<Job>("jobs", jobId);
  if (!job || job.state !== "failed") throw new AppError("只允许补审已失败且保留有效输出的任务。");
  if (db.list<Artifact>("artifacts").some((a) => a.jobId === jobId)) throw new AppError("此任务已有产物，拒绝重复写入。");
  const saved = db.get<any>("job-validation", jobId);
  const raw = db.get<any>("job-draft", jobId) || JSON.parse((saved?.response || "null").replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  const batch = researchBatchSchema(job.plan.kind, job.plan.maxItems, job.evidenceIds).parse(raw);
  const evidence = job.evidenceIds.map((id) => db.get<Evidence>("evidence", id)).filter((e): e is Evidence => !!e);
  db.transaction(() => {
    if (db.get<Job>("jobs",jobId)?.state !== "failed") throw new AppError("任务状态已改变。");
    db.put("jobs", jobId, { ...job, state: "running", stage: "补审有效草稿", leaseUntil: Date.now() + 300000, error: undefined,
      steps: [...job.steps, {name:"补审有效草稿",state:"running",detail:"保留原始失败记录："+job.error,at:now()}] });
    db.put("job-draft", jobId, batch);
  });
  heartbeat = setInterval(() => db.patchJob(jobId, {leaseUntil:Date.now()+300000}), 10000);
  const skill = loadSkill("quality-editor");
  const review = await structured(db, job, skill.content,
    { items: batch.items, evidence: evidenceContext(evidence, 4000), profile: db.config().profile }, reviewSchema, new AbortController().signal,
    (db, messages, options) => requestModel(db, messages, {...options, maxOutputTokens: 5000}));
  if (new Set(review.reviews.map((r) => r.index)).size !== review.reviews.length || review.reviews.some((r) => r.index >= batch.items.length)) throw new AppError("审稿索引无效。");
  db.transaction(() => {
    batch.items.forEach((item, index) => {
      const r = review.reviews.find((v) => v.index === index);
      const issues = [...qualityIssues(item,evidence), ...(r?.issues || []), ...(r?.verdict === "pass" ? [] : ["审稿建议：" + (r?.verdict || "缺少审稿")])];
      db.saveArtifact(item,jobId,issues.length ? "review" : "ready",issues,r?.note || "",skill.version);
    });
    const latest = db.get<Job>("jobs",jobId)!;
    db.put("jobs",jobId,{...latest,state:"completed",stage:"完成",finishedAt:now(),
      steps:[...latest.steps,{name:"完成",state:"completed",detail:`${batch.items.length} 条有效草稿补审完成，保持私有`,at:now()}]});
  });
  console.log(JSON.stringify({jobId,state:"completed",artifacts:batch.items.length}));
} catch(error) {
  if(heartbeat) db.patchJob(jobId,{state:"failed",error:safeResearchError(error),finishedAt:now()});
  console.error(safeResearchError(error)); process.exitCode=1;
  if(error instanceof Error) console.error(error.name, error.stack?.split("\n").slice(1,3).join("\n"));
} finally { if(heartbeat) clearInterval(heartbeat); db.close(); }
